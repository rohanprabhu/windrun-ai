import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { readCliArguments, smokeTest } from './smoke-test.mjs'

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address()
    assert.notEqual(address, null)
    assert.equal(typeof address, 'object')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function healthResponse(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function responseAtUrl(response, url) {
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: String(url),
  })
  return response
}

function options(overrides = {}) {
  return {
    attempts: 3,
    delayMs: 0,
    fetchImpl: fetch,
    sleep: async () => {},
    requestTimeoutMs: 100,
    overallTimeoutMs: 1_000,
    maxBodyBytes: 64 * 1024,
    ...overrides,
  }
}

async function settleWithin(promise, milliseconds = 250) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: 'pending' }), milliseconds),
    ),
  ])
}

test('returns 200 when health succeeds immediately', async () => {
  await withServer(
    (_request, response) => healthResponse(response, 200, { ok: true }),
    async (url) => {
      assert.equal(await smokeTest(url, options()), 200)
    },
  )
})

test('retries two 503 responses and then succeeds', async () => {
  let requests = 0
  let sleeps = 0

  await withServer(
    (_request, response) => {
      requests += 1
      if (requests < 3) {
        healthResponse(response, 503, { ok: false, detail: 'warming' })
        return
      }
      healthResponse(response, 200, { ok: true })
    },
    async (url) => {
      assert.equal(
        await smokeTest(
          url,
          options({
            sleep: async () => {
              sleeps += 1
            },
          }),
        ),
        200,
      )
    },
  )

  assert.equal(requests, 3)
  assert.equal(sleeps, 2)
})

test('rejects invalid JSON without retrying or exposing the body', async () => {
  let requests = 0
  const responseBody = 'not-json-sensitive-body'

  await withServer(
    (_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(responseBody)
    },
    async (url) => {
      await assert.rejects(smokeTest(url, options()), (error) => {
        assert.match(error.message, /invalid json/i)
        assert.match(error.message, /status 200/i)
        assert.equal(error.message.includes(responseBody), false)
        return true
      })
    },
  )

  assert.equal(requests, 1)
})

test('rejects a 200 response whose health payload is not ok', async () => {
  let requests = 0
  const responseBody = { ok: false, detail: 'do-not-print-this' }

  await withServer(
    (_request, response) => {
      requests += 1
      healthResponse(response, 200, responseBody)
    },
    async (url) => {
      await assert.rejects(smokeTest(url, options()), (error) => {
        assert.match(error.message, /ok === true/i)
        assert.match(error.message, /status 200/i)
        assert.equal(error.message.includes(responseBody.detail), false)
        return true
      })
    },
  )

  assert.equal(requests, 1)
})

test('reports only the final status after retry exhaustion', async () => {
  let requests = 0
  let sleeps = 0
  const responseBody = { ok: false, detail: 'private-upstream-detail' }

  await withServer(
    (_request, response) => {
      requests += 1
      healthResponse(response, 503, responseBody)
    },
    async (url) => {
      await assert.rejects(
        smokeTest(
          url,
          options({
            sleep: async () => {
              sleeps += 1
            },
          }),
        ),
        (error) => {
          assert.match(error.message, /after 3 attempt\(s\)/i)
          assert.match(error.message, /final status 503/i)
          assert.equal(error.message.includes(responseBody.detail), false)
          return true
        },
      )
    },
  )

  assert.equal(requests, 3)
  assert.equal(sleeps, 2)
})

test('overall deadline cancels the production retry delay timer', async () => {
  const startedAt = Date.now()
  const fetchImpl = async (url) =>
    responseAtUrl(
      new Response(JSON.stringify({ ok: false }), { status: 503 }),
      url,
    )

  await assert.rejects(
    smokeTest('https://example.invalid/api/health', {
      attempts: 2,
      delayMs: 500,
      fetchImpl,
      requestTimeoutMs: 100,
      overallTimeoutMs: 20,
      maxBodyBytes: 1024,
    }),
    /overall deadline timed out/i,
  )
  assert.ok(Date.now() - startedAt < 200)
})

test('retries network errors but stops immediately on an unlisted status', async () => {
  let fetchCalls = 0
  let sleeps = 0
  const fetchImpl = async (url) => {
    fetchCalls += 1
    if (fetchCalls === 1) {
      throw new Error('socket error with private detail')
    }
    return responseAtUrl(
      new Response(JSON.stringify({ ok: false }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      url,
    )
  }

  await assert.rejects(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        fetchImpl,
        sleep: async () => {
          sleeps += 1
        },
      }),
    ),
    (error) => {
      assert.match(error.message, /status 401/i)
      assert.equal(error.message.includes('private detail'), false)
      return true
    },
  )

  assert.equal(fetchCalls, 2)
  assert.equal(sleeps, 1)
})

test('bounds a fetch that never returns response headers', async () => {
  const outcome = await settleWithin(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        attempts: 1,
        requestTimeoutMs: 20,
        overallTimeoutMs: 50,
        fetchImpl: async () => new Promise(() => {}),
      }),
    ),
  )

  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.error.message, /timeout/i)
})

test('bounds a 200 response body that never finishes', async () => {
  const neverBody = new ReadableStream({ start() {} })
  const outcome = await settleWithin(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        attempts: 1,
        requestTimeoutMs: 20,
        overallTimeoutMs: 50,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          url: 'https://example.invalid/api/health',
          headers: new Headers(),
          body: neverBody,
          async json() {
            return new Promise(() => {})
          },
        }),
      }),
    ),
  )

  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.error.message, /timeout/i)
})

test('does not wait forever for a body reader whose cancel never finishes', async () => {
  const outcome = await settleWithin(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        attempts: 1,
        requestTimeoutMs: 20,
        overallTimeoutMs: 50,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          url: 'https://example.invalid/api/health',
          headers: new Headers(),
          body: {
            getReader() {
              return {
                read: async () => new Promise(() => {}),
                cancel: async () => new Promise(() => {}),
              }
            },
          },
        }),
      }),
    ),
  )

  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.error.message, /timeout/i)
})

test('rejects oversized health JSON before parsing it', async () => {
  await assert.rejects(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        attempts: 1,
        maxBodyBytes: 32,
        fetchImpl: async (url) =>
          responseAtUrl(
            new Response(
              JSON.stringify({ ok: true, padding: 'x'.repeat(100) }),
              { status: 200 },
            ),
            url,
          ),
      }),
    ),
    /body exceeded 32 bytes/i,
  )
})

test('rejects a final response URL outside the exact health endpoint', async () => {
  await assert.rejects(
    smokeTest(
      'https://example.invalid/api/health',
      options({
        attempts: 1,
        fetchImpl: async () => ({
          status: 200,
          ok: true,
          url: 'https://attacker.invalid/collect',
          headers: new Headers(),
          body: new Response(JSON.stringify({ ok: true })).body,
          async json() {
            return { ok: true }
          },
        }),
      }),
    ),
    /left the requested endpoint/i,
  )
})

test('reads the exact smoke-test CLI contract', () => {
  assert.deepEqual(
    readCliArguments([
      'https://app.windrun.ai/api/health',
      '--attempts',
      '30',
      '--delay-ms',
      '10000',
    ]),
    {
      url: 'https://app.windrun.ai/api/health',
      attempts: 30,
      delayMs: 10000,
    },
  )

  assert.throws(
    () =>
      readCliArguments([
        'https://app.windrun.ai/api/health',
        '--attempts',
        '0',
        '--delay-ms',
        '10000',
      ]),
    /attempts must be a positive integer/i,
  )
  assert.throws(
    () => readCliArguments(['file:///tmp/health', '--attempts', '3', '--delay-ms', '0']),
    /url must use http or https/i,
  )
})

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

function options(overrides = {}) {
  return {
    attempts: 3,
    delayMs: 0,
    fetchImpl: fetch,
    sleep: async () => {},
    ...overrides,
  }
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

test('retries network errors but stops immediately on an unlisted status', async () => {
  let fetchCalls = 0
  let sleeps = 0
  const fetchImpl = async () => {
    fetchCalls += 1
    if (fetchCalls === 1) {
      throw new Error('socket error with private detail')
    }
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
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

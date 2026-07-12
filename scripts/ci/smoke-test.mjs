import { pathToFileURL } from 'node:url'

import {
  boundedHttpRequest,
  HttpBodyTooLargeError,
  HttpEndpointError,
  HttpTimeoutError,
  OperationDeadline,
} from '../lib/bounded-http.mjs'

const retryableStatuses = new Set([404, 429, 500, 502, 503, 504])

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive integer`)
  }
  return Number(value)
}

function nonNegativeInteger(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return Number(value)
}

export function readCliArguments(args = process.argv.slice(2)) {
  if (
    args.length !== 5 ||
    args[1] !== '--attempts' ||
    args[3] !== '--delay-ms'
  ) {
    throw new Error(
      'usage: smoke-test.mjs URL --attempts COUNT --delay-ms MILLISECONDS',
    )
  }

  let parsedUrl
  try {
    parsedUrl = new URL(args[0])
  } catch {
    throw new Error('URL must be an absolute HTTP or HTTPS URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('URL must use HTTP or HTTPS')
  }

  return {
    url: parsedUrl.href,
    attempts: positiveInteger(args[2], 'attempts'),
    delayMs: nonNegativeInteger(args[4], 'delay-ms'),
  }
}

export async function smokeTest(
  url,
  {
    attempts,
    delayMs,
    fetchImpl = fetch,
    sleep,
    requestTimeoutMs = 15_000,
    overallTimeoutMs =
      attempts * 15_000 + Math.max(0, attempts - 1) * delayMs + 1_000,
    maxBodyBytes = 64 * 1024,
  },
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('attempts must be a positive integer')
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('delayMs must be a non-negative integer')
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error('requestTimeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
    throw new Error('overallTimeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('maxBodyBytes must be a positive integer')
  }

  let finalStatus
  let finalTimedOut = false
  const deadline = new OperationDeadline(
    overallTimeoutMs,
    'Smoke test overall deadline',
  )

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result
    try {
      result = await boundedHttpRequest({
        fetchImpl,
        url,
        init: { cache: 'no-store' },
        label: 'Smoke request',
        requestTimeoutMs,
        maxBodyBytes,
        body: 'text',
        deadline,
      })
    } catch (error) {
      if (
        error instanceof HttpBodyTooLargeError ||
        error instanceof HttpEndpointError
      ) {
        throw error
      }
      finalStatus = undefined
      finalTimedOut = error instanceof HttpTimeoutError
      if (attempt < attempts) {
        if (sleep) {
          await deadline.wait(sleep(delayMs))
        } else {
          await deadline.delay(delayMs)
        }
        continue
      }
      break
    }

    const { response, text } = result
    finalStatus = response.status
    finalTimedOut = false

    if (response.status === 200) {
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('Smoke test received invalid JSON at status 200')
      }

      if (payload?.ok === true) {
        return response.status
      }

      throw new Error('Smoke test expected ok === true at status 200')
    }

    if (!retryableStatuses.has(response.status)) {
      throw new Error(
        `Smoke test stopped on non-retryable status ${response.status}`,
      )
    }

    if (attempt < attempts) {
      if (sleep) {
        await deadline.wait(sleep(delayMs))
      } else {
        await deadline.delay(delayMs)
      }
    }
  }

  const finalResult =
    finalTimedOut
      ? 'request timeout'
      : finalStatus === undefined
        ? 'network error'
        : `status ${finalStatus}`
  throw new Error(
    `Smoke test failed after ${attempts} attempt(s): final ${finalResult}`,
  )
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const options = readCliArguments()
    const status = await smokeTest(options.url, options)
    console.log(`SMOKE OK url=${options.url} status=${status}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Smoke test failed')
    process.exitCode = 1
  }
}

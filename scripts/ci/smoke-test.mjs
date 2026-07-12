import { pathToFileURL } from 'node:url'

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

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export async function smokeTest(
  url,
  { attempts, delayMs, fetchImpl = fetch, sleep = wait },
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('attempts must be a positive integer')
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('delayMs must be a non-negative integer')
  }

  let finalStatus

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, { cache: 'no-store' })
    } catch {
      finalStatus = undefined
      if (attempt < attempts) {
        await sleep(delayMs)
        continue
      }
      break
    }

    finalStatus = response.status

    if (response.status === 200) {
      let payload
      try {
        payload = await response.json()
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
      await sleep(delayMs)
    }
  }

  const finalResult =
    finalStatus === undefined ? 'network error' : `status ${finalStatus}`
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

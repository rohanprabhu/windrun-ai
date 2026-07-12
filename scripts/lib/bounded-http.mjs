const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

export class HttpTimeoutError extends Error {
  constructor(label) {
    super(`${label} timed out`)
    this.name = 'HttpTimeoutError'
  }
}

export class HttpBodyTooLargeError extends Error {
  constructor(label, maxBodyBytes) {
    super(`${label} body exceeded ${maxBodyBytes} bytes`)
    this.name = 'HttpBodyTooLargeError'
  }
}

export class HttpInvalidJsonError extends Error {
  constructor(label) {
    super(`${label} returned invalid JSON`)
    this.name = 'HttpInvalidJsonError'
  }
}

export class HttpEndpointError extends Error {
  constructor(label) {
    super(`${label} response left the requested endpoint`)
    this.name = 'HttpEndpointError'
  }
}

export class OperationDeadline {
  constructor(timeoutMs, label) {
    this.timeoutMs = positiveSafeInteger(timeoutMs, 'overallTimeoutMs')
    this.label = label
    this.expiresAt = Date.now() + timeoutMs
  }

  remaining() {
    return Math.max(0, this.expiresAt - Date.now())
  }

  async wait(promise) {
    const remaining = this.remaining()
    if (remaining === 0) throw new HttpTimeoutError(this.label)
    let timer
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new HttpTimeoutError(this.label)),
            remaining,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async delay(delayMs) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error('delayMs must be a non-negative safe integer')
    }
    const remaining = this.remaining()
    if (remaining === 0) throw new HttpTimeoutError(this.label)
    const expiresFirst = delayMs >= remaining
    await new Promise((resolve, reject) => {
      setTimeout(
        () =>
          expiresFirst
            ? reject(new HttpTimeoutError(this.label))
            : resolve(),
        expiresFirst ? remaining : delayMs,
      )
    })
  }
}

function canonicalUrl(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`)
  }
  return parsed.href
}

function assertExpectedResponseUrl(response, expectedUrl, label) {
  if (
    response?.redirected === true ||
    typeof response?.url !== 'string' ||
    response.url === '' ||
    canonicalUrl(response.url, 'response URL') !== expectedUrl
  ) {
    throw new HttpEndpointError(label)
  }
}

function readContentLength(response, label, maxBodyBytes) {
  const raw = response.headers?.get?.('content-length')
  if (raw === null || raw === undefined) return
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`${label} returned an invalid content-length`)
  }
  if (BigInt(raw) > BigInt(maxBodyBytes)) {
    throw new HttpBodyTooLargeError(label, maxBodyBytes)
  }
}

async function readBoundedBody(
  response,
  maxBodyBytes,
  race,
  controller,
  label,
) {
  readContentLength(response, label, maxBodyBytes)
  const reader = response.body?.getReader?.()
  if (!reader) {
    throw new Error(`${label} did not expose a readable body`)
  }

  const chunks = []
  let size = 0
  try {
    while (true) {
      const result = await race(reader.read())
      if (result?.done === true) break
      if (!(result?.value instanceof Uint8Array)) {
        throw new Error(`${label} returned an invalid body chunk`)
      }
      size += result.value.byteLength
      if (size > maxBodyBytes) {
        throw new HttpBodyTooLargeError(label, maxBodyBytes)
      }
      chunks.push(result.value)
    }
  } finally {
    controller.abort()
    void Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => {
        // The request is already bounded and no transport detail is exposed.
      })
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { text: textDecoder.decode(bytes), byteLength: size }
  } catch {
    throw new Error(`${label} returned invalid UTF-8`)
  }
}

export async function boundedHttpRequest({
  fetchImpl,
  url,
  init = {},
  label,
  requestTimeoutMs,
  maxBodyBytes,
  body = 'none',
  deadline,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  positiveSafeInteger(requestTimeoutMs, 'requestTimeoutMs')
  if (body !== 'none') positiveSafeInteger(maxBodyBytes, 'maxBodyBytes')
  const expectedUrl = canonicalUrl(url, 'request URL')
  const overallRemaining = deadline?.remaining?.()
  const timeoutMs = Math.min(
    requestTimeoutMs,
    overallRemaining === undefined ? requestTimeoutMs : overallRemaining,
  )
  if (timeoutMs < 1) {
    throw new HttpTimeoutError(deadline?.label || label)
  }

  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new HttpTimeoutError(label))
    }, timeoutMs)
  })
  const race = (promise) => Promise.race([Promise.resolve(promise), timeout])

  try {
    let response
    try {
      response = await race(
        fetchImpl(expectedUrl, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        }),
      )
    } catch (error) {
      if (error instanceof HttpTimeoutError) throw error
      throw new Error(`${label} failed before receiving a response`)
    }
    if (
      !response ||
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    ) {
      throw new Error(`${label} returned an invalid response`)
    }
    assertExpectedResponseUrl(response, expectedUrl, label)

    if (body === 'none') {
      void Promise.resolve()
        .then(() => response.body?.cancel?.())
        .catch(() => {})
      return { response, bodyBytes: 0 }
    }
    const result = await readBoundedBody(
      response,
      maxBodyBytes,
      race,
      controller,
      label,
    )
    if (body === 'text') {
      return {
        response,
        text: result.text,
        bodyBytes: result.byteLength,
      }
    }
    if (body !== 'json') throw new Error('unsupported bounded body mode')
    try {
      return {
        response,
        json: JSON.parse(result.text),
        bodyBytes: result.byteLength,
      }
    } catch {
      throw new HttpInvalidJsonError(label)
    }
  } finally {
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function utf8ByteLength(value) {
  return textEncoder.encode(value).byteLength
}

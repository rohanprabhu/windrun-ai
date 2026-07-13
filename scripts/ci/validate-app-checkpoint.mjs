import { pathToFileURL } from 'node:url'

const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsRegistryCredentialField(value) {
  if (Array.isArray(value)) {
    return value.some(containsRegistryCredentialField)
  }
  if (!isObject(value)) return false
  return Object.entries(value).some(
    ([key, nested]) =>
      key === 'registries' || containsRegistryCredentialField(nested),
  )
}

function containsOnlyDockerProviderMetadata(value) {
  if (!isObject(value)) return false
  const allowedKeys = new Set([
    '__internal',
    '__pulumi-go-provider-infer',
    '__pulumi-go-provider-version',
    'host',
    'version',
  ])
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

export function validateAppCheckpoint(raw) {
  let checkpoint
  try {
    checkpoint = JSON.parse(raw)
  } catch {
    throw new Error('checkpoint must be valid JSON')
  }
  if (
    (checkpoint?.version !== 3 && checkpoint?.version !== 4) ||
    !Array.isArray(checkpoint?.deployment?.resources)
  ) {
    throw new Error('checkpoint must contain deployment resources')
  }

  const resources = checkpoint.deployment.resources
  const providers = resources.filter(
    (resource) => resource?.type === 'pulumi:providers:docker-build',
  )
  const images = resources.filter(
    (resource) => resource?.type === 'docker-build:index:Image',
  )
  if (providers.length !== 1 || images.length !== 1) {
    throw new Error('checkpoint must contain one Docker provider and image')
  }

  const provider = providers[0]
  if (
    !isObject(provider.inputs) ||
    !containsOnlyDockerProviderMetadata(provider.inputs) ||
    !containsOnlyDockerProviderMetadata(provider.outputs) ||
    provider.inputs.host !== '' ||
    typeof provider.urn !== 'string' ||
    typeof provider.id !== 'string' ||
    provider.id === '' ||
    containsRegistryCredentialField(provider.inputs) ||
    containsRegistryCredentialField(provider.outputs)
  ) {
    throw new Error('Docker provider state is not credential-free')
  }

  const image = images[0]
  if (
    !isObject(image.inputs) ||
    image.inputs.exec !== false ||
    containsRegistryCredentialField(image.inputs) ||
    containsRegistryCredentialField(image.outputs) ||
    typeof image.provider !== 'string' ||
    !image.provider.startsWith(`${provider.urn}::`) ||
    image.provider !== `${provider.urn}::${provider.id}`
  ) {
    throw new Error('Docker image state is not credential-free')
  }

  const serialized = JSON.stringify({ provider, image })
  if (/oauth2accesstoken|ya29\.|mock-access-token/iu.test(serialized)) {
    throw new Error('Docker state contains a credential marker')
  }
}

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_CHECKPOINT_BYTES) {
      throw new Error('checkpoint exceeded the input limit')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    validateAppCheckpoint(await readStdin())
    console.log('APP CHECKPOINT AUTH SAFE')
  } catch {
    console.error('APP CHECKPOINT AUTH REFUSED')
    process.exitCode = 1
  }
}

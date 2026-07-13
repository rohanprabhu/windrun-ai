import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const validator = fileURLToPath(
  new URL('./validate-app-checkpoint.mjs', import.meta.url),
)

function checkpoint(resources) {
  return JSON.stringify({
    version: 3,
    deployment: {
      manifest: {},
      pending_operations: [],
      resources,
    },
  })
}

function dockerProvider(overrides = {}) {
  return {
    urn: 'urn:pulumi:production::windrun-ai::pulumi:providers:docker-build::production-docker-build',
    type: 'pulumi:providers:docker-build',
    custom: true,
    id: 'provider-id',
    inputs: { host: '' },
    outputs: { host: '' },
    ...overrides,
  }
}

function image(overrides = {}) {
  return {
    urn: 'urn:pulumi:production::windrun-ai::docker-build:index:Image::production-image',
    type: 'docker-build:index:Image',
    custom: true,
    id: 'image-id',
    provider:
      'urn:pulumi:production::windrun-ai::pulumi:providers:docker-build::production-docker-build::provider-id',
    inputs: { exec: false, push: true, tags: ['example/image:sha'] },
    outputs: { exec: false, push: true, tags: ['example/image:sha'] },
    ...overrides,
  }
}

function run(raw) {
  return spawnSync(process.execPath, [validator], {
    encoding: 'utf8',
    input: raw,
  })
}

test('accepts an exported application checkpoint with state-free helper auth', () => {
  const result = run(checkpoint([dockerProvider(), image()]))

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'APP CHECKPOINT AUTH SAFE\n')
})

test('accepts Pulumi docker-build provider metadata without registry credentials', () => {
  const result = run(
    checkpoint([
      dockerProvider({
        inputs: {
          __internal: {},
          '__pulumi-go-provider-infer': true,
          '__pulumi-go-provider-version': 'v1.3.2',
          host: '',
          version: '0.0.20',
        },
        outputs: {
          '__pulumi-go-provider-infer': true,
          '__pulumi-go-provider-version': 'v1.3.2',
          host: '',
          version: '0.0.20',
        },
      }),
      image(),
    ]),
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'APP CHECKPOINT AUTH SAFE\n')
})

for (const [name, resources] of [
  [
    'encrypted image input registries',
    [
      dockerProvider(),
      image({
        inputs: {
          exec: false,
          registries: {
            '4dabf18193072939515e22adb298388d':
              '1b47061264138c4ac30d75fd1eb44270',
            ciphertext: 'encrypted-oauth-token',
          },
        },
      }),
    ],
  ],
  [
    'provider input registries',
    [dockerProvider({ inputs: { host: '', registries: [] } }), image()],
  ],
  [
    'image output registries',
    [dockerProvider(), image({ outputs: { registries: [] } })],
  ],
  [
    'ambient Docker host provider',
    [dockerProvider({ inputs: { host: 'tcp://attacker.invalid:2375' } }), image()],
  ],
  [
    'exec image mode',
    [dockerProvider(), image({ inputs: { exec: true } })],
  ],
]) {
  test(`rejects ${name}`, () => {
    const result = run(checkpoint(resources))

    assert.equal(result.status, 1)
    assert.match(result.stderr, /APP CHECKPOINT AUTH REFUSED/u)
    assert.doesNotMatch(result.stderr, /encrypted-oauth-token/u)
  })
}

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createPulumiOperations,
  PulumiMutationStateUnknownError,
  runManagedProcess,
  stackRef,
} from './lib/pulumi.mjs'
import {
  bootstrapPlatform,
  FOUNDATION_BOOTSTRAP_OUTPUTS,
  PHASE_ONE_STACKS,
} from './bootstrap-platform.mjs'
import { destroyEnvironment } from './destroy-environment.mjs'
import { destroyPlatform } from './destroy-platform.mjs'

const LOGIN = 'bootstrap-user'
const PROJECT = 'windrun-ai'
const OWNER_EMAIL = 'rohan@windrun.ai'
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const MANAGED_BACKEND = 'https://api.pulumi.com'
const MANAGED_APP_BACKEND = `https://app.pulumi.com/${LOGIN}`
const PULUMI_TOKEN = 'pulumi-platform-token-fixture'
const GITHUB_TOKEN = 'github-platform-token-fixture'
const PROJECT_IDS = Object.freeze([
  'windrun-ai-shared-20260712',
  'windrun-ai-staging-20260712',
  'windrun-ai-prod-20260712',
])
const PLATFORM_REFUSAL =
  'REFUSED: pass --destroy-projects to acknowledge deletion of all three GCP projects'
const PULUMI_FIXTURE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
)
const CANONICAL_FOUNDATION_CHECKPOINT = readFileSync(
  resolve(
    PULUMI_FIXTURE_DIRECTORY,
    'pulumi-v3.244-foundation-checkpoint.json',
  ),
  'utf8',
)
const CANONICAL_FOUNDATION_PREVIEW = readFileSync(
  resolve(
    PULUMI_FIXTURE_DIRECTORY,
    'pulumi-v3.244-foundation-preview.json',
  ),
  'utf8',
)

function commandText(executable, args) {
  return [executable, ...args].join(' ')
}

function createProcessHarness({
  stackExport = {
    deployment: { resources: [{ type: 'pulumi:pulumi:Stack' }] },
  },
  activeGoogleEmail = OWNER_EMAIL,
  adcToken = 'adc-token-fixture',
} = {}) {
  const calls = []

  async function processRunner(executable, args, options = {}) {
    calls.push({
      executable,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      capture: options.capture,
    })

    const command = commandText(executable, args)
    if (command.endsWith('pulumi whoami --json')) {
      return {
        stdout: `${JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND })}\n`,
        stderr: '',
      }
    }
    if (command.includes('pulumi stack export --stack')) {
      return { stdout: `${JSON.stringify(stackExport)}\n`, stderr: '' }
    }
    if (
      command ===
      'gcloud auth list --filter=status:ACTIVE --format=value(account)'
    ) {
      return { stdout: `${activeGoogleEmail}\n`, stderr: '' }
    }
    if (
      command ===
      'gcloud auth application-default print-access-token'
    ) {
      return { stdout: `${adcToken}\n`, stderr: '' }
    }
    if (command === 'git rev-parse HEAD') {
      return { stdout: `${GIT_SHA}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  return { calls, processRunner }
}

function jsonResponseAtUrl(url, payload, status = 200) {
  const response = new Response(JSON.stringify(payload), { status })
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: String(url),
  })
  return response
}

function createOperations({
  harness = createProcessHarness(),
  fetchImpl = async (url) => jsonResponseAtUrl(url, { email: OWNER_EMAIL }),
  environment = { PATH: process.env.PATH, SAFE_ADC: 'inherited' },
  repositoryRoot = '/workspace/windrun-ai',
  requestTimeoutMs,
  maxUserinfoBytes,
} = {}) {
  const operations = createPulumiOperations({
    processRunner: harness.processRunner,
    fetchImpl,
    environment,
    repositoryRoot,
    requestTimeoutMs,
    maxUserinfoBytes,
  })
  return { harness, operations }
}

test('builds only fully qualified Windrun stack references', () => {
  assert.equal(
    stackRef('claimed-user', 'production'),
    'claimed-user/windrun-ai/production',
  )
  assert.throws(() => stackRef('', 'production'), /organization/)
  assert.throws(() => stackRef('claimed-user', 'bad/stack'), /stack name/)
})

test('runPulumi always uses infra cwd and inherits ADC environment', async () => {
  const { harness, operations } = createOperations()

  await operations.runPulumi(['preview', '--stack', 'org/windrun-ai/staging'])

  assert.equal(harness.calls.length, 1)
  assert.deepEqual(
    {
      ...harness.calls[0],
      env: {
        PATH: harness.calls[0].env.PATH,
        SAFE_ADC: harness.calls[0].env.SAFE_ADC,
      },
    },
    {
      executable: 'pulumi',
      args: ['preview', '--stack', 'org/windrun-ai/staging'],
      cwd: resolve('/workspace/windrun-ai', 'infra'),
      env: { PATH: process.env.PATH, SAFE_ADC: 'inherited' },
      capture: true,
    },
  )
  assert.match(harness.calls[0].env.DOCKER_CONFIG, /windrun-docker-config-/u)
})

test('runPulumi uses and removes an isolated gcloud Docker credential-helper config', async () => {
  const calls = []
  let dockerConfigPath
  const operations = createPulumiOperations({
    environment: {
      PATH: process.env.PATH,
      DOCKER_CONFIG: '/untrusted/operator/docker-config',
    },
    repositoryRoot: '/workspace/windrun-ai',
    async processRunner(executable, args, options) {
      calls.push({ executable, args: [...args], env: { ...options.env } })
      dockerConfigPath = options.env.DOCKER_CONFIG
      assert.notEqual(dockerConfigPath, '/untrusted/operator/docker-config')
      assert.deepEqual(
        JSON.parse(readFileSync(join(dockerConfigPath, 'config.json'), 'utf8')),
        {
          credHelpers: {
            'asia-south1-docker.pkg.dev': 'gcloud',
          },
        },
      )
      return { stdout: '', stderr: '' }
    },
  })

  await operations.runPulumi(['preview', '--stack', 'org/windrun-ai/staging'])

  assert.equal(calls.length, 1)
  assert.equal(existsSync(dockerConfigPath), false)
})

test('mutating runPulumi uses a temporary Artifact Registry OAuth Docker config', async () => {
  const calls = []
  let dockerConfigPath
  const accessToken = 'registry-access-token-fixture'
  const expectedAuth = Buffer.from(
    `oauth2accesstoken:${accessToken}`,
  ).toString('base64')
  const operations = createPulumiOperations({
    environment: {
      PATH: process.env.PATH,
      DOCKER_CONFIG: '/untrusted/operator/docker-config',
    },
    repositoryRoot: '/workspace/windrun-ai',
    async processRunner(executable, args, options) {
      calls.push({ executable, args: [...args], env: { ...options.env } })
      if (
        executable === 'gcloud' &&
        args.join(' ') === 'auth application-default print-access-token'
      ) {
        return { stdout: `${accessToken}\n`, stderr: '' }
      }
      dockerConfigPath = options.env.DOCKER_CONFIG
      assert.deepEqual(
        JSON.parse(readFileSync(join(dockerConfigPath, 'config.json'), 'utf8')),
        {
          auths: {
            'asia-south1-docker.pkg.dev': {
              auth: expectedAuth,
            },
          },
        },
      )
      return { stdout: '', stderr: '' }
    },
  })

  await operations.runPulumi(['up', '--yes', '--stack', 'org/windrun-ai/staging'])

  assert.deepEqual(
    calls.map(({ executable, args }) => [executable, ...args]),
    [
      ['gcloud', 'auth', 'application-default', 'print-access-token'],
      ['pulumi', 'up', '--yes', '--stack', 'org/windrun-ai/staging'],
    ],
  )
  assert.equal(existsSync(dockerConfigPath), false)
})

test('production refuses a PULUMI_BIN whose basename is not pulumi', async () => {
  const operations = createPulumiOperations({
    environment: {
      ...process.env,
      PULUMI_BIN: '/tmp/not-pulumi-cli',
    },
  })

  await assert.rejects(
    operations.runPulumi(['version']),
    /PULUMI_BIN basename must be exactly pulumi/,
  )
})

test('managed child runner bounds a process that ignores TERM', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    runManagedProcess(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      {
        capture: true,
        timeoutMs: 30,
        killGraceMs: 20,
        maxOutputBytes: 1024,
        mutationMayHaveStarted: false,
      },
    ),
    (error) => {
      assert.equal(error.code, 'COMMAND_TIMEOUT')
      assert.doesNotMatch(error.message, /setInterval|SIGTERM/u)
      return true
    },
  )
  assert.ok(Date.now() - startedAt < 500)
})

test('managed child runner bounds output and marks killed mutations unknown', async () => {
  await assert.rejects(
    runManagedProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      {
        capture: true,
        timeoutMs: 1_000,
        killGraceMs: 20,
        maxOutputBytes: 512,
        mutationMayHaveStarted: true,
      },
    ),
    (error) => {
      assert.equal(error.code, 'PULUMI_MUTATION_STATE_UNKNOWN')
      assert.equal(error instanceof PulumiMutationStateUnknownError, true)
      assert.doesNotMatch(error.message, /x{10}/u)
      return true
    },
  )
})

test('runPulumi classifies read-only timeouts separately from unknown mutations', async () => {
  const classifications = []
  const operations = createPulumiOperations({
    repositoryRoot: '/workspace/windrun-ai',
    environment: { PATH: process.env.PATH },
    async processRunner(_executable, args, options) {
      classifications.push({ args: [...args], unknown: options.mutationMayHaveStarted })
      if (args.join(' ') === 'auth application-default print-access-token') {
        return { stdout: 'registry-access-token\n', stderr: '' }
      }
      if (options.mutationMayHaveStarted) {
        throw new PulumiMutationStateUnknownError()
      }
      const error = new Error('secret child detail must not escape')
      error.code = 'COMMAND_TIMEOUT'
      throw error
    },
  })

  for (const args of [
    ['preview', '--stack', 'org/windrun-ai/production'],
    ['stack', 'export', '--stack', 'org/windrun-ai/production'],
    ['stack', 'ls', '--json'],
    ['config', '--json', '--stack', 'org/windrun-ai/production'],
  ]) {
    await assert.rejects(operations.runPulumi(args), (error) => {
      assert.equal(error.code, 'COMMAND_TIMEOUT')
      return true
    })
  }
  for (const args of [
    ['up', '--yes', '--stack', 'org/windrun-ai/production'],
    ['destroy', '--yes', '--stack', 'org/windrun-ai/production'],
    ['config', 'set', 'key', 'value', '--stack', 'org/windrun-ai/production'],
    ['stack', 'select', '--create', 'org/windrun-ai/production'],
    ['unknown-verb'],
  ]) {
    await assert.rejects(operations.runPulumi(args), (error) => {
      assert.equal(error.code, 'PULUMI_MUTATION_STATE_UNKNOWN')
      assert.doesNotMatch(error.message, /secret child detail/u)
      return true
    })
  }
  assert.deepEqual(
    classifications
      .filter(({ args }) => args[0] !== 'auth')
      .map(({ unknown }) => unknown),
    [false, false, false, false, true, true, true, true, true],
  )
})

test('an injected process runner may use a non-production Pulumi fixture name', async () => {
  const harness = createProcessHarness()
  const operations = createPulumiOperations({
    processRunner: harness.processRunner,
    environment: { PULUMI_BIN: '/tmp/fake-pulumi-fixture' },
    repositoryRoot: '/workspace/windrun-ai',
  })

  await operations.runPulumi(['version'])

  assert.equal(harness.calls[0].executable, '/tmp/fake-pulumi-fixture')
})

test('stackHasResources ignores only the Pulumi root stack resource', async () => {
  const rootOnly = createOperations()
  assert.equal(
    await rootOnly.operations.stackHasResources(
      'claimed-user/windrun-ai/staging',
    ),
    false,
  )

  const withService = createOperations({
    harness: createProcessHarness({
      stackExport: {
        deployment: {
          resources: [
            { type: 'pulumi:pulumi:Stack' },
            { type: 'gcp:cloudrunv2/service:Service' },
          ],
        },
      },
    }),
  })
  assert.equal(
    await withService.operations.stackHasResources(
      'claimed-user/windrun-ai/staging',
    ),
    true,
  )
})

test('stackHasResources fails closed on malformed exports', async () => {
  const harness = createProcessHarness()
  harness.processRunner = async () => ({ stdout: '{bad-json', stderr: '' })
  const { operations } = createOperations({ harness })

  await assert.rejects(
    operations.stackHasResources('claimed-user/windrun-ai/staging'),
    /stack export must contain a deployment resources array/,
  )
})

test('destroyAndRemove uses one exact Pulumi destroy/remove command', async () => {
  const { harness, operations } = createOperations()
  const stack = 'claimed-user/windrun-ai/staging'

  await operations.destroyAndRemove(stack)

  assert.deepEqual(harness.calls.at(-1).args, [
    'destroy',
    '--yes',
    '--remove',
    '--stack',
    stack,
  ])
})

test('assertExactGoogleIdentity permits only exact active gcloud and ADC identities', async () => {
  const harness = createProcessHarness()
  const fetchCalls = []
  const { operations } = createOperations({
    harness,
    fetchImpl: async (url, options) => {
      fetchCalls.push({
        url,
        options: { headers: { ...options.headers } },
      })
      return jsonResponseAtUrl(url, { email: OWNER_EMAIL })
    },
  })

  await operations.assertExactGoogleIdentity()

  assert.deepEqual(
    harness.calls.map(({ executable, args }) => [executable, ...args]),
    [
      [
        'gcloud',
        'auth',
        'list',
        '--filter=status:ACTIVE',
        '--format=value(account)',
      ],
      [
        'gcloud',
        'auth',
        'application-default',
        'print-access-token',
      ],
    ],
  )
  assert.deepEqual(fetchCalls, [
    {
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      options: {
        headers: { Authorization: 'Bearer adc-token-fixture' },
      },
    },
  ])
})

test('assertExactGoogleIdentity refuses either mismatched identity without logging the ADC token', async () => {
  const wrongActive = createOperations({
    harness: createProcessHarness({ activeGoogleEmail: 'other@example.com' }),
  })
  await assert.rejects(
    wrongActive.operations.assertExactGoogleIdentity(),
    /active gcloud identity must be exactly rohan@windrun\.ai/,
  )

  const wrongAdc = createOperations({
    fetchImpl: async (url) =>
      jsonResponseAtUrl(url, { email: 'other@example.com' }),
  })
  await assert.rejects(
    wrongAdc.operations.assertExactGoogleIdentity(),
    /ADC identity must be exactly rohan@windrun\.ai/,
  )
})

test('assertExactGoogleIdentity rejects non-success userinfo even with the expected email', async () => {
  const { operations } = createOperations({
    fetchImpl: async (url) =>
      jsonResponseAtUrl(url, { email: OWNER_EMAIL }, 401),
  })

  await assert.rejects(
    operations.assertExactGoogleIdentity(),
    /ADC identity lookup failed/,
  )
})

test('assertExactGoogleIdentity bounds userinfo headers, bodies, and size', async () => {
  const cases = [
    async () => new Promise(() => {}),
    async () => ({
      ok: true,
      status: 200,
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      headers: new Headers(),
      body: new ReadableStream({ start() {} }),
      async json() {
        return new Promise(() => {})
      },
    }),
    async (url) =>
      jsonResponseAtUrl(
        url,
        { email: OWNER_EMAIL, padding: 'x'.repeat(70_000) },
      ),
  ]

  for (const fetchImpl of cases) {
    const { operations } = createOperations({
      fetchImpl,
      requestTimeoutMs: 20,
      maxUserinfoBytes: 1_024,
    })
    const outcome = await Promise.race([
      operations.assertExactGoogleIdentity().then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error }),
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'pending' }), 500),
      ),
    ])
    assert.equal(outcome.status, 'rejected')
    assert.match(outcome.error.message, /ADC identity lookup failed/)
  }
})

for (const credentialName of [
  'GOOGLE_CREDENTIALS',
  'GOOGLE_CLOUD_KEYFILE_JSON',
  'GCLOUD_KEYFILE_JSON',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
  'PULUMI_CONFIG',
]) {
  test(`assertExactGoogleIdentity refuses ambient ${credentialName} before invoking gcloud`, async () => {
    const harness = createProcessHarness()
    const { operations } = createOperations({
      harness,
      environment: {
        PATH: process.env.PATH,
        [credentialName]: 'alternate-provider-credential',
      },
    })

    await assert.rejects(
      operations.assertExactGoogleIdentity(),
      new RegExp(`${credentialName} is not permitted`),
    )
    assert.deepEqual(harness.calls, [])
  })
}

for (const providerKey of [
  'gcp:credentials',
  'gcp:accessToken',
  'gcp:impersonateServiceAccount',
  'gcp:impersonateServiceAccountDelegates',
]) {
  test(`assertExactGoogleIdentity refuses ${providerKey} in Pulumi stack config`, async () => {
    const harness = createProcessHarness()
    const originalRunner = harness.processRunner
    harness.processRunner = async (executable, args, options) => {
      if (args[0] === 'config' && args[1] === '--json') {
        harness.calls.push({
          executable,
          args: [...args],
          cwd: options.cwd,
          env: { ...options.env },
          capture: options.capture,
        })
        return {
          stdout: JSON.stringify({
            [providerKey]: { value: 'alternate-provider-credential' },
          }),
          stderr: '',
        }
      }
      return originalRunner(executable, args, options)
    }
    const { operations } = createOperations({ harness })

    await assert.rejects(
      operations.assertExactGoogleIdentity({
        stackRefs: ['claimed-user/windrun-ai/production'],
      }),
      new RegExp(`${providerKey} is not permitted`),
    )
    assert.equal(
      harness.calls.some(({ args }) => args[0] === 'config'),
      true,
    )
  })
}

test('the lifecycle command boundary exposes no generic gcloud runner', async () => {
  const { operations } = createOperations()

  await assert.rejects(
    operations.runLifecycleCommand('gcloud', ['projects', 'delete']),
    /lifecycle command is not permitted/,
  )
})

function writeExecutable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

test('bootstrap previews and applies the five pre-claim stacks in exact order through fake Pulumi', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windrun-bootstrap-'))
  const bin = join(root, 'bin')
  const logPath = join(root, 'pulumi.log')
  const pulumiPath = join(bin, 'pulumi')
  const gcloudPath = join(bin, 'gcloud')
  const events = []
  const messages = []

  try {
    mkdirSync(join(root, 'infra'), { recursive: true })
    mkdirSync(bin)
    writeFileSync(logPath, '')
    writeExecutable(
      pulumiPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.PULUMI_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
if (process.argv.slice(2).join(' ') === 'whoami --json') {
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND })}\n`)})
}
`,
    )
    writeExecutable(
      gcloudPath,
      `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'auth application-default print-access-token') {
  process.stdout.write('registry-access-token\\n')
}
`,
    )
    const operations = createPulumiOperations({
      environment: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        PULUMI_BIN: pulumiPath,
        PULUMI_FAKE_LOG: logPath,
      },
      repositoryRoot: root,
    })

    await bootstrapPlatform({
      argv: ['--apply'],
      async runPulumi(args, options) {
        events.push(`pulumi:${args.join(' ')}`)
        return operations.runPulumi(args, options)
      },
      stackRef,
      async assertGoogleIdentity() {
        events.push('google-identity')
      },
      async readGitHead() {
        events.push('git-head')
        return GIT_SHA
      },
      async runPnpmScript(script) {
        events.push(`pnpm:${script}`)
      },
      validateCheckpoint() {},
      log(message) {
        messages.push(message)
      },
    })

    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(events[0], 'google-identity')
    assert.deepEqual(events.slice(1, 4), [
      'git-head',
      'pnpm:ci:validate-contract',
      'pnpm:ci:quality',
    ])
    assert.deepEqual(
      calls
        .filter(({ args }) => args[0] === 'stack' && args[1] === 'select')
        .map(({ args }) => args.at(-1)),
      PHASE_ONE_STACKS.map((stack) => stackRef(LOGIN, stack)),
    )
    for (const stack of PHASE_ONE_STACKS) {
      const ref = stackRef(LOGIN, stack)
      const previewIndex = calls.findIndex(
        ({ args }) => args[0] === 'preview' && args.at(-1) === ref,
      )
      const upIndex = calls.findIndex(
        ({ args }) => args[0] === 'up' && args.at(-1) === ref,
      )
      assert.ok(previewIndex >= 0)
      assert.ok(upIndex > previewIndex)
    }
    assert.equal(
      calls.some(({ args }) => args.join(' ').includes('/delivery')),
      false,
    )
    assert.equal(
      calls.every(
        ({ cwd }) => cwd === realpathSync(resolve(root, 'infra')),
      ),
      true,
    )
    const commitConfigs = calls.filter(
      ({ args }) =>
        args[0] === 'config' &&
        args[1] === 'set' &&
        args[2] === 'windrun-ai:gitCommitSha',
    )
    assert.deepEqual(
      commitConfigs.map(({ args }) => args.at(-1)),
      [stackRef(LOGIN, 'production'), stackRef(LOGIN, 'staging')],
    )
    assert.equal(
      commitConfigs.every(({ args }) => args[3] === GIT_SHA),
      true,
    )
    const commitRemovals = calls.filter(
      ({ args }) =>
        args[0] === 'config' &&
        args[1] === 'rm' &&
        args[2] === 'windrun-ai:gitCommitSha',
    )
    assert.deepEqual(
      commitRemovals.map(({ args }) => args.at(-1)),
      [stackRef(LOGIN, 'production'), stackRef(LOGIN, 'staging')],
    )
    assert.deepEqual(messages, [
      'GOOGLE IDENTITY VERIFIED: rohan@windrun.ai',
      'BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clean bootstrap preview stops safely after foundation when outputs do not exist', async () => {
  const calls = []
  const messages = []

  const result = await bootstrapPlatform({
    argv: [],
    async runPulumi(args) {
      calls.push([...args])
      if (args[0] === 'whoami') {
        return JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND })
      }
      if (args[0] === 'stack' && args[1] === 'output') {
        return '{}'
      }
      return ''
    },
    stackRef,
    async assertGoogleIdentity() {},
    async readGitHead() {
      return GIT_SHA
    },
    async runPnpmScript() {},
    log(message) {
      messages.push(message)
    },
  })

  assert.deepEqual(
    calls.filter((args) => args[0] === 'preview').map((args) => args.at(-1)),
    [stackRef(LOGIN, 'foundation')],
  )
  assert.equal(calls.some((args) => args[0] === 'up'), false)
  assert.equal(calls.some((args) => args.join(' ').includes('delivery')), false)
  assert.equal(
    calls.some(
      (args) =>
        (args[0] === 'stack' && args[1] === 'select' &&
          args.at(-1) !== stackRef(LOGIN, 'foundation')) ||
        (args[0] === 'config' &&
          args.at(-1) !== stackRef(LOGIN, 'foundation')),
    ),
    false,
  )
  assert.deepEqual(result.stacks, ['foundation'])
  assert.match(messages.at(-1), /DOWNSTREAM PREVIEWS PENDING/u)
})

test('bootstrap preview continues to all consumers when foundation outputs exist', async () => {
  const calls = []

  await bootstrapPlatform({
    argv: [],
    async runPulumi(args) {
      calls.push([...args])
      if (args[0] === 'whoami') {
        return JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND })
      }
      if (args[0] === 'stack' && args[1] === 'output') {
        return JSON.stringify(
          Object.fromEntries(
            FOUNDATION_BOOTSTRAP_OUTPUTS.map((name) => [name, `${name}-value`]),
          ),
        )
      }
      return ''
    },
    stackRef,
    async assertGoogleIdentity() {},
    async readGitHead() {
      return GIT_SHA
    },
    async runPnpmScript() {},
    log() {},
  })

  assert.deepEqual(
    calls.filter((args) => args[0] === 'preview').map((args) => args.at(-1)),
    PHASE_ONE_STACKS.map((stack) => stackRef(LOGIN, stack)),
  )
})

function teardownHarness(stackNames) {
  const calls = []
  const destroyed = []
  const identityChecks = []
  const messages = []

  return {
    calls,
    destroyed,
    identityChecks,
    messages,
    options: {
      async runPulumi(args) {
        calls.push([...args])
        if (args[0] === 'whoami') {
          return JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND })
        }
        if (args[0] === 'stack' && args[1] === 'ls') {
          return JSON.stringify(stackNames.map((name) => ({ name })))
        }
        return ''
      },
      stackRef,
      async assertGoogleIdentity() {
        identityChecks.push('checked')
      },
      async destroyAndRemove(stack) {
        destroyed.push(stack)
      },
      log(message) {
        messages.push(message)
      },
    },
  }
}

test('staging dry-run plans numeric previews first without mutation', async () => {
  const harness = teardownHarness([
    `${LOGIN}/${PROJECT}/pr-10`,
    `${LOGIN}/${PROJECT}/pr-2`,
    `${LOGIN}/${PROJECT}/pr-0`,
    `${LOGIN}/${PROJECT}/pr-one`,
    `other-user/${PROJECT}/pr-1`,
    `${LOGIN}/other-project/pr-3`,
    `${LOGIN}/${PROJECT}/production`,
  ])

  const plan = await destroyEnvironment({
    argv: ['--environment', 'staging'],
    ...harness.options,
  })

  assert.deepEqual(plan, [
    stackRef(LOGIN, 'pr-2'),
    stackRef(LOGIN, 'pr-10'),
    stackRef(LOGIN, 'staging'),
    stackRef(LOGIN, 'staging-edge'),
  ])
  assert.deepEqual(harness.destroyed, [])
  assert.deepEqual(harness.identityChecks, [])
  assert.deepEqual(harness.calls[1], [
    'stack',
    'ls',
    '--json',
    '--fully-qualify-stack-names',
  ])
  assert.deepEqual(harness.messages, [
    'ENVIRONMENT TEARDOWN PLAN:',
    ...plan,
    'DRY RUN: pass --apply to execute',
  ])
})

test('staging apply destroys numeric previews, staging, then staging-edge', async () => {
  const harness = teardownHarness([
    `${LOGIN}/${PROJECT}/pr-11`,
    `${LOGIN}/${PROJECT}/pr-3`,
  ])

  await destroyEnvironment({
    argv: ['--environment', 'staging', '--apply'],
    ...harness.options,
  })

  assert.deepEqual(harness.identityChecks, ['checked'])
  assert.deepEqual(harness.destroyed, [
    stackRef(LOGIN, 'pr-3'),
    stackRef(LOGIN, 'pr-11'),
    stackRef(LOGIN, 'staging'),
    stackRef(LOGIN, 'staging-edge'),
  ])
})

test('production apply destroys production then production-edge only', async () => {
  const harness = teardownHarness([])

  await destroyEnvironment({
    argv: ['--environment', 'production', '--apply'],
    ...harness.options,
  })

  assert.deepEqual(harness.destroyed, [
    stackRef(LOGIN, 'production'),
    stackRef(LOGIN, 'production-edge'),
  ])
  assert.equal(
    harness.destroyed.some((stack) => /foundation|delivery/u.test(stack)),
    false,
  )
})

for (const argv of [
  [],
  ['--environment', 'foundation'],
  ['--environment', 'staging', '--unknown'],
]) {
  test(`environment teardown refuses invalid invocation ${JSON.stringify(argv)}`, async () => {
    const harness = teardownHarness([])

    await assert.rejects(
      destroyEnvironment({ argv, ...harness.options }),
      /environment must be exactly staging or production/,
    )
    assert.deepEqual(harness.calls, [])
    assert.deepEqual(harness.destroyed, [])
  })
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function stackUrn(stack, type, name) {
  return `urn:pulumi:${stack}::windrun-ai::${type}::${name}`
}

function platformStackState(stack, resources = []) {
  return {
    version: 3,
    deployment: {
      manifest: {},
      pending_operations: [],
      resources: [
        {
          urn: stackUrn(
            stack,
            'pulumi:pulumi:Stack',
            `windrun-ai-${stack}`,
          ),
          type: 'pulumi:pulumi:Stack',
          custom: false,
          inputs: {},
          outputs: {},
        },
        ...resources,
      ],
    },
  }
}

function platformResource(stack, type, name, inputs, protect = true) {
  const isProject = type === 'gcp:organizations/project:Project'
  const resource = {
    urn: stackUrn(stack, type, name),
    type,
    custom: true,
    id: isProject ? `projects/${inputs.projectId}` : `${name}-id`,
    inputs: cloneJson(inputs),
    outputs: cloneJson(inputs),
  }
  if (protect) resource.protect = true
  return resource
}

function normalFoundationState() {
  return platformStackState('foundation', [
    ...PROJECT_IDS.map((projectId) =>
      platformResource(
        'foundation',
        'gcp:organizations/project:Project',
        projectId,
        { projectId, deletionPolicy: 'PREVENT' },
      ),
    ),
    platformResource(
      'foundation',
      'gcp:dns/managedZone:ManagedZone',
      'shared-zone',
      { project: PROJECT_IDS[0], name: 'app-windrun-ai' },
    ),
  ])
}

function transitionedFoundationState() {
  const state = normalFoundationState()
  for (const resource of state.deployment.resources) {
    if (resource.type === 'pulumi:pulumi:Stack') continue
    delete resource.protect
    if (resource.type === 'gcp:organizations/project:Project') {
      resource.inputs.deletionPolicy = 'DELETE'
      resource.outputs.deletionPolicy = 'DELETE'
    }
  }
  return state
}

function foundationTransitionPreview(state = normalFoundationState()) {
  const steps = state.deployment.resources.map((resource) => {
    const oldState = cloneJson(resource)
    const newState = cloneJson(resource)
    const isRoot = resource.type === 'pulumi:pulumi:Stack'
    const isProject =
      resource.type === 'gcp:organizations/project:Project'
    if (!isRoot) delete newState.protect
    if (isProject) {
      newState.inputs.deletionPolicy = 'DELETE'
      newState.outputs.deletionPolicy = 'DELETE'
    }
    return {
      op: isProject ? 'update' : 'same',
      urn: resource.urn,
      oldState,
      newState,
      diffReasons: isProject ? ['deletionPolicy'] : [],
      detailedDiff: isProject
        ? {
            deletionPolicy: {
              kind: 'update',
              inputDiff: true,
            },
          }
        : {},
    }
  })
  return `${JSON.stringify({
    steps,
    diagnostics: [],
    changeSummary: {
      same: state.deployment.resources.length - 3,
      update: 3,
    },
    maybeCorrupt: false,
  })}\n`
}

function createPlatformHarness() {
  const refs = Object.fromEntries(
    [
      'pr-10',
      'pr-2',
      'staging',
      'production',
      'staging-edge',
      'production-edge',
      'delivery',
      'foundation',
    ].map((stack) => [stack, stackRef(LOGIN, stack)]),
  )
  const stackStates = new Map([
    [
      refs['pr-10'],
      platformStackState('pr-10', [
        platformResource(
          'pr-10',
          'gcp:cloudrunv2/service:Service',
          'preview-10',
          { name: 'preview-10' },
          false,
        ),
      ]),
    ],
    [
      refs['pr-2'],
      platformStackState('pr-2', [
        platformResource(
          'pr-2',
          'gcp:cloudrunv2/service:Service',
          'preview-2',
          { name: 'preview-2' },
          false,
        ),
      ]),
    ],
    ...[
      'staging',
      'production',
      'staging-edge',
      'production-edge',
    ].map((stack) => [
      refs[stack],
      platformStackState(stack, [
        platformResource(
          stack,
          'gcp:cloudrunv2/service:Service',
          `${stack}-service`,
          { name: `${stack}-service` },
          false,
        ),
      ]),
    ]),
    [
      refs.delivery,
      platformStackState('delivery', [
        platformResource(
          'delivery',
          'github:index/actionsVariable:ActionsVariable',
          'ci-enabled',
          { variableName: 'PULUMI_CI_ENABLED', value: 'true' },
          false,
        ),
      ]),
    ],
    [refs.foundation, normalFoundationState()],
  ])
  const controls = {
    keepAfterDestroy: new Set(),
    transitionPreview: undefined,
    transitionState: transitionedFoundationState(),
    recoveryState: normalFoundationState(),
    googleIdentityFailureAt: undefined,
    updateInProgress: new Map(),
    afterDeliveryDisableUp: undefined,
    afterFoundationDestroy: undefined,
    unknownAt: undefined,
    githubStatus:
      'github.com\n  ✓ Logged in to github.com account rohanprabhu\n  - Active account: true\n',
  }
  const calls = []
  const events = []
  const logs = []
  const stdout = []
  const stderr = []
  const providerEnvironmentRefs = []
  const providerEnvironmentSnapshots = []
  let foundationConfigValue = 'false'
  let foundationUpCount = 0
  let googleIdentityChecks = 0

  function recordPulumi(args, options, boundary) {
    const environmentSnapshot = { ...(options.env || {}) }
    calls.push({
      boundary,
      command: 'pulumi',
      args: [...args],
      environment: environmentSnapshot,
    })
    events.push(`pulumi:${args.join(' ')}`)
    if (
      environmentSnapshot.PULUMI_ACCESS_TOKEN === PULUMI_TOKEN &&
      environmentSnapshot.GITHUB_TOKEN === GITHUB_TOKEN
    ) {
      providerEnvironmentRefs.push(options.env)
      providerEnvironmentSnapshots.push(environmentSnapshot)
    }
  }

  async function handlePulumi(args, options = {}, boundary) {
    recordPulumi(args, options, boundary)
    if (controls.unknownAt === args.join(' ')) {
      throw new PulumiMutationStateUnknownError()
    }
    if (args[0] === 'whoami') {
      return {
        stdout: JSON.stringify({ user: LOGIN, url: MANAGED_APP_BACKEND }),
        stderr: '',
      }
    }
    if (args[0] === 'stack' && args[1] === 'ls') {
      return {
        stdout: JSON.stringify(
          [...stackStates.keys()].map((name) => {
            const entry = { name }
            if (controls.updateInProgress.has(name)) {
              entry.updateInProgress =
                controls.updateInProgress.get(name)
            }
            return entry
          }),
        ),
        stderr: '',
      }
    }
    if (args[0] === 'stack' && args[1] === 'export') {
      const state = stackStates.get(args.at(-1))
      if (!state) throw new Error('stack not found')
      return { stdout: JSON.stringify(state), stderr: '' }
    }
    if (args[0] === 'config' && args[1] === 'set') {
      if (args[2] === 'windrun-ai:allowProjectDeletion') {
        foundationConfigValue = args[3]
        events.push(`foundation-config:${args[3]}`)
      }
      if (args[2] === 'windrun-ai:enablePulumiGithubOidc') {
        events.push(`delivery-config:${args[3]}`)
      }
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'preview' && args.at(-1) === refs.foundation) {
      const output =
        foundationConfigValue === 'true'
          ? controls.transitionPreview ||
            foundationTransitionPreview(stackStates.get(refs.foundation))
          : `${JSON.stringify({
              steps: [],
              diagnostics: [],
              changeSummary: {},
              maybeCorrupt: false,
            })}\n`
      return { stdout: output, stderr: '' }
    }
    if (args[0] === 'up' && args.at(-1) === refs.foundation) {
      foundationUpCount += 1
      stackStates.set(
        refs.foundation,
        cloneJson(
          foundationConfigValue === 'true'
            ? controls.transitionState
            : controls.recoveryState,
        ),
      )
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'destroy') {
      const reference = args.at(-1)
      events.push(`destroy:${reference}`)
      if (!controls.keepAfterDestroy.has(reference)) {
        stackStates.delete(reference)
      }
      if (
        reference === refs.foundation &&
        controls.afterFoundationDestroy
      ) {
        await controls.afterFoundationDestroy({
          controls,
          refs,
          stackStates,
        })
      }
      const isDelivery = reference === refs.delivery
      return {
        stdout: isDelivery
          ? `provider output ${PULUMI_TOKEN} ${GITHUB_TOKEN}\n`
          : '',
        stderr: isDelivery
          ? `provider warning ${GITHUB_TOKEN} ${PULUMI_TOKEN}\n`
          : '',
      }
    }
    if (
      (args[0] === 'preview' || args[0] === 'up') &&
      args.at(-1) === refs.delivery
    ) {
      if (args[0] === 'up' && controls.afterDeliveryDisableUp) {
        await controls.afterDeliveryDisableUp({
          controls,
          refs,
          stackStates,
        })
      }
      return {
        stdout: `provider output ${PULUMI_TOKEN} ${GITHUB_TOKEN}\n`,
        stderr: `provider warning ${GITHUB_TOKEN} ${PULUMI_TOKEN}\n`,
      }
    }
    return { stdout: '', stderr: '' }
  }

  const dependencies = {
    async runPulumi(args, options = {}) {
      return (await handlePulumi(args, options, 'runPulumi')).stdout
    },
    async runLifecycleCommand(command, args, options = {}) {
      if (command === 'pulumi') {
        return handlePulumi(args, options, 'runLifecycleCommand')
      }
      calls.push({
        boundary: 'runLifecycleCommand',
        command,
        args: [...args],
        environment: { ...(options.env || {}) },
      })
      events.push(`${command}:${args.join(' ')}`)
      if (command === 'gh' && args[1] === 'status') {
        return {
          stdout: controls.githubStatus,
          stderr: '',
        }
      }
      if (command === 'gh' && args[1] === 'token') {
        return { stdout: `${GITHUB_TOKEN}\n`, stderr: '' }
      }
      throw new Error('unexpected lifecycle command')
    },
    async runPnpmScript(script) {
      events.push(`pnpm:${script}`)
    },
    async assertGoogleIdentity() {
      googleIdentityChecks += 1
      events.push(`google-identity:${googleIdentityChecks}`)
      if (controls.googleIdentityFailureAt === googleIdentityChecks) {
        throw new Error('Google identity rejected')
      }
    },
    async readFile(path) {
      events.push(`read:${path}`)
      return JSON.stringify({
        current: MANAGED_BACKEND,
        accounts: {
          [MANAGED_BACKEND]: { accessToken: PULUMI_TOKEN },
        },
      })
    },
    environment: {
      PATH: process.env.PATH,
      PULUMI_CREDENTIALS_PATH: '/pulumi',
      PULUMI_ACCESS_TOKEN: 'ambient-pulumi-token',
      GITHUB_TOKEN: 'ambient-github-token',
      GH_TOKEN: 'ambient-gh-token',
      PULUMI_ENABLE_STREAMING_JSON_PREVIEW: 'true',
    },
    log(message) {
      logs.push(message)
    },
    writeStdout(value) {
      stdout.push(value)
    },
    writeStderr(value) {
      stderr.push(value)
    },
  }

  return {
    calls,
    controls,
    dependencies,
    events,
    get foundationUpCount() {
      return foundationUpCount
    },
    logs,
    providerEnvironmentRefs,
    providerEnvironmentSnapshots,
    refs,
    stackStates,
    stderr,
    stdout,
  }
}

async function executeFullPlatformDestroy(harness) {
  return destroyPlatform({
    argv: ['--destroy-projects'],
    ...harness.dependencies,
  })
}

test('direct full teardown refusal exits two exactly without running a process', () => {
  const root = mkdtempSync(join(tmpdir(), 'windrun-destroy-refusal-'))
  const bin = join(root, 'bin')
  const logPath = join(root, 'pulumi.log')
  const pulumiPath = join(bin, 'pulumi')

  try {
    mkdirSync(bin)
    writeFileSync(logPath, '')
    writeExecutable(
      pulumiPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.PULUMI_FAKE_LOG, 'called\\n')
`,
    )
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./destroy-platform.mjs', import.meta.url))],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PULUMI_BIN: pulumiPath,
          PULUMI_FAKE_LOG: logPath,
        },
      },
    )

    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `${PLATFORM_REFUSAL}\n`)
    assert.equal(readFileSync(logPath, 'utf8'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('full teardown enforces exact stack, CI-disable, identity, and foundation order', async () => {
  const harness = createPlatformHarness()

  await executeFullPlatformDestroy(harness)

  assert.deepEqual(
    harness.events
      .filter((event) => event.startsWith('destroy:'))
      .map((event) => event.slice(event.lastIndexOf('/') + 1)),
    [
      'pr-2',
      'pr-10',
      'staging',
      'production',
      'staging-edge',
      'production-edge',
      'delivery',
      'foundation',
    ],
  )

  const contractIndex = harness.events.indexOf(
    'pnpm:ci:validate-contract',
  )
  const qualityIndex = harness.events.indexOf('pnpm:ci:quality')
  const deliveryConfigIndex = harness.events.indexOf(
    'delivery-config:false',
  )
  const deliveryPreviewIndex = harness.events.indexOf(
    `pulumi:preview --stack ${harness.refs.delivery}`,
  )
  const deliveryUpIndex = harness.events.indexOf(
    `pulumi:up --yes --stack ${harness.refs.delivery}`,
  )
  const deliveryDestroyIndex = harness.events.indexOf(
    `destroy:${harness.refs.delivery}`,
  )
  const firstGoogleIdentityIndex = harness.events.indexOf(
    'google-identity:1',
  )
  const googleIdentityIndex = harness.events.indexOf('google-identity:2')
  const firstDestroyIndex = harness.events.findIndex((event) =>
    event.startsWith('destroy:'),
  )
  const finalInventoryIndex = harness.events.findIndex(
    (event, index) =>
      index > deliveryDestroyIndex &&
      event ===
        'pulumi:stack ls --json --fully-qualify-stack-names',
  )
  const foundationConfigIndex = harness.events.indexOf(
    'foundation-config:true',
  )
  const foundationPreviewIndex = harness.events.indexOf(
    `pulumi:preview --json --diff --suppress-outputs --stack ${harness.refs.foundation}`,
  )
  const foundationUpIndex = harness.events.indexOf(
    `pulumi:up --yes --stack ${harness.refs.foundation}`,
  )
  assert.ok(contractIndex >= 0)
  assert.ok(contractIndex < qualityIndex)
  assert.ok(qualityIndex < deliveryConfigIndex)
  assert.ok(deliveryConfigIndex < deliveryPreviewIndex)
  assert.ok(deliveryPreviewIndex < deliveryUpIndex)
  assert.ok(deliveryUpIndex < deliveryDestroyIndex)
  assert.ok(firstGoogleIdentityIndex >= 0)
  assert.ok(firstGoogleIdentityIndex < firstDestroyIndex)
  assert.ok(deliveryDestroyIndex < googleIdentityIndex)
  assert.ok(googleIdentityIndex < finalInventoryIndex)
  assert.ok(finalInventoryIndex < foundationConfigIndex)
  assert.ok(foundationConfigIndex < foundationPreviewIndex)
  assert.ok(foundationPreviewIndex < foundationUpIndex)

  const listCalls = harness.calls.filter(
    ({ command, args }) =>
      command === 'pulumi' && args[0] === 'stack' && args[1] === 'ls',
  )
  assert.ok(listCalls.length >= 3)
  assert.deepEqual(
    listCalls.map(({ args }) => args),
    listCalls.map(() => [
      'stack',
      'ls',
      '--json',
      '--fully-qualify-stack-names',
    ]),
  )
  assert.ok(deliveryDestroyIndex < finalInventoryIndex)

  assert.equal(harness.providerEnvironmentSnapshots.length, 3)
  assert.equal(
    harness.providerEnvironmentSnapshots.every(
      (environment) =>
        environment.PULUMI_ACCESS_TOKEN === PULUMI_TOKEN &&
        environment.GITHUB_TOKEN === GITHUB_TOKEN,
    ),
    true,
  )
  assert.equal(
    harness.providerEnvironmentRefs.every(
      (environment) =>
        !('PULUMI_ACCESS_TOKEN' in environment) &&
        !('GITHUB_TOKEN' in environment),
    ),
    true,
  )
  const nonProviderCalls = harness.calls.filter(
    ({ environment }) =>
      environment.PULUMI_ACCESS_TOKEN !== PULUMI_TOKEN &&
      environment.GITHUB_TOKEN !== GITHUB_TOKEN,
  )
  assert.equal(
    nonProviderCalls.every(
      ({ environment }) =>
        !('PULUMI_ACCESS_TOKEN' in environment) &&
        !('GITHUB_TOKEN' in environment) &&
        !('GH_TOKEN' in environment) &&
        !('PULUMI_ENABLE_STREAMING_JSON_PREVIEW' in environment),
    ),
    true,
  )
  const observable = JSON.stringify({
    calls: harness.calls.map(({ command, args }) => ({ command, args })),
    logs: harness.logs,
    stderr: harness.stderr,
    stdout: harness.stdout,
  })
  assert.doesNotMatch(observable, new RegExp(PULUMI_TOKEN, 'u'))
  assert.doesNotMatch(observable, new RegExp(GITHUB_TOKEN, 'u'))
  assert.match(harness.stdout.join(''), /\[credential\]/u)
  assert.match(harness.logs.at(-1), /DELETE_REQUESTED/u)
  assert.match(harness.logs.at(-1), /30-day recovery window/u)
  assert.match(harness.logs.at(-1), /permanently unavailable/u)
})

test('full teardown accepts canonical Pulumi v3.244 checkpoint and PreviewDigest JSON', async () => {
  const harness = createPlatformHarness()
  harness.stackStates.set(
    harness.refs.foundation,
    JSON.parse(CANONICAL_FOUNDATION_CHECKPOINT),
  )
  harness.controls.transitionPreview = CANONICAL_FOUNDATION_PREVIEW

  const result = await executeFullPlatformDestroy(harness)

  assert.equal(result.status, 'DELETE_REQUESTED')
})

test('full teardown accepts omitted safe digest fields and null same-step diffs', async () => {
  const harness = createPlatformHarness()
  const preview = JSON.parse(foundationTransitionPreview())
  delete preview.diagnostics
  delete preview.maybeCorrupt
  for (const step of preview.steps) {
    if (step.op === 'same') step.detailedDiff = null
  }
  const root = preview.steps.find(
    ({ oldState }) => oldState.type === 'pulumi:pulumi:Stack',
  )
  delete root.oldState.inputs
  delete root.oldState.outputs
  delete root.newState.inputs
  delete root.newState.outputs
  harness.controls.transitionPreview = JSON.stringify(preview)

  const result = await executeFullPlatformDestroy(harness)

  assert.equal(result.status, 'DELETE_REQUESTED')
})

test('full teardown rejects malformed present digest fields', async () => {
  for (const mutate of [
    (preview) => {
      preview.maybeCorrupt = null
    },
    (preview) => {
      preview.diagnostics = null
    },
    (preview) => {
      preview.steps.find(({ op }) => op === 'same').detailedDiff = 'bad'
    },
  ]) {
    const harness = createPlatformHarness()
    const preview = JSON.parse(foundationTransitionPreview())
    mutate(preview)
    harness.controls.transitionPreview = JSON.stringify(preview)

    await assert.rejects(
      executeFullPlatformDestroy(harness),
      /foundation preview/,
    )
    assert.equal(harness.foundationUpCount, 0)
  }
})

test('full teardown rejects active or malformed stack updates before mutation', async () => {
  for (const updateInProgress of [true, 'true']) {
    const harness = createPlatformHarness()
    harness.stackStates.set(
      harness.refs.production,
      platformStackState('production'),
    )
    harness.controls.updateInProgress.set(
      harness.refs.production,
      updateInProgress,
    )

    await assert.rejects(
      executeFullPlatformDestroy(harness),
      /production.*updateInProgress/,
    )
    assert.equal(
      harness.events.some((event) => event.startsWith('destroy:')),
      false,
    )
  }
})

test('full teardown accepts explicit updateInProgress false', async () => {
  const harness = createPlatformHarness()
  for (const reference of harness.stackStates.keys()) {
    harness.controls.updateInProgress.set(reference, false)
  }

  const result = await executeFullPlatformDestroy(harness)

  assert.equal(result.status, 'DELETE_REQUESTED')
})

test('full teardown closes the app gate after delivery disable and before delivery destroy', async () => {
  const harness = createPlatformHarness()
  harness.controls.afterDeliveryDisableUp = ({ refs, stackStates }) => {
    stackStates.set(
      refs.production,
      platformStackState('production', [
        platformResource(
          'production',
          'gcp:cloudrunv2/service:Service',
          'late-production',
          { name: 'late-production' },
          false,
        ),
      ]),
    )
  }

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /production still contains non-root resources/,
  )

  assert.equal(
    harness.events.includes(`destroy:${harness.refs.delivery}`),
    false,
  )
  assert.equal(
    harness.providerEnvironmentRefs.every(
      (environment) =>
        !('PULUMI_ACCESS_TOKEN' in environment) &&
        !('GITHUB_TOKEN' in environment),
    ),
    true,
  )
})

test('full teardown rejects a root-only active update after delivery disable', async () => {
  const harness = createPlatformHarness()
  harness.controls.afterDeliveryDisableUp = ({
    controls,
    refs,
    stackStates,
  }) => {
    stackStates.set(
      refs['production-edge'],
      platformStackState('production-edge'),
    )
    controls.updateInProgress.set(refs['production-edge'], true)
  }

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /production-edge.*updateInProgress/,
  )
  assert.equal(
    harness.events.includes(`destroy:${harness.refs.delivery}`),
    false,
  )
})

test('full teardown validates provider-bound project identity before transition', async () => {
  const harness = createPlatformHarness()
  const project = harness.stackStates
    .get(harness.refs.foundation)
    .deployment.resources.find(
      ({ type }) => type === 'gcp:organizations/project:Project',
    )
  project.id = 'unexpected-project'
  project.outputs.projectId = 'unexpected-project'

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation pre-transition state has unexpected project state/,
  )
  assert.equal(harness.events.includes('foundation-config:true'), false)
})

test('full teardown carries project identity through the transition preview', async () => {
  const harness = createPlatformHarness()
  const preview = JSON.parse(foundationTransitionPreview())
  const projectStep = preview.steps.find(
    ({ oldState }) =>
      oldState.type === 'gcp:organizations/project:Project',
  )
  projectStep.newState.id = 'unexpected-project'
  harness.controls.transitionPreview = JSON.stringify(preview)

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation preview contained an unexpected project identity/,
  )
  assert.equal(harness.foundationUpCount, 0)
})

test('full teardown final gate rejects a recreated earlier stack', async () => {
  const harness = createPlatformHarness()
  harness.controls.afterFoundationDestroy = ({ refs, stackStates }) => {
    stackStates.set(
      refs.staging,
      platformStackState('staging', [
        platformResource(
          'staging',
          'gcp:cloudrunv2/service:Service',
          'late-staging',
          { name: 'late-staging' },
          false,
        ),
      ]),
    )
  }

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /staging still contains non-root resources/,
  )
  assert.equal(
    harness.logs.some((message) => message.includes('DELETE_REQUESTED')),
    false,
  )
  assert.equal(harness.foundationUpCount, 1)
  assert.equal(
    harness.events.some(
      (event) => event === 'foundation-config:false',
    ),
    false,
  )
})

test('full teardown requires foundation absence after destroy --remove', async () => {
  const harness = createPlatformHarness()
  harness.controls.afterFoundationDestroy = ({ refs, stackStates }) => {
    stackStates.set(refs.foundation, platformStackState('foundation'))
  }

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation stack still exists after destroy --remove/,
  )
  assert.equal(
    harness.logs.some((message) => message.includes('DELETE_REQUESTED')),
    false,
  )
  assert.equal(harness.foundationUpCount, 1)
  assert.equal(
    harness.events.some(
      (event) => event === 'foundation-config:false',
    ),
    false,
  )
})

test('wrong Google identity causes zero Pulumi mutation', async () => {
  const harness = createPlatformHarness()
  harness.controls.googleIdentityFailureAt = 1

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /Google identity verification failed/,
  )

  const mutatingPulumiCalls = harness.calls.filter(
    ({ command, args }) =>
      command === 'pulumi' &&
      (args[0] === 'destroy' ||
        args[0] === 'up' ||
        (args[0] === 'config' && args[1] === 'set')),
  )
  assert.deepEqual(mutatingPulumiCalls, [])
})

test('full teardown refuses ambiguous active GitHub credentials', async () => {
  const harness = createPlatformHarness()
  harness.controls.githubStatus =
    'github.com\n  ✓ Logged in to github.com account rohanprabhu\n  - Active account: true\n  ✓ Logged in to github.com account attacker\n  - Active account: true\n'

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /active GitHub login must be exactly rohanprabhu/,
  )

  assert.equal(harness.events.includes('delivery-config:false'), false)
  assert.deepEqual(harness.providerEnvironmentSnapshots, [])
})

test('full teardown refuses delivery while an earlier stack retains resources', async () => {
  const harness = createPlatformHarness()
  harness.controls.keepAfterDestroy.add(harness.refs.production)

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /production still contains non-root resources/,
  )

  assert.equal(
    harness.events.some((event) => event === 'pnpm:ci:quality'),
    false,
  )
  assert.deepEqual(
    harness.events.filter((event) =>
      event.startsWith('google-identity:'),
    ),
    ['google-identity:1'],
  )
  assert.equal(
    harness.events.some((event) => event === 'foundation-config:true'),
    false,
  )
})

test('full teardown refuses foundation while delivery retains resources', async () => {
  const harness = createPlatformHarness()
  harness.controls.keepAfterDestroy.add(harness.refs.delivery)

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /delivery still contains non-root resources/,
  )

  assert.deepEqual(
    harness.events.filter((event) =>
      event.startsWith('google-identity:'),
    ),
    ['google-identity:1', 'google-identity:2'],
  )
  assert.equal(
    harness.events.some((event) => event === 'foundation-config:true'),
    false,
  )
  assert.equal(
    harness.providerEnvironmentRefs.every(
      (environment) =>
        !('PULUMI_ACCESS_TOKEN' in environment) &&
        !('GITHUB_TOKEN' in environment),
    ),
    true,
  )
})

test('full teardown rejects an unexpected foundation preview before up', async () => {
  const harness = createPlatformHarness()
  harness.controls.transitionPreview = `${JSON.stringify({
    steps: [
      {
        op: 'delete',
        urn: stackUrn(
          'foundation',
          'gcp:dns/managedZone:ManagedZone',
          'shared-zone',
        ),
        oldState: {},
      },
    ],
    diagnostics: [],
    changeSummary: { delete: 1 },
    maybeCorrupt: false,
  })}\n`

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation preview/,
  )

  assert.deepEqual(
    harness.events.filter((event) =>
      event.startsWith('foundation-config:'),
    ),
    ['foundation-config:true', 'foundation-config:false'],
  )
  assert.equal(harness.foundationUpCount, 0)
  assert.equal(
    harness.events.includes(`destroy:${harness.refs.foundation}`),
    false,
  )
})

test('full teardown rejects malformed checkpoint flags before foundation mutation', async () => {
  const harness = createPlatformHarness()
  harness.stackStates.get(harness.refs.foundation)
    .deployment.resources.at(-1).delete = 'unexpected'

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation pre-transition state stack export contains unsafe resource state/,
  )

  assert.equal(
    harness.events.includes('foundation-config:true'),
    false,
  )
  assert.equal(
    harness.events.includes(`destroy:${harness.refs.foundation}`),
    false,
  )
})

test('full teardown rejects malformed checkpoint collection fields', async () => {
  const harness = createPlatformHarness()
  harness.stackStates.get(harness.refs.foundation)
    .deployment.resources.at(-1).initErrors = ''

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation pre-transition state stack export contains unsafe resource state/,
  )

  assert.equal(harness.events.includes('foundation-config:true'), false)
})

test('full teardown rejects unsafe flags in the transition preview', async () => {
  const harness = createPlatformHarness()
  const preview = JSON.parse(foundationTransitionPreview())
  preview.steps.at(-1).newState.taint = true
  harness.controls.transitionPreview = JSON.stringify(preview)

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation preview contains unsafe resource state/,
  )

  assert.equal(harness.foundationUpCount, 0)
})

test('full teardown restores protection when transition state verification fails', async () => {
  const harness = createPlatformHarness()
  const invalidTransition = transitionedFoundationState()
  invalidTransition.deployment.resources.at(-1).protect = true
  harness.controls.transitionState = invalidTransition

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation transition state is not safely destroyable/,
  )

  assert.deepEqual(
    harness.events.filter((event) =>
      event.startsWith('foundation-config:'),
    ),
    ['foundation-config:true', 'foundation-config:false'],
  )
  assert.equal(harness.foundationUpCount, 2)
  assert.deepEqual(
    harness.events.filter((event) =>
      event.startsWith('google-identity:'),
    ),
    ['google-identity:1', 'google-identity:2', 'google-identity:3'],
  )
  assert.equal(
    harness.events.includes(`destroy:${harness.refs.foundation}`),
    false,
  )
  const restored = harness.stackStates.get(harness.refs.foundation)
  assert.equal(
    restored.deployment.resources
      .filter(({ type }) => type !== 'pulumi:pulumi:Stack')
      .every(({ protect }) => protect === true),
    true,
  )
  assert.deepEqual(
    restored.deployment.resources
      .filter(
        ({ type }) => type === 'gcp:organizations/project:Project',
      )
      .map(({ inputs }) => inputs.deletionPolicy),
    ['PREVENT', 'PREVENT', 'PREVENT'],
  )
})

test('full teardown preserves primary and recovery verification failures', async () => {
  const harness = createPlatformHarness()
  const invalidTransition = transitionedFoundationState()
  invalidTransition.deployment.resources.at(-1).protect = true
  harness.controls.transitionState = invalidTransition
  harness.controls.recoveryState = transitionedFoundationState()

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    /foundation transition state is not safely destroyable; foundation recovery failed: foundation recovery state/,
  )

  assert.equal(harness.foundationUpCount, 2)
})

test('full teardown never retries or recovers after an unknown Pulumi mutation', async () => {
  const harness = createPlatformHarness()
  harness.controls.unknownAt =
    `up --yes --stack ${harness.refs.foundation}`

  await assert.rejects(
    executeFullPlatformDestroy(harness),
    (error) => {
      assert.equal(error.code, 'PULUMI_MUTATION_STATE_UNKNOWN')
      return true
    },
  )

  const unknownIndex = harness.events.indexOf(
    `pulumi:${harness.controls.unknownAt}`,
  )
  assert.ok(unknownIndex >= 0)
  assert.deepEqual(
    harness.events.slice(unknownIndex + 1).filter((event) =>
      event.startsWith('pulumi:') ||
      event.startsWith('foundation-config:') ||
      event.startsWith('google-identity:'),
    ),
    [],
  )
})

test('full teardown documentation records every destructive and recovery boundary', () => {
  const document = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'docs',
      'operations',
      'teardown.md',
    ),
    'utf8',
  )

  for (const text of [
    'destroy-environment.mjs --environment staging',
    'destroy-environment.mjs --environment production',
    'destroy-platform.mjs --destroy-projects',
    'all numeric `pr-*` stacks',
    '`staging`',
    '`production`',
    '`staging-edge`',
    '`production-edge`',
    '`delivery`',
    '`foundation`',
    'windrun-ai:enablePulumiGithubOidc=false',
    'windrun-ai:allowProjectDeletion=true',
    'protect:false',
    'deletionPolicy: DELETE',
    'DELETE_REQUESTED',
    '30-day recovery window',
    'permanently unavailable',
    'gcloud auth list --filter=status:ACTIVE --format=value(account)',
    'gcloud auth application-default print-access-token',
    'no mutating `gcloud`, `doctl`, or `gh`',
    'updateInProgress',
    '`foundation` stack is absent',
  ]) {
    assert.ok(document.includes(text), `missing teardown text: ${text}`)
  }
  assert.ok(document.indexOf('`delivery`') < document.indexOf('`foundation`'))
})

test('the shared library is the sole lifecycle process-spawning boundary', () => {
  const operationsDirectory = resolve(
    dirname(new URL(import.meta.url).pathname),
  )
  const productionFiles = [
    'enable-ci-after-claim.mjs',
    'bootstrap-platform.mjs',
    'destroy-environment.mjs',
    'destroy-platform.mjs',
  ]
  for (const file of productionFiles) {
    const source = readFileSync(resolve(operationsDirectory, file), 'utf8')
    assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|execSync/u)
  }
  const library = readFileSync(
    resolve(operationsDirectory, 'lib', 'pulumi.mjs'),
    'utf8',
  )
  assert.match(library, /node:child_process/u)
})

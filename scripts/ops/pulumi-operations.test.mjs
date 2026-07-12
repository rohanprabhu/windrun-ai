import assert from 'node:assert/strict'
import {
  chmodSync,
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

import {
  createPulumiOperations,
  stackRef,
} from './lib/pulumi.mjs'
import { bootstrapPlatform, PHASE_ONE_STACKS } from './bootstrap-platform.mjs'
import { destroyEnvironment } from './destroy-environment.mjs'

const LOGIN = 'bootstrap-user'
const PROJECT = 'windrun-ai'
const OWNER_EMAIL = 'rohan@windrun.ai'
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'

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
        stdout: `${JSON.stringify({ user: LOGIN, url: 'https://api.pulumi.com' })}\n`,
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

function createOperations({
  harness = createProcessHarness(),
  fetchImpl = async () => ({
    ok: true,
    async json() {
      return { email: OWNER_EMAIL }
    },
  }),
  environment = { PATH: process.env.PATH, SAFE_ADC: 'inherited' },
  repositoryRoot = '/workspace/windrun-ai',
} = {}) {
  const operations = createPulumiOperations({
    processRunner: harness.processRunner,
    fetchImpl,
    environment,
    repositoryRoot,
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

  assert.deepEqual(harness.calls, [
    {
      executable: 'pulumi',
      args: ['preview', '--stack', 'org/windrun-ai/staging'],
      cwd: resolve('/workspace/windrun-ai', 'infra'),
      env: { PATH: process.env.PATH, SAFE_ADC: 'inherited' },
      capture: true,
    },
  ])
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

  assert.deepEqual(harness.calls[0].args, [
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
      return {
        ok: true,
        async json() {
          return { email: OWNER_EMAIL }
        },
      }
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
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { email: 'other@example.com' }
      },
    }),
  })
  await assert.rejects(
    wrongAdc.operations.assertExactGoogleIdentity(),
    /ADC identity must be exactly rohan@windrun\.ai/,
  )
})

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
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ user: LOGIN, url: 'https://api.pulumi.com' })}\n`)})
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
    assert.deepEqual(messages, [
      'GOOGLE IDENTITY VERIFIED: rohan@windrun.ai',
      'BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bootstrap default previews all five stacks without applying or selecting delivery', async () => {
  const calls = []

  await bootstrapPlatform({
    argv: [],
    async runPulumi(args) {
      calls.push([...args])
      if (args[0] === 'whoami') {
        return JSON.stringify({ user: LOGIN, url: 'https://api.pulumi.com' })
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
  assert.equal(calls.some((args) => args[0] === 'up'), false)
  assert.equal(calls.some((args) => args.join(' ').includes('delivery')), false)
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
          return JSON.stringify({ user: LOGIN, url: 'https://api.pulumi.com' })
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

test('the shared library is the sole lifecycle process-spawning boundary', () => {
  const operationsDirectory = resolve(
    dirname(new URL(import.meta.url).pathname),
  )
  const productionFiles = [
    'enable-ci-after-claim.mjs',
    'bootstrap-platform.mjs',
    'destroy-environment.mjs',
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

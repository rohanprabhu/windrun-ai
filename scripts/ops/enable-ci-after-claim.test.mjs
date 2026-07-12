import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  enableCiAfterClaim,
  FOUNDATION_IDENTITY_OUTPUT_NAMES,
} from './enable-ci-after-claim.mjs'

const BACKEND = 'https://api.pulumi.com'
const LOGIN = 'claimed-user'
const APP_BACKEND = `https://app.pulumi.com/${LOGIN}`
const PULUMI_TOKEN = 'pul-secret-fixture'
const GITHUB_TOKEN = 'gh-secret-fixture'
const REPOSITORY_ROOT = '/workspace/windrun-ai'
const INFRA_ROOT = resolve(REPOSITORY_ROOT, 'infra')
const FOUNDATION_STACK = `${LOGIN}/windrun-ai/foundation`
const DELIVERY_STACK = `${LOGIN}/windrun-ai/delivery`

const EXPECTED_FOUNDATION_OUTPUT_NAMES = [
  'foundationWifProvider',
  'foundationDeployServiceAccount',
  'productionWifProvider',
  'productionDeployServiceAccount',
  'stagingWifProvider',
  'stagingDeployServiceAccount',
  'previewWifProvider',
  'previewDeployServiceAccount',
  'productionEdgeWifProvider',
  'productionEdgeDeployServiceAccount',
  'stagingEdgeWifProvider',
  'stagingEdgeDeployServiceAccount',
]

const VALID_CONFIRMATION = [
  '--confirm-claimed-by',
  'rohan@windrun.ai',
]

function commandText(command, args) {
  return [command, ...args].join(' ')
}

function requiredFoundationOutputs() {
  return Object.fromEntries(
    EXPECTED_FOUNDATION_OUTPUT_NAMES.map((name) => [name, `${name}-value`]),
  )
}

function activeGitHubStatus(login = 'rohanprabhu') {
  return `github.com
  ✓ Logged in to github.com account ${login} (keyring)
  - Active account: true
  - Git operations protocol: https
`
}

function createHarness({
  whoami = { user: LOGIN, url: BACKEND },
  credentials = {
    current: BACKEND,
    accounts: {
      [BACKEND]: { accessToken: PULUMI_TOKEN, username: LOGIN },
    },
    accessTokens: { [BACKEND]: PULUMI_TOKEN },
  },
  githubStatus = activeGitHubStatus(),
  githubToken = GITHUB_TOKEN,
  foundationOutputs = requiredFoundationOutputs(),
  failWhen,
} = {}) {
  const calls = []
  const logs = []
  const reads = []

  async function runCommand(command, args, options = {}) {
    calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      envReference: options.env,
      capture: options.capture,
    })

    if (failWhen?.(command, args)) {
      throw new Error(
        `child output contained ${PULUMI_TOKEN} and ${GITHUB_TOKEN}`,
      )
    }

    const text = commandText(command, args)
    if (text === 'pulumi whoami --json') {
      return { stdout: `${JSON.stringify(whoami)}\n`, stderr: '' }
    }
    if (text === 'gh auth status --hostname github.com') {
      return { stdout: '', stderr: githubStatus }
    }
    if (text === 'gh auth token --hostname github.com') {
      return { stdout: `${githubToken}\n`, stderr: '' }
    }
    if (text === `pulumi stack output --json --stack ${FOUNDATION_STACK}`) {
      return {
        stdout: `${JSON.stringify(foundationOutputs)}\n`,
        stderr: '',
      }
    }
    return { stdout: '', stderr: '' }
  }

  async function readFile(path) {
    reads.push(path)
    return JSON.stringify(credentials)
  }

  async function execute(argv = VALID_CONFIRMATION) {
    return enableCiAfterClaim({
      argv,
      runCommand,
      readFile,
      repositoryRoot: REPOSITORY_ROOT,
      environment: {
        HOME: '/home/operator',
        PULUMI_CREDENTIALS_PATH: '/pulumi/credentials',
        GH_TOKEN: 'ambient-gh-token-must-not-be-used',
        GITHUB_TOKEN: 'ambient-github-token-must-not-be-used',
        PULUMI_ACCESS_TOKEN: 'ambient-pulumi-token-must-not-be-used',
        SAFE_VALUE: 'preserved',
      },
      log(message) {
        logs.push(message)
      },
    })
  }

  return { calls, execute, logs, reads }
}

function assertNoDeliveryMutation(calls) {
  const mutations = calls.filter(({ command, args }) =>
    command === 'pnpm' ||
    (command === 'pulumi' &&
      (args[0] === 'preview' ||
        args[0] === 'up' ||
        args[0] === 'config' ||
        (args[0] === 'stack' && args[1] === 'select'))),
  )
  assert.deepEqual(mutations, [])
}

test('exports the exact twelve foundation identity outputs', () => {
  assert.deepEqual(
    [...FOUNDATION_IDENTITY_OUTPUT_NAMES],
    EXPECTED_FOUNDATION_OUTPUT_NAMES,
  )
})

for (const argv of [
  [],
  ['--confirm-claimed-by', 'someone@example.com'],
  [...VALID_CONFIRMATION, '--extra'],
]) {
  test(`refuses invalid confirmation ${JSON.stringify(argv)}`, async () => {
    const harness = createHarness()

    await assert.rejects(
      harness.execute(argv),
      /exactly --confirm-claimed-by rohan@windrun\.ai/,
    )
    assert.deepEqual(harness.calls, [])
    assert.deepEqual(harness.reads, [])
  })
}

test('refuses a non-managed Pulumi backend before reading credentials', async () => {
  const harness = createHarness({
    whoami: { user: LOGIN, url: 'file:///tmp/pulumi' },
  })

  await assert.rejects(
    harness.execute(),
    /Pulumi backend must be exactly https:\/\/api\.pulumi\.com/,
  )
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    ['pulumi whoami --json'],
  )
  assert.deepEqual(harness.reads, [])
})

test('accepts the managed Pulumi app identity URL', async () => {
  const harness = createHarness({
    whoami: { user: LOGIN, url: APP_BACKEND },
  })

  await harness.execute()

  assert.equal(
    harness.calls.some(
      ({ command, args }) =>
        command === 'pulumi' &&
        args.join(' ') === `preview --stack ${DELIVERY_STACK}`,
    ),
    true,
  )
})

test('refuses when local Pulumi credentials are not current for the managed backend', async () => {
  const harness = createHarness({
    credentials: {
      current: 'https://api.other.example',
      accessTokens: { [BACKEND]: PULUMI_TOKEN },
    },
  })

  await assert.rejects(
    harness.execute(),
    /Pulumi credentials must select https:\/\/api\.pulumi\.com/,
  )
  assertNoDeliveryMutation(harness.calls)
})

test('refuses an empty local Pulumi token', async () => {
  const harness = createHarness({
    credentials: {
      current: BACKEND,
      accounts: { [BACKEND]: { accessToken: '   ' } },
      accessTokens: { [BACKEND]: '' },
    },
  })

  await assert.rejects(harness.execute(), /Pulumi access token is empty/)
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    ['pulumi whoami --json'],
  )
  assertNoDeliveryMutation(harness.calls)
})

test('refuses a GitHub identity other than the active rohanprabhu account', async () => {
  const harness = createHarness({ githubStatus: activeGitHubStatus('other') })

  await assert.rejects(
    harness.execute(),
    /active GitHub login must be exactly rohanprabhu/,
  )
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    [
      'pulumi whoami --json',
      'gh auth status --hostname github.com',
    ],
  )
  assertNoDeliveryMutation(harness.calls)
})

test('refuses when rohanprabhu is present but another account is active', async () => {
  const harness = createHarness({
    githubStatus: `github.com
  ✓ Logged in to github.com account rohanprabhu (keyring)
  - Active account: false
  ✓ Logged in to github.com account another-user (keyring)
  - Active account: true
`,
  })

  await assert.rejects(
    harness.execute(),
    /active GitHub login must be exactly rohanprabhu/,
  )
  assertNoDeliveryMutation(harness.calls)
})

test('refuses when active rohanprabhu is followed by another active account', async () => {
  const harness = createHarness({
    githubStatus: `github.com
  ✓ Logged in to github.com account rohanprabhu (keyring)
  - Active account: true
  ✓ Logged in to github.com account another-user (keyring)
  - Active account: true
`,
  })

  await assert.rejects(
    harness.execute(),
    /active GitHub login must be exactly rohanprabhu/,
  )
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    [
      'pulumi whoami --json',
      'gh auth status --hostname github.com',
    ],
  )
  assertNoDeliveryMutation(harness.calls)
})

test('refuses an empty local GitHub token', async () => {
  const harness = createHarness({ githubToken: '  ' })

  await assert.rejects(harness.execute(), /GitHub token is empty/)
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    [
      'pulumi whoami --json',
      'gh auth status --hostname github.com',
      'gh auth token --hostname github.com',
    ],
  )
  assertNoDeliveryMutation(harness.calls)
})

for (const outputName of EXPECTED_FOUNDATION_OUTPUT_NAMES) {
  test(`refuses an empty foundation output ${outputName}`, async () => {
    const foundationOutputs = requiredFoundationOutputs()
    foundationOutputs[outputName] = ''
    const harness = createHarness({ foundationOutputs })

    await assert.rejects(
      harness.execute(),
      new RegExp(`foundation output ${outputName} must be a non-empty string`),
    )
    assertNoDeliveryMutation(harness.calls)
  })
}

test('runs the exact fail-closed delivery enablement order', async () => {
  const harness = createHarness()

  const result = await harness.execute()

  assert.deepEqual(result, {
    login: LOGIN,
    foundationStack: FOUNDATION_STACK,
    deliveryStack: DELIVERY_STACK,
  })
  assert.deepEqual(
    harness.calls.map(({ command, args }) => commandText(command, args)),
    [
      'pulumi whoami --json',
      'gh auth status --hostname github.com',
      'gh auth token --hostname github.com',
      `pulumi stack output --json --stack ${FOUNDATION_STACK}`,
      `pulumi stack select --create ${DELIVERY_STACK}`,
      `pulumi config set windrun-ai:stackKind delivery --stack ${DELIVERY_STACK}`,
      `pulumi config set windrun-ai:pulumiOrganization ${LOGIN} --stack ${DELIVERY_STACK}`,
      `pulumi config set windrun-ai:enablePulumiGithubOidc true --stack ${DELIVERY_STACK}`,
      `pulumi config set windrun-ai:productionCiEnabled true --stack ${DELIVERY_STACK}`,
      `pulumi config set windrun-ai:stagingCiEnabled true --stack ${DELIVERY_STACK}`,
      'pnpm ci:validate-contract',
      'pnpm ci:quality',
      `pulumi preview --stack ${DELIVERY_STACK}`,
      `pulumi up --yes --stack ${DELIVERY_STACK}`,
    ],
  )
  assert.deepEqual(
    harness.calls.map(({ cwd }) => cwd),
    [
      INFRA_ROOT,
      REPOSITORY_ROOT,
      REPOSITORY_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
      REPOSITORY_ROOT,
      REPOSITORY_ROOT,
      INFRA_ROOT,
      INFRA_ROOT,
    ],
  )
  assert.deepEqual(harness.reads, ['/pulumi/credentials/credentials.json'])
  assert.deepEqual(harness.logs, ['DELIVERY ENABLED; BOOTSTRAP COMPLETE'])

  const ghCalls = harness.calls.filter(({ command }) => command === 'gh')
  assert.deepEqual(
    ghCalls.map(({ args }) => args),
    [
      ['auth', 'status', '--hostname', 'github.com'],
      ['auth', 'token', '--hostname', 'github.com'],
    ],
  )

  const providerCalls = harness.calls.filter(
    ({ command, args }) =>
      command === 'pulumi' && (args[0] === 'preview' || args[0] === 'up'),
  )
  assert.equal(providerCalls.length, 2)
  for (const call of providerCalls) {
    assert.equal(call.cwd, INFRA_ROOT)
    assert.equal(call.env.PULUMI_ACCESS_TOKEN, PULUMI_TOKEN)
    assert.equal(call.env.GITHUB_TOKEN, GITHUB_TOKEN)
    assert.equal(call.env.SAFE_VALUE, 'preserved')
    assert.equal(call.env.GH_TOKEN, undefined)
    assert.equal(call.envReference.PULUMI_ACCESS_TOKEN, undefined)
    assert.equal(call.envReference.GITHUB_TOKEN, undefined)
  }

  for (const call of harness.calls.filter((call) => !providerCalls.includes(call))) {
    assert.equal(call.env.PULUMI_ACCESS_TOKEN, undefined)
    assert.equal(call.env.GITHUB_TOKEN, undefined)
    assert.equal(call.env.GH_TOKEN, undefined)
  }

  const pnpmCalls = harness.calls.filter(({ command }) => command === 'pnpm')
  assert.deepEqual(pnpmCalls.map(({ cwd }) => cwd), [
    REPOSITORY_ROOT,
    REPOSITORY_ROOT,
  ])
})

for (const failingCommand of [
  'pnpm ci:validate-contract',
  'pnpm ci:quality',
]) {
  test(`stops before preview when ${failingCommand} fails`, async () => {
    const harness = createHarness({
      failWhen(command, args) {
        return commandText(command, args) === failingCommand
      },
    })

    await assert.rejects(
      harness.execute(),
      new RegExp(`${failingCommand.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed`),
    )
    assert.equal(
      harness.calls.some(
        ({ command, args }) =>
          command === 'pulumi' && (args[0] === 'preview' || args[0] === 'up'),
      ),
      false,
    )
  })
}

test('redacts child output and tokens when provider execution fails', async () => {
  const harness = createHarness({
    failWhen(command, args) {
      return command === 'pulumi' && args[0] === 'preview'
    },
  })

  let error
  try {
    await harness.execute()
  } catch (candidate) {
    error = candidate
  }

  assert.equal(error?.message, 'pulumi preview failed')
  assert.doesNotMatch(error?.message ?? '', /pul-secret|gh-secret/)
  assert.doesNotMatch(JSON.stringify(harness.logs), /pul-secret|gh-secret/)
  assert.equal(
    harness.calls.some(
      ({ command, args }) => command === 'pulumi' && args[0] === 'up',
    ),
    false,
  )
  const previewCall = harness.calls.find(
    ({ command, args }) => command === 'pulumi' && args[0] === 'preview',
  )
  assert.equal(previewCall?.envReference.PULUMI_ACCESS_TOKEN, undefined)
  assert.equal(previewCall?.envReference.GITHUB_TOKEN, undefined)
})

function writeExecutable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

test('sanitizes token-shaped output from real child processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windrun-enable-ci-'))
  const bin = join(root, 'bin')
  const credentialsDirectory = join(root, 'credentials')
  const stdout = []
  const stderr = []

  try {
    mkdirSync(join(root, 'infra'), { recursive: true })
    mkdirSync(bin)
    mkdirSync(credentialsDirectory)
    writeFileSync(
      join(credentialsDirectory, 'credentials.json'),
      JSON.stringify({
        current: BACKEND,
        accessTokens: { [BACKEND]: PULUMI_TOKEN },
      }),
    )
    writeExecutable(
      join(bin, 'pulumi'),
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args === 'whoami --json') {
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ user: LOGIN, url: BACKEND })}\n`)})
} else if (args === 'stack output --json --stack ${FOUNDATION_STACK}') {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(requiredFoundationOutputs())}\n`)})
} else if (args.startsWith('preview ') || args.startsWith('up ')) {
  process.stdout.write('stdout:' + process.env.PULUMI_ACCESS_TOKEN + ':' + process.env.GITHUB_TOKEN + '\\n')
  process.stderr.write('stderr:' + process.env.GITHUB_TOKEN + ':' + process.env.PULUMI_ACCESS_TOKEN + '\\n')
}
`,
    )
    writeExecutable(
      join(bin, 'gh'),
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args === 'auth status --hostname github.com') {
  process.stderr.write(${JSON.stringify(activeGitHubStatus())})
} else if (args === 'auth token --hostname github.com') {
  process.stdout.write(${JSON.stringify(`${GITHUB_TOKEN}\n`)})
}
`,
    )
    writeExecutable(join(bin, 'pnpm'), '#!/usr/bin/env node\n')

    await enableCiAfterClaim({
      argv: VALID_CONFIRMATION,
      repositoryRoot: root,
      environment: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        PULUMI_CREDENTIALS_PATH: credentialsDirectory,
      },
      log() {},
      writeStdout(value) {
        stdout.push(value)
      },
      writeStderr(value) {
        stderr.push(value)
      },
    })

    const output = `${stdout.join('')}\n${stderr.join('')}`
    assert.ok(output.includes('[credential]'))
    assert.doesNotMatch(output, /pul-secret|gh-secret/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('never places either token in arguments, config, logs, or non-provider environments', async () => {
  const harness = createHarness()
  await harness.execute()

  for (const call of harness.calls) {
    assert.doesNotMatch(JSON.stringify(call.args), /pul-secret|gh-secret/)
  }
  assert.doesNotMatch(JSON.stringify(harness.logs), /pul-secret|gh-secret/)

  const source = readFileSync(
    new URL('./enable-ci-after-claim.mjs', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /finally\s*\{[\s\S]*pulumiAccessToken = undefined[\s\S]*githubToken = undefined/,
  )
  assert.doesNotMatch(source, /gh\s+api|gh\s+variable|gh\s+secret|gh\s+repo/)
})

test('documents the human-only claim checkpoint and token boundary', () => {
  const document = readFileSync(
    new URL('../../docs/operations/ci-oidc.md', import.meta.url),
    'utf8',
  )

  for (const command of [
    'pulumi logout',
    'pulumi login',
    'pulumi whoami --json',
    'node scripts/ops/enable-ci-after-claim.mjs --confirm-claimed-by rohan@windrun.ai',
  ]) {
    assert.match(document, new RegExp(`^${command}$`, 'mu'))
  }
  for (const phrase of [
    'transfers the existing stacks and ESC state',
    'invalidates the ephemeral agent credential',
    'restores durable write access',
    'before the local-only `delivery` stack is created',
    '`gh auth status` and `gh auth token` only',
    '`PULUMI_ACCESS_TOKEN`',
    'child-process environment',
    '`pulumi preview` and `pulumi up` of `delivery`',
    'never stored in Pulumi config or state',
  ]) {
    assert.ok(document.includes(phrase), `missing documentation phrase: ${phrase}`)
  }
  for (const name of EXPECTED_FOUNDATION_OUTPUT_NAMES) {
    assert.ok(document.includes(name), `missing foundation output ${name}`)
  }
})

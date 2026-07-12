import { readFile as readFileFromDisk } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPulumiOperations } from './lib/pulumi.mjs'
import { hasExactlyOneActiveGitHubLogin } from './lib/github-auth.mjs'

const MANAGED_BACKEND = 'https://api.pulumi.com'
const MANAGED_APP_URL = 'https://app.pulumi.com'
const EXPECTED_GITHUB_LOGIN = 'rohanprabhu'
const CONFIRMED_OWNER_EMAIL = 'rohan@windrun.ai'

export const FOUNDATION_IDENTITY_OUTPUT_NAMES = Object.freeze([
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
])

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..', '..')

function writeStdoutToProcess(value) {
  process.stdout.write(value)
}

function writeStderrToProcess(value) {
  process.stderr.write(value)
}

function assertConfirmation(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== '--confirm-claimed-by' ||
    argv[1] !== CONFIRMED_OWNER_EMAIL
  ) {
    throw new Error(
      `invocation must be exactly --confirm-claimed-by ${CONFIRMED_OWNER_EMAIL}`,
    )
  }
}

function parseJsonObject(raw, label) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${label} returned invalid JSON`)
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must return a JSON object`)
  }
  return value
}

function credentialsFilePath(environment) {
  const directory = environment.PULUMI_CREDENTIALS_PATH ||
    join(environment.HOME || homedir(), '.pulumi')
  return join(directory, 'credentials.json')
}

function readPulumiToken(credentials) {
  if (credentials.current !== MANAGED_BACKEND) {
    throw new Error(`Pulumi credentials must select ${MANAGED_BACKEND}`)
  }

  const accountToken = credentials.accounts?.[MANAGED_BACKEND]?.accessToken
  const legacyToken = credentials.accessTokens?.[MANAGED_BACKEND]
  const token =
    typeof accountToken === 'string' && accountToken.trim()
      ? accountToken.trim()
      : typeof legacyToken === 'string'
        ? legacyToken.trim()
        : ''

  if (!token) {
    throw new Error('Pulumi access token is empty')
  }
  return token
}

function isManagedPulumiIdentity(identity) {
  const login =
    typeof identity.user === 'string' ? identity.user.trim() : ''
  return (
    login !== '' &&
    (identity.url === MANAGED_BACKEND ||
      identity.url === `${MANAGED_APP_URL}/${login}`)
  )
}

function assertFoundationOutputs(outputs) {
  for (const name of FOUNDATION_IDENTITY_OUTPUT_NAMES) {
    if (typeof outputs[name] !== 'string' || outputs[name].trim() === '') {
      throw new Error(`foundation output ${name} must be a non-empty string`)
    }
  }
}

function cleanChildEnvironment(environment) {
  const childEnvironment = { ...environment }
  delete childEnvironment.GH_TOKEN
  delete childEnvironment.GITHUB_TOKEN
  delete childEnvironment.PULUMI_ACCESS_TOKEN
  return childEnvironment
}

async function runStep(runCommand, label, command, args, options) {
  try {
    const result = await runCommand(command, args, options)
    return {
      stdout: String(result?.stdout ?? ''),
      stderr: String(result?.stderr ?? ''),
    }
  } catch {
    throw new Error(`${label} failed`)
  }
}

function redactCredentials(value, credentials) {
  let redacted = value
  const longestFirst = [...new Set(credentials)]
    .filter((credential) => credential)
    .sort((left, right) => right.length - left.length)

  for (const credential of longestFirst) {
    redacted = redacted.split(credential).join('[credential]')
  }
  return redacted
}

function writeSanitizedResult(
  result,
  credentials,
  writeStdout,
  writeStderr,
) {
  if (result.stdout) {
    writeStdout(redactCredentials(result.stdout, credentials))
  }
  if (result.stderr) {
    writeStderr(redactCredentials(result.stderr, credentials))
  }
}

export async function enableCiAfterClaim({
  argv = process.argv.slice(2),
  runCommand,
  readFile = readFileFromDisk,
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  log = console.log,
  writeStdout = writeStdoutToProcess,
  writeStderr = writeStderrToProcess,
} = {}) {
  assertConfirmation(argv)

  const root = resolve(repositoryRoot)
  const infraRoot = resolve(root, 'infra')
  const executeCommand = runCommand ||
    createPulumiOperations({ environment, repositoryRoot: root })
      .runLifecycleCommand
  const childEnvironment = cleanChildEnvironment(environment)
  let pulumiAccessToken
  let githubToken
  let providerEnvironment

  try {
    const whoamiResult = await runStep(
      executeCommand,
      'pulumi whoami',
      'pulumi',
      ['whoami', '--json'],
      { cwd: infraRoot, env: childEnvironment, capture: true },
    )
    const identity = parseJsonObject(whoamiResult.stdout, 'pulumi whoami')
    if (!isManagedPulumiIdentity(identity)) {
      throw new Error(
        `Pulumi backend must be exactly ${MANAGED_BACKEND} or ${MANAGED_APP_URL}/<login>`,
      )
    }
    if (typeof identity.user !== 'string' || identity.user.trim() === '') {
      throw new Error('Pulumi login must be a non-empty string')
    }
    const login = identity.user.trim()

    let credentialsRaw
    try {
      credentialsRaw = await readFile(
        credentialsFilePath(environment),
        'utf8',
      )
    } catch {
      throw new Error('Pulumi credentials could not be read')
    }
    const credentials = parseJsonObject(
      String(credentialsRaw),
      'Pulumi credentials',
    )
    pulumiAccessToken = readPulumiToken(credentials)

    const githubStatus = await runStep(
      executeCommand,
      'gh auth status',
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      { cwd: root, env: childEnvironment, capture: true },
    )
    if (
      !hasExactlyOneActiveGitHubLogin(
        `${githubStatus.stdout}\n${githubStatus.stderr}`,
        EXPECTED_GITHUB_LOGIN,
      )
    ) {
      throw new Error(
        `active GitHub login must be exactly ${EXPECTED_GITHUB_LOGIN}`,
      )
    }

    const githubTokenResult = await runStep(
      executeCommand,
      'gh auth token',
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { cwd: root, env: childEnvironment, capture: true },
    )
    githubToken = githubTokenResult.stdout.trim()
    if (!githubToken) {
      throw new Error('GitHub token is empty')
    }

    const foundationStack = `${login}/windrun-ai/foundation`
    const deliveryStack = `${login}/windrun-ai/delivery`
    const foundationResult = await runStep(
      executeCommand,
      'pulumi foundation outputs',
      'pulumi',
      ['stack', 'output', '--json', '--stack', foundationStack],
      { cwd: infraRoot, env: childEnvironment, capture: true },
    )
    const foundationOutputs = parseJsonObject(
      foundationResult.stdout,
      'pulumi foundation outputs',
    )
    assertFoundationOutputs(foundationOutputs)

    await runStep(
      executeCommand,
      'pulumi stack select',
      'pulumi',
      ['stack', 'select', '--create', deliveryStack],
      { cwd: infraRoot, env: childEnvironment, capture: false },
    )

    for (const [key, value] of [
      ['windrun-ai:stackKind', 'delivery'],
      ['windrun-ai:pulumiOrganization', login],
      ['windrun-ai:enablePulumiGithubOidc', 'true'],
      ['windrun-ai:productionCiEnabled', 'true'],
      ['windrun-ai:stagingCiEnabled', 'true'],
    ]) {
      await runStep(
        executeCommand,
        `pulumi config set ${key}`,
        'pulumi',
        ['config', 'set', key, value, '--stack', deliveryStack],
        { cwd: infraRoot, env: childEnvironment, capture: false },
      )
    }

    await runStep(
      executeCommand,
      'pnpm ci:validate-contract',
      'pnpm',
      ['ci:validate-contract'],
      { cwd: root, env: childEnvironment, capture: false },
    )
    await runStep(
      executeCommand,
      'pnpm ci:quality',
      'pnpm',
      ['ci:quality'],
      { cwd: root, env: childEnvironment, capture: false },
    )

    providerEnvironment = {
      ...childEnvironment,
      PULUMI_ACCESS_TOKEN: pulumiAccessToken,
      GITHUB_TOKEN: githubToken,
    }
    const previewResult = await runStep(
      executeCommand,
      'pulumi preview',
      'pulumi',
      ['preview', '--stack', deliveryStack],
      { cwd: infraRoot, env: providerEnvironment, capture: true },
    )
    writeSanitizedResult(
      previewResult,
      [pulumiAccessToken, githubToken],
      writeStdout,
      writeStderr,
    )
    const upResult = await runStep(
      executeCommand,
      'pulumi up',
      'pulumi',
      ['up', '--yes', '--stack', deliveryStack],
      { cwd: infraRoot, env: providerEnvironment, capture: true },
    )
    writeSanitizedResult(
      upResult,
      [pulumiAccessToken, githubToken],
      writeStdout,
      writeStderr,
    )

    log('DELIVERY ENABLED; BOOTSTRAP COMPLETE')
    return { login, foundationStack, deliveryStack }
  } finally {
    if (providerEnvironment) {
      delete providerEnvironment.PULUMI_ACCESS_TOKEN
      delete providerEnvironment.GITHUB_TOKEN
      providerEnvironment = undefined
    }
    pulumiAccessToken = undefined
    githubToken = undefined
  }
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  enableCiAfterClaim().catch((error) => {
    console.error(error instanceof Error ? error.message : 'enablement failed')
    process.exitCode = 1
  })
}

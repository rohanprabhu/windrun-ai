import { spawnSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_GOOGLE_IDENTITY = 'rohan@windrun.ai'
const GOOGLE_USERINFO_URL =
  'https://openidconnect.googleapis.com/v1/userinfo'
const ALLOWED_PNPM_SCRIPTS = new Set([
  'ci:validate-contract',
  'ci:quality',
])
const libraryDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(libraryDirectory, '..', '..', '..')

function isExactArgs(args, expected) {
  return (
    args.length === expected.length &&
    args.every((value, index) => value === expected[index])
  )
}

async function spawnProcess(executable, args, options = {}) {
  const capture = options.capture !== false
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.error || result.status !== 0) {
    throw new Error('child command failed')
  }
  return {
    stdout: capture ? (result.stdout ?? '') : '',
    stderr: capture ? (result.stderr ?? '') : '',
  }
}

function normalizeResult(result) {
  if (typeof result === 'string') {
    return { stdout: result, stderr: '' }
  }
  return {
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  }
}

function validateArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((value) => typeof value !== 'string')
  ) {
    throw new Error('command arguments must be a non-empty string array')
  }
}

export function stackRef(organization, stack) {
  if (typeof organization !== 'string' || organization.trim() === '') {
    throw new Error('organization must be a non-empty string')
  }
  if (
    typeof stack !== 'string' ||
    !/^(?:foundation|delivery|production|production-edge|staging|staging-edge|pr-[1-9][0-9]*)$/u.test(
      stack,
    )
  ) {
    throw new Error('stack name is not a Windrun stack')
  }
  return `${organization}/windrun-ai/${stack}`
}

export function createPulumiOperations({
  processRunner = spawnProcess,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const root = resolve(repositoryRoot)
  const infraRoot = resolve(root, 'infra')
  const usesInjectedRunner = processRunner !== spawnProcess

  async function runChecked(executable, args, options, label) {
    try {
      return normalizeResult(
        await processRunner(executable, args, options),
      )
    } catch {
      throw new Error(`${label} failed`)
    }
  }

  function pulumiExecutable(childEnvironment = environment) {
    const executable = childEnvironment.PULUMI_BIN || 'pulumi'
    if (!usesInjectedRunner && basename(executable) !== 'pulumi') {
      throw new Error('PULUMI_BIN basename must be exactly pulumi')
    }
    return executable
  }

  async function runPulumiResult(args, options = {}) {
    validateArgs(args)
    const childEnvironment = options.env || environment
    return runChecked(
      pulumiExecutable(childEnvironment),
      args,
      {
        cwd: infraRoot,
        env: childEnvironment,
        capture: options.capture !== false,
      },
      `pulumi ${args[0]}`,
    )
  }

  async function runPulumi(args, options = {}) {
    return (await runPulumiResult(args, options)).stdout
  }

  async function runLifecycleCommand(command, args, options = {}) {
    validateArgs(args)
    if (command === 'pulumi') {
      return runPulumiResult(args, options)
    }

    const childEnvironment = options.env || environment
    const processOptions = {
      cwd: root,
      env: childEnvironment,
      capture: options.capture !== false,
    }
    if (
      command === 'gh' &&
      (isExactArgs(args, ['auth', 'status', '--hostname', 'github.com']) ||
        isExactArgs(args, ['auth', 'token', '--hostname', 'github.com']))
    ) {
      return runChecked('gh', args, processOptions, `gh ${args[1]}`)
    }
    if (
      command === 'pnpm' &&
      args.length === 1 &&
      ALLOWED_PNPM_SCRIPTS.has(args[0])
    ) {
      return runChecked('pnpm', args, processOptions, `pnpm ${args[0]}`)
    }
    if (command === 'git' && isExactArgs(args, ['rev-parse', 'HEAD'])) {
      return runChecked('git', args, processOptions, 'git rev-parse')
    }
    throw new Error('lifecycle command is not permitted')
  }

  async function runPnpmScript(script) {
    if (!ALLOWED_PNPM_SCRIPTS.has(script)) {
      throw new Error('pnpm lifecycle script is not permitted')
    }
    await runLifecycleCommand('pnpm', [script], { capture: false })
  }

  async function readGitHead() {
    const result = await runLifecycleCommand(
      'git',
      ['rev-parse', 'HEAD'],
      { capture: true },
    )
    const sha = result.stdout.trim()
    if (!/^[0-9a-f]{40}$/u.test(sha)) {
      throw new Error('git HEAD must be a lowercase 40-character SHA')
    }
    return sha
  }

  async function stackHasResources(stack) {
    const raw = await runPulumi(
      ['stack', 'export', '--stack', stack],
      { capture: true },
    )
    let deployment
    try {
      deployment = JSON.parse(raw)?.deployment
    } catch {
      throw new Error('stack export must contain a deployment resources array')
    }
    if (!Array.isArray(deployment?.resources)) {
      throw new Error('stack export must contain a deployment resources array')
    }
    return deployment.resources.some(
      (resource) => resource?.type !== 'pulumi:pulumi:Stack',
    )
  }

  async function destroyAndRemove(stack) {
    await runPulumi(
      ['destroy', '--yes', '--remove', '--stack', stack],
      { capture: false },
    )
  }

  async function assertExactGoogleIdentity() {
    let adcToken
    let requestHeaders
    try {
      const active = await runChecked(
        'gcloud',
        [
          'auth',
          'list',
          '--filter=status:ACTIVE',
          '--format=value(account)',
        ],
        { cwd: root, env: environment, capture: true },
        'gcloud active identity',
      )
      if (active.stdout.trim() !== EXPECTED_GOOGLE_IDENTITY) {
        throw new Error(
          `active gcloud identity must be exactly ${EXPECTED_GOOGLE_IDENTITY}`,
        )
      }

      const adc = await runChecked(
        'gcloud',
        ['auth', 'application-default', 'print-access-token'],
        { cwd: root, env: environment, capture: true },
        'gcloud ADC identity',
      )
      adcToken = adc.stdout.trim()
      if (!adcToken) {
        throw new Error('ADC access token is empty')
      }
      requestHeaders = { Authorization: `Bearer ${adcToken}` }

      let response
      try {
        response = await fetchImpl(GOOGLE_USERINFO_URL, {
          headers: requestHeaders,
        })
      } catch {
        throw new Error('ADC identity lookup failed')
      }
      if (!response?.ok) {
        throw new Error('ADC identity lookup failed')
      }

      let profile
      try {
        profile = await response.json()
      } catch {
        throw new Error('ADC identity lookup failed')
      }
      if (profile?.email !== EXPECTED_GOOGLE_IDENTITY) {
        throw new Error(
          `ADC identity must be exactly ${EXPECTED_GOOGLE_IDENTITY}`,
        )
      }
    } finally {
      if (requestHeaders) {
        delete requestHeaders.Authorization
        requestHeaders = undefined
      }
      adcToken = undefined
    }
  }

  return {
    assertExactGoogleIdentity,
    destroyAndRemove,
    readGitHead,
    runLifecycleCommand,
    runPnpmScript,
    runPulumi,
    stackHasResources,
  }
}

const defaultOperations = createPulumiOperations()

export const assertExactGoogleIdentity =
  defaultOperations.assertExactGoogleIdentity
export const destroyAndRemove = defaultOperations.destroyAndRemove
export const readGitHead = defaultOperations.readGitHead
export const runLifecycleCommand = defaultOperations.runLifecycleCommand
export const runPnpmScript = defaultOperations.runPnpmScript
export const runPulumi = defaultOperations.runPulumi
export const stackHasResources = defaultOperations.stackHasResources

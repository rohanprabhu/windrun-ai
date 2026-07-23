import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boundedHttpRequest } from '../../lib/bounded-http.mjs'

const EXPECTED_GOOGLE_IDENTITY = 'rohan@windrun.ai'
const GOOGLE_USERINFO_URL =
  'https://openidconnect.googleapis.com/v1/userinfo'
const STACK_PROJECTS = Object.freeze({
  foundation: 'windrun-ai-shared-20260712',
  delivery: 'windrun-ai-shared-20260712',
  production: 'windrun-ai-prod-20260712',
  'production-edge': 'windrun-ai-prod-20260712',
  staging: 'windrun-ai-staging-20260712',
  'staging-edge': 'windrun-ai-staging-20260712',
})
const FORBIDDEN_GCP_ENVIRONMENT = Object.freeze([
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
])
const FORBIDDEN_GCP_CONFIG = new Set([
  'gcp:credentials',
  'gcp:accessToken',
  'gcp:impersonateServiceAccount',
  'gcp:impersonateServiceAccountDelegates',
])
const ALLOWED_PNPM_SCRIPTS = new Set([
  'ci:validate-contract',
  'ci:quality',
])
const libraryDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(libraryDirectory, '..', '..', '..')
const ARTIFACT_REGISTRY_HOST = 'asia-south1-docker.pkg.dev'
const DOCKER_CREDENTIAL_HELPER_CONFIG = `${JSON.stringify({
  credHelpers: {
    [ARTIFACT_REGISTRY_HOST]: 'gcloud',
  },
})}\n`

function dockerRegistryAuthConfig(accessToken) {
  return `${JSON.stringify({
    auths: {
      [ARTIFACT_REGISTRY_HOST]: {
        auth: Buffer.from(`oauth2accesstoken:${accessToken}`).toString(
          'base64',
        ),
      },
    },
  })}\n`
}

function stackNameFromRef(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') return undefined
  return reference.split('/').at(-1)
}

function projectForStackName(stackName) {
  if (typeof stackName !== 'string') return undefined
  if (/^pr-[1-9][0-9]*$/u.test(stackName)) {
    return STACK_PROJECTS.staging
  }
  return STACK_PROJECTS[stackName]
}

function stackReferenceFromPulumiArgs(args) {
  const stackIndex = args.indexOf('--stack')
  if (stackIndex >= 0) {
    return args[stackIndex + 1]
  }
  return undefined
}

function projectForPulumiArgs(args) {
  return projectForStackName(stackNameFromRef(stackReferenceFromPulumiArgs(args)))
}

function isExactArgs(args, expected) {
  return (
    args.length === expected.length &&
    args.every((value, index) => value === expected[index])
  )
}

export class CommandTimeoutError extends Error {
  constructor() {
    super('child command timed out')
    this.name = 'CommandTimeoutError'
    this.code = 'COMMAND_TIMEOUT'
  }
}

export class PulumiMutationStateUnknownError extends Error {
  constructor() {
    super('Pulumi mutation state is unknown after forced child termination')
    this.name = 'PulumiMutationStateUnknownError'
    this.code = 'PULUMI_MUTATION_STATE_UNKNOWN'
  }
}

class CommandOutputLimitError extends Error {
  constructor() {
    super('child command exceeded its output limit')
    this.name = 'CommandOutputLimitError'
    this.code = 'COMMAND_OUTPUT_LIMIT'
  }
}

function boundaryError(reason, mutationMayHaveStarted) {
  if (mutationMayHaveStarted) {
    return new PulumiMutationStateUnknownError()
  }
  return reason === 'timeout'
    ? new CommandTimeoutError()
    : new CommandOutputLimitError()
}

function signalChildGroup(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The child exited between the state check and signal delivery.
    }
  }
}

export async function runManagedProcess(executable, args, options = {}) {
  const capture = options.capture !== false
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
  const killGraceMs = options.killGraceMs ?? 5_000
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024
  for (const [value, label] of [
    [timeoutMs, 'timeoutMs'],
    [killGraceMs, 'killGraceMs'],
    [maxOutputBytes, 'maxOutputBytes'],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive safe integer`)
    }
  }

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let terminationReason
    let killTimer
    let settled = false

    function cleanup() {
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
    }

    function terminate(reason) {
      if (terminationReason) return
      terminationReason = reason
      signalChildGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        signalChildGroup(child, 'SIGKILL')
      }, killGraceMs)
    }

    function collect(target, chunk) {
      if (terminationReason) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.byteLength
      if (outputBytes > maxOutputBytes) {
        terminate('output')
        return
      }
      target.push(bytes)
    }

    if (capture) {
      child.stdout.on('data', (chunk) => collect(stdout, chunk))
      child.stderr.on('data', (chunk) => collect(stderr, chunk))
    }

    const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)

    child.once('error', () => {
      if (settled) return
      settled = true
      cleanup()
      rejectProcess(new Error('child command failed'))
    })
    child.once('close', (status, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (terminationReason) {
        rejectProcess(
          boundaryError(
            terminationReason,
            options.mutationMayHaveStarted === true,
          ),
        )
        return
      }
      if (status !== 0 || signal) {
        rejectProcess(new Error('child command failed'))
        return
      }
      resolveProcess({
        stdout: capture ? Buffer.concat(stdout).toString('utf8') : '',
        stderr: capture ? Buffer.concat(stderr).toString('utf8') : '',
      })
    })
  })
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
  processRunner = runManagedProcess,
  fetchImpl = globalThis.fetch,
  environment = process.env,
  repositoryRoot = defaultRepositoryRoot,
  requestTimeoutMs = 10_000,
  maxUserinfoBytes = 64 * 1024,
  commandTimeoutMs = 60 * 60 * 1000,
  killGraceMs = 5_000,
  maxOutputBytes = 16 * 1024 * 1024,
} = {}) {
  const root = resolve(repositoryRoot)
  const infraRoot = resolve(root, 'infra')
  const usesInjectedRunner = processRunner !== runManagedProcess

  async function runChecked(executable, args, options, label) {
    try {
      return normalizeResult(
        await processRunner(executable, args, {
          ...options,
          timeoutMs: options.timeoutMs ?? commandTimeoutMs,
          killGraceMs,
          maxOutputBytes,
          mutationMayHaveStarted:
            options.mutationMayHaveStarted === true,
        }),
      )
    } catch (error) {
      if (
        error?.code === 'COMMAND_TIMEOUT' ||
        error?.code === 'COMMAND_OUTPUT_LIMIT' ||
        error?.code === 'PULUMI_MUTATION_STATE_UNKNOWN'
      ) {
        throw error
      }
      throw new Error(`${label} failed`)
    }
  }

  function pulumiMutationMayHaveStarted(args) {
    if (args[0] === 'preview' || args[0] === 'version') return false
    if (isExactArgs(args, ['whoami', '--json'])) return false
    if (args[0] === 'stack' && ['ls', 'export', 'output'].includes(args[1])) {
      return false
    }
    if (args[0] === 'config' && args[1] === '--json') return false
    return true
  }

  async function mintGoogleAccessToken(childEnvironment) {
    const tokenResult = await runChecked(
      'gcloud',
      [
        'auth',
        'print-access-token',
        `--account=${EXPECTED_GOOGLE_IDENTITY}`,
      ],
      {
        cwd: root,
        env: {
          ...childEnvironment,
          CLOUDSDK_CORE_ACCOUNT: EXPECTED_GOOGLE_IDENTITY,
        },
        capture: true,
      },
      'gcloud explicit Google account token',
    )
    const accessToken = tokenResult.stdout.trim()
    if (!accessToken) {
      throw new Error('explicit Google account access token is empty')
    }
    return accessToken
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
    const mutationMayHaveStarted = pulumiMutationMayHaveStarted(args)
    const googleProject = projectForPulumiArgs(args)
    let googleAccessToken
    let dockerConfig = DOCKER_CREDENTIAL_HELPER_CONFIG
    if (googleProject) {
      googleAccessToken = await mintGoogleAccessToken(childEnvironment)
      dockerConfig = dockerRegistryAuthConfig(googleAccessToken)
    }
    const dockerConfigDirectory = await mkdtemp(
      join(tmpdir(), 'windrun-docker-config-'),
    )
    const isolatedEnvironment = {
      ...childEnvironment,
      DOCKER_CONFIG: dockerConfigDirectory,
      ...(googleProject
        ? {
            CLOUDSDK_CORE_ACCOUNT: EXPECTED_GOOGLE_IDENTITY,
            CLOUDSDK_CORE_PROJECT: googleProject,
            GOOGLE_CLOUD_PROJECT: googleProject,
            GOOGLE_OAUTH_ACCESS_TOKEN: googleAccessToken,
          }
        : {}),
    }
    try {
      await writeFile(
        join(dockerConfigDirectory, 'config.json'),
        dockerConfig,
        { encoding: 'utf8', mode: 0o600 },
      )
      return await runChecked(
        pulumiExecutable(isolatedEnvironment),
        args,
        {
          cwd: infraRoot,
          env: isolatedEnvironment,
          capture: options.capture !== false,
          mutationMayHaveStarted,
        },
        `pulumi ${args[0]}`,
      )
    } finally {
      googleAccessToken = undefined
      dockerConfig = undefined
      delete isolatedEnvironment.DOCKER_CONFIG
      delete isolatedEnvironment.CLOUDSDK_CORE_ACCOUNT
      delete isolatedEnvironment.CLOUDSDK_CORE_PROJECT
      delete isolatedEnvironment.GOOGLE_CLOUD_PROJECT
      delete isolatedEnvironment.GOOGLE_OAUTH_ACCESS_TOKEN
      delete isolatedEnvironment.GH_TOKEN
      delete isolatedEnvironment.GITHUB_TOKEN
      delete isolatedEnvironment.PULUMI_ACCESS_TOKEN
      await rm(dockerConfigDirectory, { recursive: true, force: true })
    }
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

  async function assertExactGoogleIdentity({ stackRefs = [] } = {}) {
    let adcToken
    let requestHeaders
    try {
      for (const name of FORBIDDEN_GCP_ENVIRONMENT) {
        if (environment[name] !== undefined && environment[name] !== '') {
          throw new Error(`${name} is not permitted for local Pulumi operations`)
        }
      }
      if (!Array.isArray(stackRefs)) {
        throw new Error('stackRefs must be an array')
      }
      for (const stack of stackRefs) {
        const configResult = await runPulumiResult(
          ['config', '--json', '--stack', stack],
          { capture: true },
        )
        let config
        try {
          config = JSON.parse(configResult.stdout)
        } catch {
          throw new Error('Pulumi stack config must be valid JSON')
        }
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          throw new Error('Pulumi stack config must be a JSON object')
        }
        for (const key of Object.keys(config)) {
          if (FORBIDDEN_GCP_CONFIG.has(key)) {
            throw new Error(`${key} is not permitted for local Pulumi operations`)
          }
        }
      }
      const explicitAccountToken = await runChecked(
        'gcloud',
        [
          'auth',
          'print-access-token',
          `--account=${EXPECTED_GOOGLE_IDENTITY}`,
        ],
        { cwd: root, env: environment, capture: true },
        'gcloud explicit Google account identity',
      )
      adcToken = explicitAccountToken.stdout.trim()
      if (!adcToken) {
        throw new Error('explicit Google account access token is empty')
      }
      requestHeaders = { Authorization: `Bearer ${adcToken}` }

      let profile
      try {
        const result = await boundedHttpRequest({
          fetchImpl,
          url: GOOGLE_USERINFO_URL,
          init: { headers: requestHeaders },
          label: 'Google explicit account userinfo',
          requestTimeoutMs,
          maxBodyBytes: maxUserinfoBytes,
          body: 'json',
        })
        if (!result.response.ok) {
          throw new Error('userinfo response was not successful')
        }
        profile = result.json
      } catch {
        throw new Error('explicit Google account identity lookup failed')
      }
      if (profile?.email !== EXPECTED_GOOGLE_IDENTITY) {
        throw new Error(
          `explicit Google account identity must be exactly ${EXPECTED_GOOGLE_IDENTITY}`,
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

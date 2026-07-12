import { readFile as readFileFromDisk } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { createPulumiOperations, stackRef } from './lib/pulumi.mjs'

const MANAGED_BACKEND = 'https://api.pulumi.com'
const EXPECTED_GITHUB_LOGIN = 'rohanprabhu'
const REFUSAL_TEXT =
  'REFUSED: pass --destroy-projects to acknowledge deletion of all three GCP projects'
const PROJECT_IDS = Object.freeze([
  'windrun-ai-shared-20260712',
  'windrun-ai-staging-20260712',
  'windrun-ai-prod-20260712',
])
const EARLIER_STATIC_STACKS = Object.freeze([
  'staging',
  'production',
  'staging-edge',
  'production-edge',
])
const ALLOWED_STACK_NAME =
  /^(?:foundation|delivery|production|production-edge|staging|staging-edge|pr-[1-9][0-9]*)$/u
const FOUNDATION_PROJECT_URN_PREFIX =
  'urn:pulumi:foundation::windrun-ai::gcp:organizations/project:Project::'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRepositoryRoot = resolve(scriptDirectory, '..', '..')

class PlatformDestroyRefusal extends Error {
  constructor() {
    super(REFUSAL_TEXT)
    this.exitCode = 2
  }
}

class PlatformSafetyError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function acknowledge(argv) {
  if (argv.length !== 1 || argv[0] !== '--destroy-projects') {
    throw new PlatformDestroyRefusal()
  }
}

function cleanChildEnvironment(environment) {
  const childEnvironment = { ...environment }
  delete childEnvironment.GH_TOKEN
  delete childEnvironment.GITHUB_TOKEN
  delete childEnvironment.PULUMI_ACCESS_TOKEN
  delete childEnvironment.PULUMI_ENABLE_STREAMING_JSON_PREVIEW
  return childEnvironment
}

function parseJsonObject(raw, label) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new PlatformSafetyError(`${label} returned invalid JSON`)
  }
  if (!isObject(value)) {
    throw new PlatformSafetyError(`${label} must return a JSON object`)
  }
  return value
}

function readPulumiLogin(raw) {
  const identity = parseJsonObject(raw, 'pulumi whoami')
  if (
    identity.url !== MANAGED_BACKEND ||
    typeof identity.user !== 'string' ||
    identity.user.trim() === '' ||
    identity.user !== identity.user.trim()
  ) {
    throw new PlatformSafetyError(
      'pulumi whoami must identify the managed backend and canonical login',
    )
  }
  return identity.user
}

function numericStackOrder(left, right) {
  const leftNumber = BigInt(left.slice('pr-'.length))
  const rightNumber = BigInt(right.slice('pr-'.length))
  if (leftNumber < rightNumber) return -1
  if (leftNumber > rightNumber) return 1
  return 0
}

function parseInventory(raw, login) {
  let entries
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new PlatformSafetyError(
      'pulumi stack ls must return a fully qualified JSON array',
    )
  }
  if (!Array.isArray(entries)) {
    throw new PlatformSafetyError(
      'pulumi stack ls must return a fully qualified JSON array',
    )
  }

  const seen = new Set()
  const active = new Set()
  const prefix = `${login}/windrun-ai/`
  for (const entry of entries) {
    const name = entry?.name
    if (
      typeof name !== 'string' ||
      name.trim() !== name ||
      !/^[^/]+\/[^/]+\/[^/]+$/u.test(name) ||
      seen.has(name)
    ) {
      throw new PlatformSafetyError(
        'pulumi stack ls returned unexpected stack state',
      )
    }
    seen.add(name)
    if (!name.startsWith(prefix)) continue
    const stack = name.slice(prefix.length)
    if (!ALLOWED_STACK_NAME.test(stack)) {
      throw new PlatformSafetyError(
        `pulumi stack ls returned unexpected Windrun stack ${stack}`,
      )
    }
    if (
      entry.updateInProgress !== undefined &&
      typeof entry.updateInProgress !== 'boolean'
    ) {
      throw new PlatformSafetyError(
        `${stack} has malformed updateInProgress state`,
      )
    }
    if (entry.updateInProgress === true) {
      throw new PlatformSafetyError(
        `${stack} has updateInProgress=true`,
      )
    }
    active.add(stack)
  }
  return active
}

function emptyArrayOrAbsent(value) {
  return value === undefined ||
    (Array.isArray(value) && value.length === 0)
}

function emptyStringOrAbsent(value) {
  return value === undefined || value === ''
}

function falseOrAbsent(value) {
  return value === undefined || value === false
}

function parseStackState(raw, label) {
  const checkpoint = parseJsonObject(raw, `${label} stack export`)
  if (checkpoint.version !== 3 && checkpoint.version !== 4) {
    throw new PlatformSafetyError(
      `${label} stack export has an unsupported version`,
    )
  }
  const deployment = checkpoint.deployment
  if (!isObject(deployment) || !Array.isArray(deployment.resources)) {
    throw new PlatformSafetyError(
      `${label} stack export must contain deployment resources`,
    )
  }
  if (
    deployment.metadata?.integrity_error ||
    (deployment.pending_operations !== undefined &&
      (!Array.isArray(deployment.pending_operations) ||
        deployment.pending_operations.length !== 0))
  ) {
    throw new PlatformSafetyError(
      `${label} stack export contains pending or corrupt state`,
    )
  }

  const seenUrns = new Set()
  const normalizedResources = []
  let rootCount = 0
  for (const resource of deployment.resources) {
    const isRoot = resource?.type === 'pulumi:pulumi:Stack'
    const inputs =
      isRoot && resource?.inputs === undefined ? {} : resource?.inputs
    const outputs =
      isRoot && resource?.outputs === undefined ? {} : resource?.outputs
    if (
      !isObject(resource) ||
      typeof resource.urn !== 'string' ||
      resource.urn.trim() !== resource.urn ||
      resource.urn === '' ||
      typeof resource.type !== 'string' ||
      resource.type.trim() !== resource.type ||
      resource.type === '' ||
      typeof resource.custom !== 'boolean' ||
      !isObject(inputs) ||
      (outputs !== undefined && !isObject(outputs)) ||
      seenUrns.has(resource.urn)
    ) {
      throw new PlatformSafetyError(
        `${label} stack export contains malformed resources`,
      )
    }
    seenUrns.add(resource.urn)
    if (resource.type === 'pulumi:pulumi:Stack') {
      rootCount += 1
      if (resource.custom !== false) {
        throw new PlatformSafetyError(
          `${label} stack export contains a malformed root resource`,
        )
      }
    }
    if (
      (resource.protect !== undefined &&
        typeof resource.protect !== 'boolean') ||
      !falseOrAbsent(resource.delete) ||
      !falseOrAbsent(resource.taint) ||
      !falseOrAbsent(resource.external) ||
      !falseOrAbsent(resource.pendingReplacement) ||
      !falseOrAbsent(resource.retainOnDelete) ||
      !emptyArrayOrAbsent(resource.initErrors) ||
      !emptyStringOrAbsent(resource.deletedWith) ||
      !emptyArrayOrAbsent(resource.replaceWith)
    ) {
      throw new PlatformSafetyError(
        `${label} stack export contains unsafe resource state`,
      )
    }
    normalizedResources.push({ ...resource, inputs, outputs })
  }
  if (rootCount !== 1) {
    throw new PlatformSafetyError(
      `${label} stack export must contain exactly one root resource`,
    )
  }
  const descendants = normalizedResources.filter(
    ({ type }) => type !== 'pulumi:pulumi:Stack',
  )
  return {
    checkpoint,
    descendants,
    resources: normalizedResources,
  }
}

function assertProjectStates(descendants, deletionPolicy, label) {
  const projects = descendants.filter(
    ({ type }) => type === 'gcp:organizations/project:Project',
  )
  const foundIds = projects.map(({ inputs }) => inputs.projectId)
  if (
    projects.length !== PROJECT_IDS.length ||
    new Set(foundIds).size !== PROJECT_IDS.length ||
    !PROJECT_IDS.every((projectId) => foundIds.includes(projectId)) ||
    projects.some(
      ({ custom, id, inputs, outputs, urn }) =>
        custom !== true ||
        typeof urn !== 'string' ||
        !urn.startsWith(FOUNDATION_PROJECT_URN_PREFIX) ||
        id !== `projects/${inputs.projectId}` ||
        outputs?.projectId !== inputs.projectId ||
        inputs.deletionPolicy !== deletionPolicy ||
        outputs?.deletionPolicy !== deletionPolicy,
    )
  ) {
    throw new PlatformSafetyError(`${label} has unexpected project state`)
  }
}

function assertFoundationState(raw, mode) {
  const label =
    mode === 'normal'
      ? 'foundation pre-transition state'
      : mode === 'transitioned'
        ? 'foundation transition state'
        : 'foundation recovery state'
  const parsed = parseStackState(raw, label)
  if (
    parsed.descendants.length < PROJECT_IDS.length + 1 ||
    parsed.descendants.some(
      ({ type }) => type === 'pulumi:pulumi:StackReference',
    )
  ) {
    throw new PlatformSafetyError(`${label} is incomplete or unexpected`)
  }
  if (mode === 'transitioned') {
    if (
      parsed.descendants.some(
        ({ protect }) => protect !== undefined && protect !== false,
      )
    ) {
      throw new PlatformSafetyError(
        'foundation transition state is not safely destroyable',
      )
    }
    assertProjectStates(parsed.descendants, 'DELETE', label)
  } else {
    if (
      parsed.descendants.some(({ protect }) => protect !== true)
    ) {
      throw new PlatformSafetyError(
        `${label} does not protect every surviving resource`,
      )
    }
    assertProjectStates(parsed.descendants, 'PREVENT', label)
  }
  return parsed
}

function assertNoErrorDiagnostics(diagnostics) {
  if (diagnostics === undefined) return
  if (
    !Array.isArray(diagnostics) ||
    diagnostics.some(
      (diagnostic) =>
        !isObject(diagnostic) || diagnostic.severity === 'error',
    )
  ) {
    throw new PlatformSafetyError(
      'foundation preview contains error diagnostics',
    )
  }
}

function assertEmptyDiff(step) {
  if (
    (step.diffReasons !== undefined &&
      (!Array.isArray(step.diffReasons) ||
        step.diffReasons.length !== 0)) ||
    (step.detailedDiff !== undefined &&
      step.detailedDiff !== null &&
      (!isObject(step.detailedDiff) ||
        Object.keys(step.detailedDiff).length !== 0))
  ) {
    throw new PlatformSafetyError(
      'foundation preview contained an unexpected input change',
    )
  }
}

function assertProjectDiff(step) {
  if (
    !Array.isArray(step.diffReasons) ||
    step.diffReasons.length !== 1 ||
    step.diffReasons[0] !== 'deletionPolicy' ||
    !isObject(step.detailedDiff) ||
    !isObject(step.detailedDiff.deletionPolicy) ||
    Object.keys(step.detailedDiff).length !== 1 ||
    step.detailedDiff.deletionPolicy.kind !== 'update' ||
    step.detailedDiff.deletionPolicy.inputDiff !== true
  ) {
    throw new PlatformSafetyError(
      'foundation preview contained an unexpected project change',
    )
  }
}

function assertSafePreviewState(state, isRoot) {
  const inputs =
    isRoot && state.inputs === undefined ? {} : state.inputs
  if (
    !isObject(inputs) ||
    (state.protect !== undefined &&
      typeof state.protect !== 'boolean') ||
    !falseOrAbsent(state.delete) ||
    !falseOrAbsent(state.taint) ||
    !falseOrAbsent(state.external) ||
    !falseOrAbsent(state.pendingReplacement) ||
    !falseOrAbsent(state.retainOnDelete) ||
    !emptyArrayOrAbsent(state.initErrors) ||
    !emptyStringOrAbsent(state.deletedWith) ||
    !emptyArrayOrAbsent(state.replaceWith)
  ) {
    throw new PlatformSafetyError(
      'foundation preview contains unsafe resource state',
    )
  }
  return inputs
}

function assertPreviewIdentity(
  state,
  current,
  deletionPolicy,
  { planned = false } = {},
) {
  const projectId = current.inputs.projectId
  const commonMismatch =
    state.urn !== current.urn ||
    state.type !== current.type ||
    state.custom !== current.custom ||
    state.inputs?.projectId !== projectId ||
    state.inputs?.deletionPolicy !== deletionPolicy
  const plannedIdMismatch =
    planned &&
    state.id !== undefined &&
    state.id !== '' &&
    state.id !== current.id
  const plannedOutputsMismatch =
    planned &&
    state.outputs !== undefined &&
    (!isObject(state.outputs) ||
      (state.outputs.projectId !== undefined &&
        state.outputs.projectId !== projectId) ||
      (state.outputs.deletionPolicy !== undefined &&
        state.outputs.deletionPolicy !== deletionPolicy))
  const persistedMismatch =
    !planned &&
    (state.id !== current.id ||
      state.outputs?.projectId !== projectId ||
      state.outputs?.deletionPolicy !== deletionPolicy)
  if (
    commonMismatch ||
    plannedIdMismatch ||
    plannedOutputsMismatch ||
    persistedMismatch
  ) {
    throw new PlatformSafetyError(
      'foundation preview contained an unexpected project identity',
    )
  }
}

function validateFoundationPreview(raw, baseline) {
  const preview = parseJsonObject(raw, 'foundation preview')
  assertNoErrorDiagnostics(preview.diagnostics)
  if (
    (preview.maybeCorrupt !== undefined &&
      preview.maybeCorrupt !== false) ||
    !Array.isArray(preview.steps) ||
    !isObject(preview.changeSummary) ||
    preview.steps.length !== baseline.resources.length
  ) {
    throw new PlatformSafetyError(
      'foundation preview did not describe the complete safe transition',
    )
  }
  const summaryKeys = Object.keys(preview.changeSummary)
  if (
    summaryKeys.some((key) => key !== 'same' && key !== 'update') ||
    preview.changeSummary.update !== PROJECT_IDS.length ||
    preview.changeSummary.same !==
      baseline.resources.length - PROJECT_IDS.length
  ) {
    throw new PlatformSafetyError(
      'foundation preview contained an unexpected operation',
    )
  }

  const baselineByUrn = new Map(
    baseline.resources.map((resource) => [resource.urn, resource]),
  )
  const seen = new Set()
  for (const step of preview.steps) {
    if (
      !isObject(step) ||
      typeof step.urn !== 'string' ||
      seen.has(step.urn) ||
      !baselineByUrn.has(step.urn) ||
      !isObject(step.oldState) ||
      !isObject(step.newState)
    ) {
      throw new PlatformSafetyError(
        'foundation preview did not match the current stack state',
      )
    }
    seen.add(step.urn)
    const current = baselineByUrn.get(step.urn)
    const isRoot = current.type === 'pulumi:pulumi:Stack'
    const isProject =
      current.type === 'gcp:organizations/project:Project'
    const oldInputs = assertSafePreviewState(step.oldState, isRoot)
    const newInputs = assertSafePreviewState(step.newState, isRoot)
    if (
      step.oldState.urn !== current.urn ||
      step.oldState.type !== current.type ||
      step.oldState.custom !== current.custom ||
      step.newState.urn !== current.urn ||
      step.newState.type !== current.type ||
      step.newState.custom !== current.custom ||
      !isDeepStrictEqual(oldInputs, current.inputs) ||
      (isRoot &&
        (step.op !== 'same' ||
          !isDeepStrictEqual(newInputs, current.inputs))) ||
      (!isRoot &&
        (step.oldState.protect !== true ||
          (step.newState.protect !== undefined &&
            step.newState.protect !== false)))
    ) {
      throw new PlatformSafetyError(
        'foundation preview did not contain only protection removals',
      )
    }

    if (isProject) {
      const expectedInputs = {
        ...current.inputs,
        deletionPolicy: 'DELETE',
      }
      if (
        step.op !== 'update' ||
        current.inputs.deletionPolicy !== 'PREVENT' ||
        !isDeepStrictEqual(newInputs, expectedInputs)
      ) {
        throw new PlatformSafetyError(
          'foundation preview contained an unexpected project transition',
        )
      }
      assertPreviewIdentity(step.oldState, current, 'PREVENT')
      assertPreviewIdentity(step.newState, current, 'DELETE', {
        planned: true,
      })
      assertProjectDiff(step)
    } else {
      if (
        step.op !== 'same' ||
        !isDeepStrictEqual(newInputs, current.inputs)
      ) {
        throw new PlatformSafetyError(
          'foundation preview contained an unexpected operation',
        )
      }
      assertEmptyDiff(step)
    }
  }
  if (seen.size !== baselineByUrn.size) {
    throw new PlatformSafetyError(
      'foundation preview omitted surviving resources',
    )
  }
}

function credentialsFilePath(environment) {
  const directory =
    environment.PULUMI_CREDENTIALS_PATH ||
    join(environment.HOME || homedir(), '.pulumi')
  return join(directory, 'credentials.json')
}

function readPulumiToken(credentials) {
  if (credentials.current !== MANAGED_BACKEND) {
    throw new PlatformSafetyError(
      `Pulumi credentials must select ${MANAGED_BACKEND}`,
    )
  }
  const accountToken = credentials.accounts?.[MANAGED_BACKEND]?.accessToken
  const legacyToken = credentials.accessTokens?.[MANAGED_BACKEND]
  const token =
    typeof accountToken === 'string' && accountToken.trim()
      ? accountToken.trim()
      : typeof legacyToken === 'string' && legacyToken.trim()
        ? legacyToken.trim()
        : ''
  if (!token) {
    throw new PlatformSafetyError('Pulumi access token is empty')
  }
  return token
}

function hasActiveGitHubLogin(rawStatus) {
  const lines = rawStatus.split(/\r?\n/u)
  const activeLogins = []
  let login
  let active = false

  function finishAccount() {
    if (login && active) activeLogins.push(login)
  }

  for (const line of lines) {
    const account = line.match(
      /Logged in to github\.com account ([^\s(]+)/u,
    )
    if (account) {
      finishAccount()
      login = account[1]
      active = false
    } else if (/Active account:\s*true\b/u.test(line)) {
      active = true
    }
  }
  finishAccount()
  return (
    activeLogins.length === 1 &&
    activeLogins[0] === EXPECTED_GITHUB_LOGIN
  )
}

function redactCredentials(value, credentials) {
  let redacted = value
  for (const credential of [...new Set(credentials)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
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

function normalizeCommandResult(result) {
  if (typeof result === 'string') {
    return { stdout: result, stderr: '' }
  }
  return {
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
  }
}

async function safePulumi(runPulumi, args, options, label) {
  try {
    const result = await runPulumi(args, options)
    if (typeof result !== 'string') throw new Error('invalid result')
    return result
  } catch {
    throw new PlatformSafetyError(`${label} failed`)
  }
}

async function safeLifecycle(
  runLifecycleCommand,
  command,
  args,
  options,
  label,
) {
  try {
    return normalizeCommandResult(
      await runLifecycleCommand(command, args, options),
    )
  } catch {
    throw new PlatformSafetyError(`${label} failed`)
  }
}

async function listActiveStacks(runPulumi, environment, login) {
  const raw = await safePulumi(
    runPulumi,
    ['stack', 'ls', '--json', '--fully-qualify-stack-names'],
    { capture: true, env: environment },
    'pulumi stack inventory',
  )
  return parseInventory(raw, login)
}

async function readStackState(
  runPulumi,
  environment,
  login,
  stack,
) {
  const reference = stackRef(login, stack)
  const raw = await safePulumi(
    runPulumi,
    ['stack', 'export', '--stack', reference],
    { capture: true, env: environment },
    `pulumi ${stack} export`,
  )
  return { raw, state: parseStackState(raw, stack) }
}

async function assertEarlierStacksEmpty(
  runPulumi,
  environment,
  login,
  { includeDelivery },
) {
  const inventory = await listActiveStacks(
    runPulumi,
    environment,
    login,
  )
  const stacks = [
    ...[...inventory]
      .filter((stack) => /^pr-[1-9][0-9]*$/u.test(stack))
      .sort(numericStackOrder),
    ...EARLIER_STATIC_STACKS.filter((stack) => inventory.has(stack)),
  ]
  if (includeDelivery && inventory.has('delivery')) {
    stacks.push('delivery')
  }
  for (const stack of stacks) {
    const { state } = await readStackState(
      runPulumi,
      environment,
      login,
      stack,
    )
    if (state.descendants.length !== 0) {
      throw new PlatformSafetyError(
        `${stack} still contains non-root resources`,
      )
    }
  }
  return inventory
}

async function verifyGoogleIdentity(assertGoogleIdentity) {
  try {
    await assertGoogleIdentity()
  } catch {
    throw new PlatformSafetyError('Google identity verification failed')
  }
}

async function readDeliveryCredentials({
  readFile,
  environment,
  childEnvironment,
  runLifecycleCommand,
}) {
  let credentialsRaw
  try {
    credentialsRaw = await readFile(
      credentialsFilePath(environment),
      'utf8',
    )
  } catch {
    throw new PlatformSafetyError('Pulumi credentials could not be read')
  }
  const pulumiToken = readPulumiToken(
    parseJsonObject(String(credentialsRaw), 'Pulumi credentials'),
  )
  const githubStatus = await safeLifecycle(
    runLifecycleCommand,
    'gh',
    ['auth', 'status', '--hostname', 'github.com'],
    { capture: true, env: childEnvironment },
    'gh auth status',
  )
  if (
    !hasActiveGitHubLogin(
      `${githubStatus.stdout}\n${githubStatus.stderr}`,
    )
  ) {
    throw new PlatformSafetyError(
      `active GitHub login must be exactly ${EXPECTED_GITHUB_LOGIN}`,
    )
  }
  const githubTokenResult = await safeLifecycle(
    runLifecycleCommand,
    'gh',
    ['auth', 'token', '--hostname', 'github.com'],
    { capture: true, env: childEnvironment },
    'gh auth token',
  )
  const githubToken = githubTokenResult.stdout.trim()
  if (!githubToken) {
    throw new PlatformSafetyError('GitHub token is empty')
  }
  return { githubToken, pulumiToken }
}

async function runProviderPulumi({
  args,
  environment,
  label,
  runLifecycleCommand,
  credentials,
  writeStdout,
  writeStderr,
}) {
  const result = await safeLifecycle(
    runLifecycleCommand,
    'pulumi',
    args,
    { capture: true, env: environment },
    label,
  )
  writeSanitizedResult(
    result,
    credentials,
    writeStdout,
    writeStderr,
  )
}

async function resetFoundation({
  assertGoogleIdentity,
  environment,
  foundation,
  login,
  runPulumi,
  transitionMayHaveApplied,
}) {
  const inventory = await listActiveStacks(
    runPulumi,
    environment,
    login,
  )
  if (!inventory.has('foundation')) return
  await verifyGoogleIdentity(assertGoogleIdentity)
  await safePulumi(
    runPulumi,
    [
      'config',
      'set',
      'windrun-ai:allowProjectDeletion',
      'false',
      '--stack',
      foundation,
    ],
    { capture: false, env: environment },
    'foundation recovery config',
  )
  if (transitionMayHaveApplied) {
    await safePulumi(
      runPulumi,
      ['preview', '--stack', foundation],
      { capture: false, env: environment },
      'foundation recovery preview',
    )
    await safePulumi(
      runPulumi,
      ['up', '--yes', '--stack', foundation],
      { capture: false, env: environment },
      'foundation recovery update',
    )
  }
  const recovered = await readStackState(
    runPulumi,
    environment,
    login,
    'foundation',
  )
  assertFoundationState(
    JSON.stringify(recovered.state.checkpoint),
    transitionMayHaveApplied ? 'recovered' : 'normal',
  )
}

export async function destroyPlatform({
  argv = process.argv.slice(2),
  runPulumi: injectedRunPulumi,
  runLifecycleCommand: injectedRunLifecycleCommand,
  runPnpmScript: injectedRunPnpmScript,
  assertGoogleIdentity: injectedAssertGoogleIdentity,
  readFile = readFileFromDisk,
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  log = console.log,
  writeStdout = (value) => process.stdout.write(value),
  writeStderr = (value) => process.stderr.write(value),
} = {}) {
  acknowledge(argv)

  const root = resolve(repositoryRoot)
  const childEnvironment = cleanChildEnvironment(environment)
  const operations = createPulumiOperations({
    environment: childEnvironment,
    repositoryRoot: root,
  })
  const runPulumi = injectedRunPulumi || operations.runPulumi
  const runLifecycleCommand =
    injectedRunLifecycleCommand || operations.runLifecycleCommand
  const runPnpmScript =
    injectedRunPnpmScript || operations.runPnpmScript
  const assertGoogleIdentity =
    injectedAssertGoogleIdentity || operations.assertExactGoogleIdentity

  const whoami = await safePulumi(
    runPulumi,
    ['whoami', '--json'],
    { capture: true, env: childEnvironment },
    'pulumi whoami',
  )
  const login = readPulumiLogin(whoami)
  const foundation = stackRef(login, 'foundation')
  const delivery = stackRef(login, 'delivery')
  const initialInventory = await listActiveStacks(
    runPulumi,
    childEnvironment,
    login,
  )
  if (!initialInventory.has('foundation')) {
    throw new PlatformSafetyError(
      'foundation stack must exist for full platform teardown',
    )
  }

  await verifyGoogleIdentity(assertGoogleIdentity)
  log('GOOGLE IDENTITY VERIFIED: rohan@windrun.ai')

  const previewStacks = [...initialInventory]
    .filter((stack) => /^pr-[1-9][0-9]*$/u.test(stack))
    .sort(numericStackOrder)
  for (const stack of [
    ...previewStacks,
    ...EARLIER_STATIC_STACKS.filter((name) =>
      initialInventory.has(name),
    ),
  ]) {
    await safePulumi(
      runPulumi,
      [
        'destroy',
        '--yes',
        '--remove',
        '--stack',
        stackRef(login, stack),
      ],
      { capture: false, env: childEnvironment },
      `pulumi ${stack} destroy`,
    )
  }

  await assertEarlierStacksEmpty(
    runPulumi,
    childEnvironment,
    login,
    { includeDelivery: false },
  )

  let inventory = await listActiveStacks(
    runPulumi,
    childEnvironment,
    login,
  )
  if (inventory.has('delivery')) {
    try {
      await runPnpmScript('ci:validate-contract')
      await runPnpmScript('ci:quality')
    } catch {
      throw new PlatformSafetyError('delivery quality checks failed')
    }

    let pulumiToken
    let githubToken
    let providerEnvironment
    try {
      const credentials = await readDeliveryCredentials({
        readFile,
        environment,
        childEnvironment,
        runLifecycleCommand,
      })
      pulumiToken = credentials.pulumiToken
      githubToken = credentials.githubToken
      await safePulumi(
        runPulumi,
        [
          'config',
          'set',
          'windrun-ai:enablePulumiGithubOidc',
          'false',
          '--stack',
          delivery,
        ],
        { capture: false, env: childEnvironment },
        'delivery CI disable config',
      )
      providerEnvironment = {
        ...childEnvironment,
        PULUMI_ACCESS_TOKEN: pulumiToken,
        GITHUB_TOKEN: githubToken,
      }
      const providerCredentials = [pulumiToken, githubToken]
      await runProviderPulumi({
        args: ['preview', '--stack', delivery],
        environment: providerEnvironment,
        label: 'delivery disable preview',
        runLifecycleCommand,
        credentials: providerCredentials,
        writeStdout,
        writeStderr,
      })
      await runProviderPulumi({
        args: ['up', '--yes', '--stack', delivery],
        environment: providerEnvironment,
        label: 'delivery disable update',
        runLifecycleCommand,
        credentials: providerCredentials,
        writeStdout,
        writeStderr,
      })
      await assertEarlierStacksEmpty(
        runPulumi,
        childEnvironment,
        login,
        { includeDelivery: false },
      )
      await runProviderPulumi({
        args: ['destroy', '--yes', '--remove', '--stack', delivery],
        environment: providerEnvironment,
        label: 'delivery destroy',
        runLifecycleCommand,
        credentials: providerCredentials,
        writeStdout,
        writeStderr,
      })
    } finally {
      if (providerEnvironment) {
        delete providerEnvironment.PULUMI_ACCESS_TOKEN
        delete providerEnvironment.GITHUB_TOKEN
        providerEnvironment = undefined
      }
      pulumiToken = undefined
      githubToken = undefined
    }
  }

  await verifyGoogleIdentity(assertGoogleIdentity)
  log('GOOGLE IDENTITY REVERIFIED FOR FOUNDATION: rohan@windrun.ai')
  inventory = await assertEarlierStacksEmpty(
    runPulumi,
    childEnvironment,
    login,
    { includeDelivery: true },
  )
  if (!inventory.has('foundation')) {
    throw new PlatformSafetyError(
      'foundation stack disappeared before its acknowledged transition',
    )
  }

  const baselineRaw = await safePulumi(
    runPulumi,
    ['stack', 'export', '--stack', foundation],
    { capture: true, env: childEnvironment },
    'foundation baseline export',
  )
  const baseline = assertFoundationState(baselineRaw, 'normal')

  let configMayBeRaised = false
  let transitionMayHaveApplied = false
  let foundationDestroyed = false
  try {
    configMayBeRaised = true
    await safePulumi(
      runPulumi,
      [
        'config',
        'set',
        'windrun-ai:allowProjectDeletion',
        'true',
        '--stack',
        foundation,
      ],
      { capture: false, env: childEnvironment },
      'foundation deletion transition config',
    )
    const preview = await safePulumi(
      runPulumi,
      [
        'preview',
        '--json',
        '--diff',
        '--suppress-outputs',
        '--stack',
        foundation,
      ],
      { capture: true, env: childEnvironment },
      'foundation deletion transition preview',
    )
    validateFoundationPreview(preview, baseline)
    writeStdout(preview.endsWith('\n') ? preview : `${preview}\n`)

    transitionMayHaveApplied = true
    await safePulumi(
      runPulumi,
      ['up', '--yes', '--stack', foundation],
      { capture: false, env: childEnvironment },
      'foundation deletion transition update',
    )
    const transitionedRaw = await safePulumi(
      runPulumi,
      ['stack', 'export', '--stack', foundation],
      { capture: true, env: childEnvironment },
      'foundation transitioned export',
    )
    assertFoundationState(transitionedRaw, 'transitioned')

    await safePulumi(
      runPulumi,
      ['destroy', '--yes', '--remove', '--stack', foundation],
      { capture: false, env: childEnvironment },
      'foundation destroy',
    )
    foundationDestroyed = true
    const finalInventory = await assertEarlierStacksEmpty(
      runPulumi,
      childEnvironment,
      login,
      { includeDelivery: true },
    )
    if (finalInventory.has('foundation')) {
      throw new PlatformSafetyError(
        'foundation stack still exists after destroy --remove',
      )
    }
  } catch (error) {
    const primary =
      error instanceof PlatformSafetyError
        ? error
        : new PlatformSafetyError('platform teardown failed')
    if (configMayBeRaised && !foundationDestroyed) {
      try {
        await resetFoundation({
          assertGoogleIdentity,
          environment: childEnvironment,
          foundation,
          login,
          runPulumi,
          transitionMayHaveApplied,
        })
      } catch (recoveryError) {
        const recoveryMessage =
          recoveryError instanceof PlatformSafetyError
            ? recoveryError.message
            : 'unknown recovery failure'
        throw new PlatformSafetyError(
          `${primary.message}; foundation recovery failed: ${recoveryMessage}`,
        )
      }
    }
    throw primary
  }

  log(
    'ALL THREE GCP PROJECTS ENTER DELETE_REQUESTED WITH A 30-day recovery window; project IDs are permanently unavailable for reuse',
  )
  return {
    login,
    projects: [...PROJECT_IDS],
    status: 'DELETE_REQUESTED',
  }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  destroyPlatform().catch((error) => {
    if (error instanceof PlatformDestroyRefusal) {
      console.error(error.message)
      process.exitCode = error.exitCode
      return
    }
    console.error(
      error instanceof PlatformSafetyError
        ? error.message
        : 'platform teardown failed',
    )
    process.exitCode = 1
  })
}

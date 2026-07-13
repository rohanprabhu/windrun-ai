import { pathToFileURL } from 'node:url'

import {
  assertExactGoogleIdentity,
  readGitHead,
  runPnpmScript,
  runPulumi,
  stackRef,
} from './lib/pulumi.mjs'
import { validateAppCheckpoint } from '../ci/validate-app-checkpoint.mjs'

const MANAGED_BACKEND = 'https://api.pulumi.com'
const MANAGED_APP_URL = 'https://app.pulumi.com'

export const PHASE_ONE_STACKS = Object.freeze([
  'foundation',
  'production',
  'production-edge',
  'staging',
  'staging-edge',
])

export const FOUNDATION_BOOTSTRAP_OUTPUTS = Object.freeze([
  'sharedProjectId',
  'stagingProjectId',
  'productionProjectId',
  'stagingRepositoryId',
  'productionRepositoryId',
  'stagingRuntimeServiceAccountEmail',
  'productionRuntimeServiceAccountEmail',
  'stagingGlobalIp',
  'productionGlobalIp',
  'stagingCertificateMapId',
  'productionCertificateMapId',
  'stagingCertificateStatus',
  'productionCertificateStatus',
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

function hasFoundationOutputs(raw) {
  let outputs
  try {
    outputs = JSON.parse(raw)
  } catch {
    throw new Error('foundation stack outputs must be valid JSON')
  }
  return FOUNDATION_BOOTSTRAP_OUTPUTS.every(
    (name) => typeof outputs?.[name] === 'string' && outputs[name] !== '',
  )
}

function parseApply(argv) {
  if (argv.length === 0) return false
  if (argv.length === 1 && argv[0] === '--apply') return true
  throw new Error('bootstrap accepts only the optional --apply flag')
}

function readLogin(raw) {
  let identity
  try {
    identity = JSON.parse(raw)
  } catch {
    throw new Error('pulumi whoami must return valid JSON')
  }
  const login =
    typeof identity.user === 'string' ? identity.user.trim() : ''
  if (
    login === '' ||
    (identity?.url !== MANAGED_BACKEND &&
      identity?.url !== `${MANAGED_APP_URL}/${login}`)
  ) {
    throw new Error('pulumi whoami must identify the managed backend and login')
  }
  return login
}

export async function bootstrapPlatform({
  argv = process.argv.slice(2),
  runPulumi: executePulumi = runPulumi,
  stackRef: makeStackRef = stackRef,
  assertGoogleIdentity = assertExactGoogleIdentity,
  readGitHead: getGitHead = readGitHead,
  runPnpmScript: executePnpmScript = runPnpmScript,
  validateCheckpoint = validateAppCheckpoint,
  log = console.log,
} = {}) {
  const apply = parseApply(argv)

  await assertGoogleIdentity()
  log('GOOGLE IDENTITY VERIFIED: rohan@windrun.ai')
  const gitCommitSha = await getGitHead()
  await executePnpmScript('ci:validate-contract')
  await executePnpmScript('ci:quality')
  const login = readLogin(
    await executePulumi(['whoami', '--json'], { capture: true }),
  )

  const completedStacks = []
  for (const stack of PHASE_ONE_STACKS) {
    const reference = makeStackRef(login, stack)
    await executePulumi(
      ['stack', 'select', '--create', reference],
      { capture: false },
    )
    await assertGoogleIdentity({ stackRefs: [reference] })
    await executePulumi(
      [
        'config',
        'set',
        'windrun-ai:stackKind',
        stack,
        '--stack',
        reference,
      ],
      { capture: false },
    )
    if (stack === 'production' || stack === 'staging') {
      await executePulumi(
        [
          'config',
          'set',
          'windrun-ai:gitCommitSha',
          gitCommitSha,
          '--stack',
          reference,
        ],
        { capture: false },
      )
    }
    try {
      await executePulumi(
        ['preview', '--stack', reference],
        { capture: false },
      )
      if (apply) {
        await executePulumi(
          ['up', '--yes', '--stack', reference],
          { capture: false },
        )
        if (stack === 'production' || stack === 'staging') {
          const checkpoint = await executePulumi(
            ['stack', 'export', '--stack', reference],
            { capture: true },
          )
          validateCheckpoint(checkpoint)
        }
      }
    } finally {
      if (stack === 'production' || stack === 'staging') {
        await executePulumi(
          [
            'config',
            'rm',
            'windrun-ai:gitCommitSha',
            '--stack',
            reference,
          ],
          { capture: false },
        )
      }
    }
    completedStacks.push(stack)

    if (stack === 'foundation' && !apply) {
      const outputs = await executePulumi(
        ['stack', 'output', '--json', '--stack', reference],
        { capture: true },
      )
      if (!hasFoundationOutputs(outputs)) {
        log(
          'DOWNSTREAM PREVIEWS PENDING: apply foundation, then rerun the preview-only bootstrap',
        )
        return { apply, login, stacks: completedStacks }
      }
    }
  }

  log('BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY')
  return { apply, login, stacks: completedStacks }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  bootstrapPlatform().catch((error) => {
    console.error(error instanceof Error ? error.message : 'bootstrap failed')
    process.exitCode = 1
  })
}

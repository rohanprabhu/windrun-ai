import { pathToFileURL } from 'node:url'

import {
  assertExactGoogleIdentity,
  readGitHead,
  runPnpmScript,
  runPulumi,
  stackRef,
} from './lib/pulumi.mjs'

const MANAGED_BACKEND = 'https://api.pulumi.com'

export const PHASE_ONE_STACKS = Object.freeze([
  'foundation',
  'production',
  'production-edge',
  'staging',
  'staging-edge',
])

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
  if (
    identity?.url !== MANAGED_BACKEND ||
    typeof identity.user !== 'string' ||
    identity.user.trim() === ''
  ) {
    throw new Error('pulumi whoami must identify the managed backend and login')
  }
  return identity.user.trim()
}

export async function bootstrapPlatform({
  argv = process.argv.slice(2),
  runPulumi: executePulumi = runPulumi,
  stackRef: makeStackRef = stackRef,
  assertGoogleIdentity = assertExactGoogleIdentity,
  readGitHead: getGitHead = readGitHead,
  runPnpmScript: executePnpmScript = runPnpmScript,
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

  for (const stack of PHASE_ONE_STACKS) {
    const reference = makeStackRef(login, stack)
    await executePulumi(
      ['stack', 'select', '--create', reference],
      { capture: false },
    )
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
    await executePulumi(
      ['preview', '--stack', reference],
      { capture: false },
    )
    if (apply) {
      await executePulumi(
        ['up', '--yes', '--stack', reference],
        { capture: false },
      )
    }
  }

  log('BOOTSTRAP PHASE 1 COMPLETE; CLAIM ACCOUNT BEFORE DELIVERY')
  return { apply, login, stacks: [...PHASE_ONE_STACKS] }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  bootstrapPlatform().catch((error) => {
    console.error(error instanceof Error ? error.message : 'bootstrap failed')
    process.exitCode = 1
  })
}

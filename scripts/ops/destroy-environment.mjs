import { pathToFileURL } from 'node:url'

import {
  assertExactGoogleIdentity,
  destroyAndRemove,
  runPulumi,
  stackRef,
} from './lib/pulumi.mjs'

const MANAGED_BACKEND = 'https://api.pulumi.com'
const MANAGED_APP_URL = 'https://app.pulumi.com'

function parseInvocation(argv) {
  const apply = argv.at(-1) === '--apply'
  const expectedLength = apply ? 3 : 2
  if (
    argv.length !== expectedLength ||
    argv[0] !== '--environment' ||
    (argv[1] !== 'staging' && argv[1] !== 'production')
  ) {
    throw new Error(
      'environment must be exactly staging or production with optional --apply',
    )
  }
  return { apply, environment: argv[1] }
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

function numericPreviewNames(raw, login) {
  let stacks
  try {
    stacks = JSON.parse(raw)
  } catch {
    throw new Error('pulumi stack ls must return a JSON array')
  }
  if (!Array.isArray(stacks)) {
    throw new Error('pulumi stack ls must return a JSON array')
  }

  const prefix = `${login}/windrun-ai/`
  return stacks
    .map((stack) => stack?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((name) => /^pr-[1-9][0-9]*$/u.test(name))
    .sort(
      (left, right) =>
        Number(left.slice('pr-'.length)) -
        Number(right.slice('pr-'.length)),
    )
}

export async function destroyEnvironment({
  argv = process.argv.slice(2),
  runPulumi: executePulumi = runPulumi,
  stackRef: makeStackRef = stackRef,
  assertGoogleIdentity = assertExactGoogleIdentity,
  destroyAndRemove: executeDestroy = destroyAndRemove,
  log = console.log,
} = {}) {
  const invocation = parseInvocation(argv)
  const login = readLogin(
    await executePulumi(['whoami', '--json'], { capture: true }),
  )

  const stackNames = []
  if (invocation.environment === 'staging') {
    const rawStacks = await executePulumi(
      ['stack', 'ls', '--json', '--fully-qualify-stack-names'],
      { capture: true },
    )
    stackNames.push(...numericPreviewNames(rawStacks, login))
  }
  stackNames.push(invocation.environment)
  stackNames.push(`${invocation.environment}-edge`)
  const plan = stackNames.map((stack) => makeStackRef(login, stack))

  log('ENVIRONMENT TEARDOWN PLAN:')
  for (const stack of plan) log(stack)
  if (!invocation.apply) {
    log('DRY RUN: pass --apply to execute')
    return plan
  }

  await assertGoogleIdentity()
  log('GOOGLE IDENTITY VERIFIED: rohan@windrun.ai')
  for (const stack of plan) {
    await executeDestroy(stack)
  }
  return plan
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  destroyEnvironment().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'environment teardown failed',
    )
    process.exitCode = 1
  })
}

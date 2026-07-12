import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const previewStackPattern = /^[^/]+\/windrun-ai\/pr-[1-9][0-9]*$/
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const infraDirectory = resolve(scriptDirectory, '..', '..', 'infra')

export function assertPreviewStackRef(stackRef) {
  if (typeof stackRef !== 'string' || !previewStackPattern.test(stackRef)) {
    throw new Error(
      'preview stack must match <owner>/windrun-ai/pr-<positive-number>',
    )
  }
}

async function runLocalPulumi(args, { capture = true } = {}) {
  const result = spawnSync('pulumi', args, {
    cwd: infraDirectory,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`pulumi ${args[0]} failed`)
  }
  return capture ? (result.stdout ?? '') : ''
}

export async function destroyPreview(
  stackRef,
  runPulumi = runLocalPulumi,
  log = console.log,
) {
  assertPreviewStackRef(stackRef)

  let stacks
  try {
    stacks = JSON.parse(await runPulumi(['stack', 'ls', '--json']))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('pulumi stack ls must return a JSON array')
    }
    throw error
  }
  if (!Array.isArray(stacks)) {
    throw new Error('pulumi stack ls must return a JSON array')
  }

  const stackName = stackRef.slice(stackRef.lastIndexOf('/') + 1)
  const exists = stacks.some(
    (stack) => stack?.name === stackRef || stack?.name === stackName,
  )
  if (!exists) {
    log('PREVIEW STACK ABSENT')
    return 'absent'
  }

  await runPulumi(
    ['destroy', '--yes', '--remove', '--stack', stackRef],
    { capture: false },
  )
  return 'destroyed'
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  destroyPreview(process.argv[2]).catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'preview destroy failed',
    )
    process.exitCode = 1
  })
}

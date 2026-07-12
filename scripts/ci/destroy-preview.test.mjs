import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertPreviewStackRef,
  destroyPreview,
} from './destroy-preview.mjs'

const stackRef = 'claimed-user/windrun-ai/pr-42'

function createRunner(stacks = []) {
  const calls = []
  const runPulumi = async (args) => {
    calls.push([...args])
    if (args[0] === 'stack' && args[1] === 'ls') {
      return `${JSON.stringify(stacks)}\n`
    }
    return ''
  }
  return { calls, runPulumi }
}

test('accepts only fully qualified positive numeric preview stacks', () => {
  for (const valid of [
    'claimed-user/windrun-ai/pr-1',
    'team-name/windrun-ai/pr-42',
  ]) {
    assert.doesNotThrow(() => assertPreviewStackRef(valid))
  }

  for (const invalid of [
    'production',
    'pr-0',
    'pr-one',
    'pr-1/production',
    'claimed-user/windrun-ai/production',
    'claimed-user/windrun-ai/pr-0',
    'claimed-user/windrun-ai/pr-one',
    'claimed-user/windrun-ai/pr-1/production',
    'claimed-user/other-project/pr-1',
    '/windrun-ai/pr-1',
  ]) {
    assert.throws(
      () => assertPreviewStackRef(invalid),
      /preview stack must match <owner>\/windrun-ai\/pr-<positive-number>/,
    )
  }
})

test('reports an absent preview without running destroy', async () => {
  const harness = createRunner([
    { name: 'claimed-user/windrun-ai/production' },
  ])
  const messages = []

  const result = await destroyPreview(stackRef, harness.runPulumi, (message) => {
    messages.push(message)
  })

  assert.equal(result, 'absent')
  assert.deepEqual(harness.calls, [['stack', 'ls', '--json']])
  assert.deepEqual(messages, ['PREVIEW STACK ABSENT'])
})

test('destroys and removes exactly the requested existing preview', async () => {
  const harness = createRunner([
    { name: 'claimed-user/windrun-ai/pr-7' },
    { name: stackRef },
  ])
  const messages = []

  const result = await destroyPreview(stackRef, harness.runPulumi, (message) => {
    messages.push(message)
  })

  assert.equal(result, 'destroyed')
  assert.deepEqual(harness.calls, [
    ['stack', 'ls', '--json'],
    ['destroy', '--yes', '--remove', '--stack', stackRef],
  ])
  assert.deepEqual(messages, [])
})

test('fails closed when Pulumi returns a malformed stack list', async () => {
  const calls = []
  const runPulumi = async (args) => {
    calls.push([...args])
    return '{not-json'
  }

  await assert.rejects(
    destroyPreview(stackRef, runPulumi),
    /pulumi stack ls must return a JSON array/,
  )
  assert.deepEqual(calls, [['stack', 'ls', '--json']])
})

test('production runner invokes Pulumi from infra and destroys the exact stack', () => {
  const directory = mkdtempSync(join(tmpdir(), 'windrun-preview-pulumi-'))
  const fakePulumi = join(directory, 'pulumi')
  const logPath = join(directory, 'calls.jsonl')
  const helperPath = fileURLToPath(
    new URL('./destroy-preview.mjs', import.meta.url),
  )
  const repositoryRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

  try {
    writeFileSync(
      fakePulumi,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(
  process.env.PULUMI_FAKE_LOG,
  JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n',
)
if (process.argv[2] === 'stack' && process.argv[3] === 'ls') {
  process.stdout.write(JSON.stringify([{ name: '${stackRef}' }]))
}
`,
      'utf8',
    )
    chmodSync(fakePulumi, 0o755)

    const result = spawnSync(process.execPath, [helperPath, stackRef], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PULUMI_FAKE_LOG: logPath,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      {
        cwd: resolve(repositoryRoot, 'infra'),
        args: ['stack', 'ls', '--json'],
      },
      {
        cwd: resolve(repositoryRoot, 'infra'),
        args: ['destroy', '--yes', '--remove', '--stack', stackRef],
      },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('preview cleanup delegates all process execution to the shared lifecycle boundary', () => {
  const source = readFileSync(
    new URL('./destroy-preview.mjs', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|execSync/u)
  assert.match(source, /createPulumiOperations/u)
})

import assert from 'node:assert/strict'
import test from 'node:test'

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

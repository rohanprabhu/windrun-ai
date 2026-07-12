import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const source = readFileSync(
  resolve(repositoryRoot, 'scripts', 'smoke-container.sh'),
  'utf8',
)

test('bounds every container smoke HTTP request', () => {
  const curlCommands = source
    .split(/\r?\n/u)
    .filter((line) => /\bcurl\b/u.test(line))

  assert.equal(curlCommands.length, 3)
  for (const command of curlCommands) {
    assert.match(command, /--connect-timeout [1-9][0-9]*/u)
    assert.match(command, /--max-time [1-9][0-9]*/u)
  }
})

test('retains a stopped container for startup logs until explicit cleanup', () => {
  const dockerRun = source.match(/docker run[\s\S]*?"\$image" >\/dev\/null/u)
  assert.ok(dockerRun)
  assert.doesNotMatch(dockerRun[0], /(?:^|\s)--rm(?:\s|$)/u)

  const cleanup = source.match(/cleanup\(\) \{([\s\S]*?)\n\}/u)
  assert.ok(cleanup)
  assert.match(cleanup[1], /docker stop "\$container"/u)
  assert.match(cleanup[1], /docker rm "\$container"/u)
})

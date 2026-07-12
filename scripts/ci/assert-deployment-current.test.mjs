import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertDeploymentCurrent } from './assert-deployment-current.mjs'

const repository = 'rohanprabhu/windrun-ai'
const repositoryId = '1095528250'
const ownerId = '136263'
const token = 'github-freshness-token'
const sha = 'a'.repeat(40)

function responseAtUrl(url, payload, status = 200) {
  const response = new Response(JSON.stringify(payload), { status })
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: String(url),
  })
  return response
}

function gate(name) {
  return { name, value: 'true', created_at: '2026-07-12T00:00:00Z' }
}

function createGithubFetch(finalPayload) {
  const calls = []
  const responses = [
    gate('PULUMI_CI_ENABLED'),
    gate('PULUMI_PRODUCTION_ENABLED'),
    finalPayload,
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responseAtUrl(url, responses.shift())
  }
  return { calls, fetchImpl }
}

test('accepts only the current production branch tip after both live gates', async () => {
  const harness = createGithubFetch({
    ref: 'refs/heads/main',
    object: { type: 'commit', sha },
  })

  await assertDeploymentCurrent({
    argv: ['branch', 'main', sha, 'production'],
    token,
    repository,
    repositoryId,
    ownerId,
    fetchImpl: harness.fetchImpl,
  })

  assert.deepEqual(
    harness.calls.map(({ url }) => url),
    [
      `https://api.github.com/repos/${repository}/actions/variables/PULUMI_CI_ENABLED`,
      `https://api.github.com/repos/${repository}/actions/variables/PULUMI_PRODUCTION_ENABLED`,
      `https://api.github.com/repos/${repository}/git/ref/heads/main`,
    ],
  )
  for (const { init } of harness.calls) {
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, `Bearer ${token}`)
    assert.ok(init.signal instanceof AbortSignal)
  }
})

test('rejects a stale branch SHA before cloud authentication can run', async () => {
  const harness = createGithubFetch({
    ref: 'refs/heads/main',
    object: { type: 'commit', sha: 'b'.repeat(40) },
  })

  await assert.rejects(
    assertDeploymentCurrent({
      argv: ['branch', 'main', sha, 'production'],
      token,
      repository,
      repositoryId,
      ownerId,
      fetchImpl: harness.fetchImpl,
    }),
    /no longer the current branch tip/,
  )
})

test('requires an open same-repository preview at the exact merge SHA', async () => {
  const calls = []
  const responses = [
    gate('PULUMI_CI_ENABLED'),
    gate('PULUMI_STAGING_ENABLED'),
    {
      number: 42,
      state: 'open',
      merge_commit_sha: sha,
      base: { ref: 'main', repo: { full_name: repository, id: 1095528250 } },
      head: { repo: { full_name: repository, id: 1095528250 } },
    },
  ]
  const fetchImpl = async (url) => {
    calls.push(url)
    return responseAtUrl(url, responses.shift())
  }

  await assertDeploymentCurrent({
    argv: ['preview', '42', sha, 'staging'],
    token,
    repository,
    repositoryId,
    ownerId,
    fetchImpl,
  })
  assert.equal(calls.at(-1), `https://api.github.com/repos/${repository}/pulls/42`)

  responses.push(
    gate('PULUMI_CI_ENABLED'),
    gate('PULUMI_STAGING_ENABLED'),
    {
      number: 42,
      state: 'closed',
      merge_commit_sha: sha,
      base: { ref: 'main', repo: { full_name: repository, id: 1095528250 } },
      head: { repo: { full_name: repository, id: 1095528250 } },
    },
  )
  await assert.rejects(
    assertDeploymentCurrent({
      argv: ['preview', '42', sha, 'staging'],
      token,
      repository,
      repositoryId,
      ownerId,
      fetchImpl,
    }),
    /no longer open/,
  )
})

test('requires a current closed same-repository PR before preview cleanup', async () => {
  const responses = [
    gate('PULUMI_CI_ENABLED'),
    gate('PULUMI_STAGING_ENABLED'),
    {
      number: 42,
      state: 'closed',
      base: { ref: 'main', repo: { full_name: repository, id: 1095528250 } },
      head: { repo: { full_name: repository, id: 1095528250 } },
    },
  ]
  const fetchImpl = async (url) => responseAtUrl(url, responses.shift())

  await assertDeploymentCurrent({
    argv: ['preview-closed', '42', 'staging'],
    token,
    repository,
    repositoryId,
    ownerId,
    fetchImpl,
  })
})

test('disabled live gate stops before branch or PR lookup', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return responseAtUrl(url, {
      name: 'PULUMI_CI_ENABLED',
      value: 'false',
    })
  }

  await assert.rejects(
    assertDeploymentCurrent({
      argv: ['branch', 'main', sha, 'production'],
      token,
      repository,
      repositoryId,
      ownerId,
      fetchImpl,
    }),
    /PULUMI_CI_ENABLED live gate is not enabled/,
  )
  assert.equal(calls.length, 1)
})

test('bounds a deployment-state request that never returns', async () => {
  const outcome = await Promise.race([
    assertDeploymentCurrent({
      argv: ['gate', 'foundation'],
      token,
      repository,
      repositoryId,
      ownerId,
      requestTimeoutMs: 20,
      overallTimeoutMs: 50,
      fetchImpl: async () => new Promise(() => {}),
    }).then(
      () => ({ status: 'fulfilled' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: 'pending' }), 250),
    ),
  ])

  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.error.message, /timed out/)
  assert.equal(outcome.error.message.includes(token), false)
})

test('rejects mutable repository names backed by the wrong immutable ids', async () => {
  await assert.rejects(
    assertDeploymentCurrent({
      argv: ['gate', 'foundation'],
      token,
      repository,
      repositoryId: '999',
      ownerId,
      fetchImpl: async () => {
        throw new Error('must not fetch')
      },
    }),
    /GITHUB_REPOSITORY_ID must be exactly 1095528250/,
  )
})

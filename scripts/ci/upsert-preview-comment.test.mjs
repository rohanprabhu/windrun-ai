import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  readPreviewEnvironment,
  upsertPreviewComment,
} from './upsert-preview-comment.mjs'

const token = 'ghs_test-secret-value'
const repository = 'rohanprabhu/windrun-ai'
const pullNumber = 42
const previewUrl = 'https://pr-42.staging.app.windrun.ai'
const runUrl =
  'https://github.com/rohanprabhu/windrun-ai/actions/runs/123'

function githubComment({
  id,
  body,
  login = 'github-actions[bot]',
  userType = 'Bot',
}) {
  return {
    url: `https://api.github.com/repos/${repository}/issues/comments/${id}`,
    html_url: `https://github.com/${repository}/pull/${pullNumber}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${repository}/issues/${pullNumber}`,
    id,
    node_id: `IC_kwDOExample${id}`,
    user: {
      login,
      id: 41898282,
      node_id: 'MDM6Qm90NDE4OTgyODI=',
      avatar_url: 'https://avatars.githubusercontent.com/in/15368?v=4',
      gravatar_id: '',
      url: 'https://api.github.com/users/github-actions%5Bbot%5D',
      html_url: 'https://github.com/apps/github-actions',
      followers_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/followers',
      following_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/following{/other_user}',
      gists_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/gists{/gist_id}',
      starred_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/starred{/owner}{/repo}',
      subscriptions_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/subscriptions',
      organizations_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/orgs',
      repos_url: 'https://api.github.com/users/github-actions%5Bbot%5D/repos',
      events_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/events{/privacy}',
      received_events_url:
        'https://api.github.com/users/github-actions%5Bbot%5D/received_events',
      type: userType,
      user_view_type: 'public',
      site_admin: false,
    },
    created_at: '2026-07-12T00:00:00Z',
    updated_at: '2026-07-12T00:00:00Z',
    author_association: 'NONE',
    body,
    reactions: {
      url: `https://api.github.com/repos/${repository}/issues/comments/${id}/reactions`,
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    performed_via_github_app: null,
  }
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-api-version-selected': '2022-11-28',
      ...extraHeaders,
    },
  })
}

test('creates one preview comment when the marker is absent', async () => {
  const calls = []
  const createdComment = githubComment({
    id: 101,
    body:
      '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
  })
  const responses = [jsonResponse([]), jsonResponse(createdComment, 201)]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  assert.equal(calls.length, 2)
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments?per_page=100`,
  )
  assert.equal(calls[0].init.method, 'GET')
  assert.deepEqual(calls[0].init.headers, {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  })
  assert.equal(
    calls[1].url,
    `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`,
  )
  assert.equal(calls[1].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    body:
      '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
  })
  assert.deepEqual(calls[1].init.headers, {
    ...calls[0].init.headers,
    'content-type': 'application/json',
  })
})

test('updates the existing preview comment when the marker is present', async () => {
  const calls = []
  const existingComment = githubComment({
    id: 202,
    body: '<!-- windrun-preview -->\nAn older preview status',
  })
  const updatedComment = githubComment({
    id: 202,
    body:
      '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
  })
  const responses = [
    jsonResponse([existingComment]),
    jsonResponse(updatedComment),
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  assert.equal(calls.length, 2)
  assert.equal(
    calls[1].url,
    `https://api.github.com/repos/${repository}/issues/comments/202`,
  )
  assert.equal(calls[1].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    body:
      '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
  })
  assert.deepEqual(calls[1].init.headers, {
    ...calls[0].init.headers,
    'content-type': 'application/json',
  })
})

test('finds a bot marker on a later page and patches without posting', async () => {
  const calls = []
  const firstPageUrl =
    `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments?per_page=100`
  const secondPageUrl = `${firstPageUrl}&page=2`
  const existingComment = githubComment({
    id: 250,
    body: '<!-- windrun-preview -->\nAn older paginated preview status',
  })
  const responses = [
    jsonResponse([], 200, {
      link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
    }),
    jsonResponse([existingComment]),
    jsonResponse(existingComment),
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  assert.deepEqual(
    calls.map(({ url, init }) => [init.method, url]),
    [
      ['GET', firstPageUrl],
      ['GET', secondPageUrl],
      [
        'PATCH',
        `https://api.github.com/repos/${repository}/issues/comments/250`,
      ],
    ],
  )
  assert.equal(calls.some(({ init }) => init.method === 'POST'), false)
})

test('never forwards the GitHub token to an off-origin pagination URL', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse([], 200, {
      link: '<https://attacker.invalid/collect>; rel="next"',
    })
  }

  await assert.rejects(
    upsertPreviewComment({
      token,
      repository,
      pullNumber,
      state: 'ready',
      previewUrl,
      runUrl,
      fetchImpl,
    }),
    /GitHub API GET pagination URL left the comments endpoint/,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.startsWith('https://api.github.com/'), true)
})

test('sanitizes comment-list JSON failures and rejects non-arrays', async () => {
  const privateBody = `private-response-containing-${token}`
  const rejectingFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    async json() {
      throw new Error(privateBody)
    },
  })

  await assert.rejects(
    upsertPreviewComment({
      token,
      repository,
      pullNumber,
      state: 'ready',
      previewUrl,
      runUrl,
      fetchImpl: rejectingFetch,
    }),
    (error) => {
      assert.equal(error.message, 'GitHub API GET returned invalid JSON')
      assert.equal(error.message.includes(token), false)
      assert.equal(error.message.includes(privateBody), false)
      return true
    },
  )

  await assert.rejects(
    upsertPreviewComment({
      token,
      repository,
      pullNumber,
      state: 'ready',
      previewUrl,
      runUrl,
      fetchImpl: async () => jsonResponse({ not: 'an array' }),
    }),
    /GitHub API GET must return a comment array/,
  )
})

test('leaves a different bot comment untouched', async () => {
  const calls = []
  const unrelatedComment = githubComment({
    id: 303,
    login: 'dependabot[bot]',
    body: 'Bumps undici from 7.10.0 to 7.11.0.',
  })
  const unrelatedSnapshot = structuredClone(unrelatedComment)
  const createdComment = githubComment({
    id: 304,
    body:
      '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
  })
  const responses = [
    jsonResponse([unrelatedComment]),
    jsonResponse(createdComment, 201),
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  assert.deepEqual(unrelatedComment, unrelatedSnapshot)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(
    calls[1].url,
    `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`,
  )
  assert.notEqual(calls[1].url, unrelatedComment.url)
})

test('never patches a user-authored marker comment', async () => {
  const calls = []
  const userComment = githubComment({
    id: 350,
    login: 'rohanprabhu',
    userType: 'User',
    body: '<!-- windrun-preview -->\nA user-authored marker',
  })
  const userSnapshot = structuredClone(userComment)
  const createdComment = githubComment({ id: 351, body: '' })
  const responses = [
    jsonResponse([userComment]),
    jsonResponse(createdComment, 201),
  ]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  assert.deepEqual(userComment, userSnapshot)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(
    calls[1].url,
    `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`,
  )
})

test('never exposes the token in a generated body or thrown error', async () => {
  const calls = []
  const responses = [
    jsonResponse([]),
    jsonResponse(
      githubComment({
        id: 404,
        body:
          '<!-- windrun-preview -->\nWindrun preview is ready: https://pr-42.staging.app.windrun.ai\n\n[Deployment run](https://github.com/rohanprabhu/windrun-ai/actions/runs/123)',
      }),
      201,
    ),
  ]
  const successfulFetch = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'ready',
    previewUrl,
    runUrl,
    fetchImpl: successfulFetch,
  })

  assert.equal(calls[1].init.body.includes(token), false)

  const leakingFetch = async () => {
    throw new Error(`transport rejected credential ${token}`)
  }
  await assert.rejects(
    upsertPreviewComment({
      token,
      repository,
      pullNumber,
      state: 'ready',
      previewUrl,
      runUrl,
      fetchImpl: leakingFetch,
    }),
    (error) => {
      assert.equal(error.message.includes(token), false)
      assert.equal(error.message.includes('transport rejected credential'), false)
      return true
    },
  )
})

test('reports a failed deployment while retaining its preview and run URLs', async () => {
  const calls = []
  const responses = [jsonResponse([]), jsonResponse(githubComment({ id: 505, body: '' }), 201)]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'failed',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  const { body } = JSON.parse(calls[1].init.body)
  assert.match(body, /deployment failed/i)
  assert.match(body, new RegExp(previewUrl.replaceAll('.', '\\.')))
  assert.match(body, new RegExp(runUrl.replaceAll('.', '\\.')))
})

test('reports destruction without presenting a live preview link', async () => {
  const calls = []
  const responses = [jsonResponse([]), jsonResponse(githubComment({ id: 606, body: '' }), 201)]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  }

  await upsertPreviewComment({
    token,
    repository,
    pullNumber,
    state: 'destroyed',
    previewUrl,
    runUrl,
    fetchImpl,
  })

  const { body } = JSON.parse(calls[1].init.body)
  assert.match(body, /preview was destroyed/i)
  assert.equal(body.includes(previewUrl), false)
  assert.match(body, new RegExp(runUrl.replaceAll('.', '\\.')))
})

test('reads the exact preview-comment CLI environment contract', () => {
  assert.deepEqual(
    readPreviewEnvironment({
      GITHUB_TOKEN: token,
      GITHUB_REPOSITORY: repository,
      PR_NUMBER: '42',
      PREVIEW_STATE: 'failed',
      PREVIEW_URL: previewUrl,
      GITHUB_RUN_URL: runUrl,
    }),
    {
      token,
      repository,
      pullNumber,
      state: 'failed',
      previewUrl,
      runUrl,
    },
  )
})

test('rejects incomplete CLI input without exposing environment values', () => {
  assert.throws(
    () =>
      readPreviewEnvironment({
        GITHUB_TOKEN: token,
        GITHUB_REPOSITORY: repository,
        PR_NUMBER: 'not-a-number',
        PREVIEW_STATE: 'ready',
        PREVIEW_URL: previewUrl,
        GITHUB_RUN_URL: runUrl,
      }),
    (error) => {
      assert.match(error.message, /PR_NUMBER/)
      assert.equal(error.message.includes(token), false)
      return true
    },
  )
})

import { pathToFileURL } from 'node:url'

const marker = '<!-- windrun-preview -->'
const previewStates = new Set(['ready', 'failed', 'destroyed'])

function requiredEnvironment(env, name) {
  const value = env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function readPreviewEnvironment(env = process.env) {
  const pullNumberValue = requiredEnvironment(env, 'PR_NUMBER')
  if (!/^[1-9][0-9]*$/.test(pullNumberValue)) {
    throw new Error('PR_NUMBER must be a positive integer')
  }

  const state = requiredEnvironment(env, 'PREVIEW_STATE')
  if (!previewStates.has(state)) {
    throw new Error('PREVIEW_STATE must be ready, failed, or destroyed')
  }

  return {
    token: requiredEnvironment(env, 'GITHUB_TOKEN'),
    repository: requiredEnvironment(env, 'GITHUB_REPOSITORY'),
    pullNumber: Number(pullNumberValue),
    state,
    previewUrl: requiredEnvironment(env, 'PREVIEW_URL'),
    runUrl: requiredEnvironment(env, 'GITHUB_RUN_URL'),
  }
}

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init)
  } catch {
    throw new Error(
      `GitHub API ${init.method} failed before receiving a response`,
    )
  }
}

function commentBody(state, previewUrl, runUrl) {
  switch (state) {
    case 'ready':
      return `${marker}\nWindrun preview is ready: ${previewUrl}\n\n[Deployment run](${runUrl})`
    case 'failed':
      return `${marker}\nWindrun preview deployment failed: ${previewUrl}\n\n[Deployment run](${runUrl})`
    case 'destroyed':
      return `${marker}\nWindrun preview was destroyed.\n\n[Deployment run](${runUrl})`
    default:
      throw new Error(`Unsupported preview state: ${state}`)
  }
}

export async function upsertPreviewComment({
  token,
  repository,
  pullNumber,
  state,
  previewUrl,
  runUrl,
  fetchImpl = fetch,
}) {
  const commentsUrl = `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
  const listResponse = await request(fetchImpl, commentsUrl, {
    method: 'GET',
    headers,
  })

  if (!listResponse.ok) {
    throw new Error(`GitHub API GET failed with status ${listResponse.status}`)
  }

  const comments = await listResponse.json()
  const existingComment = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      comment.user?.type === 'Bot' &&
      typeof comment.body === 'string' &&
      comment.body.includes(marker),
  )

  const body = commentBody(state, previewUrl, runUrl)
  const mutationMethod = existingComment ? 'PATCH' : 'POST'
  const mutationUrl = existingComment
    ? `https://api.github.com/repos/${repository}/issues/comments/${existingComment.id}`
    : commentsUrl
  const mutationResponse = await request(fetchImpl, mutationUrl, {
    method: mutationMethod,
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body }),
  })

  if (!mutationResponse.ok) {
    throw new Error(
      `GitHub API ${mutationMethod} failed with status ${mutationResponse.status}`,
    )
  }

  return mutationResponse.status
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    await upsertPreviewComment(readPreviewEnvironment())
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Preview comment failed')
    process.exitCode = 1
  }
}

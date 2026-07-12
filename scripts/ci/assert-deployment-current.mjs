import { pathToFileURL } from 'node:url'

import {
  boundedHttpRequest,
  OperationDeadline,
} from '../lib/bounded-http.mjs'

const EXPECTED_REPOSITORY = 'rohanprabhu/windrun-ai'
const EXPECTED_REPOSITORY_ID = '1095528250'
const EXPECTED_OWNER_ID = '136263'
const shaPattern = /^[0-9a-f]{40}$/u
const branchPattern = /^(?:main|staging)$/u
const scopeVariables = Object.freeze({
  production: 'PULUMI_PRODUCTION_ENABLED',
  staging: 'PULUMI_STAGING_ENABLED',
})

function requiredString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

function parseInvocation(argv) {
  if (argv[0] === 'gate' && argv.length === 2) {
    return { mode: 'gate', scope: argv[1] }
  }
  if (argv[0] === 'branch' && argv.length === 4) {
    return {
      mode: 'branch',
      branch: argv[1],
      expectedSha: argv[2],
      scope: argv[3],
    }
  }
  if (argv[0] === 'preview' && argv.length === 4) {
    return {
      mode: 'preview',
      pullNumber: argv[1],
      expectedSha: argv[2],
      scope: argv[3],
    }
  }
  if (argv[0] === 'preview-closed' && argv.length === 3) {
    return {
      mode: 'preview-closed',
      pullNumber: argv[1],
      scope: argv[2],
    }
  }
  throw new Error('deployment-current invocation is invalid')
}

function validateInvocation(invocation) {
  if (
    invocation.scope !== 'foundation' &&
    !Object.hasOwn(scopeVariables, invocation.scope)
  ) {
    throw new Error('deployment scope is invalid')
  }
  if (invocation.mode === 'branch') {
    if (!branchPattern.test(invocation.branch)) {
      throw new Error('deployment branch is invalid')
    }
    if (!shaPattern.test(invocation.expectedSha)) {
      throw new Error('expected SHA must be lowercase and 40 characters')
    }
  }
  if (
    invocation.mode === 'preview' ||
    invocation.mode === 'preview-closed'
  ) {
    if (!/^[1-9][0-9]*$/u.test(String(invocation.pullNumber))) {
      throw new Error('pull request number must be positive')
    }
    if (
      invocation.mode === 'preview' &&
      !shaPattern.test(invocation.expectedSha)
    ) {
      throw new Error('expected SHA must be lowercase and 40 characters')
    }
  }
}

async function readGithubJson({
  path,
  token,
  fetchImpl,
  requestTimeoutMs,
  maxBodyBytes,
  deadline,
}) {
  const { response, json } = await boundedHttpRequest({
    fetchImpl,
    url: `https://api.github.com${path}`,
    init: {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
    label: 'GitHub deployment-state GET',
    requestTimeoutMs,
    maxBodyBytes,
    body: 'json',
    deadline,
  })
  if (!response.ok) {
    throw new Error(
      `GitHub deployment-state GET failed with status ${response.status}`,
    )
  }
  return json
}

async function assertLiveGate(options, scope) {
  const names = [
    'PULUMI_CI_ENABLED',
    ...(scope === 'foundation' ? [] : [scopeVariables[scope]]),
  ]
  for (const name of names) {
    const variable = await readGithubJson({
      ...options,
      path:
        `/repos/${EXPECTED_REPOSITORY}/actions/variables/${name}`,
    })
    if (variable?.name !== name || variable?.value !== 'true') {
      throw new Error(`${name} live gate is not enabled`)
    }
  }
}

export async function assertDeploymentCurrent({
  argv,
  token,
  repository,
  repositoryId,
  ownerId,
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
  overallTimeoutMs = 30_000,
  maxBodyBytes = 128 * 1024,
}) {
  const invocation = parseInvocation(argv)
  validateInvocation(invocation)
  requiredString(token, 'GITHUB_TOKEN')
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`GITHUB_REPOSITORY must be exactly ${EXPECTED_REPOSITORY}`)
  }
  if (repositoryId !== EXPECTED_REPOSITORY_ID) {
    throw new Error(
      `GITHUB_REPOSITORY_ID must be exactly ${EXPECTED_REPOSITORY_ID}`,
    )
  }
  if (ownerId !== EXPECTED_OWNER_ID) {
    throw new Error(`GITHUB_REPOSITORY_OWNER_ID must be exactly ${EXPECTED_OWNER_ID}`)
  }
  const deadline = new OperationDeadline(
    overallTimeoutMs,
    'GitHub deployment-state operation',
  )
  const requestOptions = {
    token,
    fetchImpl,
    requestTimeoutMs,
    maxBodyBytes,
    deadline,
  }

  await assertLiveGate(requestOptions, invocation.scope)

  if (invocation.mode === 'branch') {
    const reference = await readGithubJson({
      ...requestOptions,
      path:
        `/repos/${EXPECTED_REPOSITORY}/git/ref/heads/${invocation.branch}`,
    })
    if (
      reference?.ref !== `refs/heads/${invocation.branch}` ||
      reference?.object?.type !== 'commit' ||
      reference?.object?.sha !== invocation.expectedSha
    ) {
      throw new Error('deployment SHA is no longer the current branch tip')
    }
  }

  if (invocation.mode === 'preview') {
    const pull = await readGithubJson({
      ...requestOptions,
      path:
        `/repos/${EXPECTED_REPOSITORY}/pulls/${invocation.pullNumber}`,
    })
    if (
      pull?.state !== 'open' ||
      pull?.number !== Number(invocation.pullNumber) ||
      pull?.base?.ref !== 'main' ||
      pull?.base?.repo?.full_name !== EXPECTED_REPOSITORY ||
      pull?.base?.repo?.id !== Number(EXPECTED_REPOSITORY_ID) ||
      pull?.head?.repo?.full_name !== EXPECTED_REPOSITORY ||
      pull?.head?.repo?.id !== Number(EXPECTED_REPOSITORY_ID) ||
      pull?.merge_commit_sha !== invocation.expectedSha
    ) {
      throw new Error('preview is no longer open at the requested merge SHA')
    }
  }

  if (invocation.mode === 'preview-closed') {
    const pull = await readGithubJson({
      ...requestOptions,
      path:
        `/repos/${EXPECTED_REPOSITORY}/pulls/${invocation.pullNumber}`,
    })
    if (
      pull?.state !== 'closed' ||
      pull?.number !== Number(invocation.pullNumber) ||
      pull?.base?.ref !== 'main' ||
      pull?.base?.repo?.full_name !== EXPECTED_REPOSITORY ||
      pull?.base?.repo?.id !== Number(EXPECTED_REPOSITORY_ID) ||
      pull?.head?.repo?.full_name !== EXPECTED_REPOSITORY ||
      pull?.head?.repo?.id !== Number(EXPECTED_REPOSITORY_ID)
    ) {
      throw new Error('preview cleanup no longer targets a closed owned PR')
    }
  }

  return invocation
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    await assertDeploymentCurrent({
      argv: process.argv.slice(2),
      token: process.env.GITHUB_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      ownerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
    })
    console.log('DEPLOYMENT CURRENT')
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'deployment-state check failed',
    )
    process.exitCode = 1
  }
}

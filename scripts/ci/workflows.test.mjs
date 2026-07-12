import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const checkoutAction =
  'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5'
const pulumiAction =
  'pulumi/actions@8e5e406f4007fca908480587cb9893c07090f58d'

const fixtures = [
  {
    name: 'production',
    file: 'deploy-production.yml',
    workflowName: 'Deploy production',
    branch: 'main',
    environment: 'production',
    concurrencyGroup: 'windrun-production',
    projectId: 'windrun-ai-prod-20260712',
    providerVariable: 'GCP_WIF_PROVIDER_PRODUCTION',
    serviceAccountVariable: 'GCP_SERVICE_ACCOUNT_PRODUCTION',
    stackKind: 'production',
    healthUrl: 'https://app.windrun.ai/api/health',
  },
  {
    name: 'staging',
    file: 'deploy-staging.yml',
    workflowName: 'Deploy staging',
    branch: 'staging',
    environment: 'staging',
    concurrencyGroup: 'windrun-staging',
    projectId: 'windrun-ai-staging-20260712',
    providerVariable: 'GCP_WIF_PROVIDER_STAGING',
    serviceAccountVariable: 'GCP_SERVICE_ACCOUNT_STAGING',
    stackKind: 'staging',
    healthUrl: 'https://staging.app.windrun.ai/api/health',
  },
]

function readWorkflow(file) {
  const path = resolve(repositoryRoot, '.github', 'workflows', file)
  assert.equal(existsSync(path), true, `${file} must exist`)
  return parse(readFileSync(path, 'utf8'))
}

function readWorkflowSource(file) {
  const path = resolve(repositoryRoot, '.github', 'workflows', file)
  assert.equal(existsSync(path), true, `${file} must exist`)
  return readFileSync(path, 'utf8')
}

function compactExpression(value) {
  return String(value).replaceAll(/\s+/gu, ' ').trim()
}

function assertIncludesEvery(value, fragments) {
  const compact = compactExpression(value)
  for (const fragment of fragments) {
    assert.match(
      compact,
      new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  }
}

function assertImmutableExternalActions(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (typeof step.uses !== 'string' || step.uses.startsWith('./')) continue
      assert.match(
        step.uses,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${step.uses} must use a full immutable commit SHA`,
      )
      if (step.uses.startsWith('actions/checkout@')) {
        assert.equal(step.uses, checkoutAction)
        assert.equal(step.with?.['persist-credentials'], false)
      }
    }
  }
}

for (const fixture of fixtures) {
  test(`${fixture.name} routes only its fixed branch through uncredentialed quality`, () => {
    const workflow = readWorkflow(fixture.file)
    const quality = workflow.jobs.quality

    assert.equal(workflow.name, fixture.workflowName)
    assert.deepEqual(workflow.on, { push: { branches: [fixture.branch] } })
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.equal(quality['runs-on'], 'ubuntu-latest')
    assert.equal(quality.permissions?.['id-token'], undefined)
    assert.deepEqual(
      quality.steps.map((step) => step.uses ?? step.run),
      [
        checkoutAction,
        './.github/actions/setup',
        'pnpm ci:validate-contract',
        'pnpm ci:quality',
      ],
    )
    assert.equal(quality.steps[0].with['persist-credentials'], false)
  })

  test(`${fixture.name} deploy uses its isolated identity and non-canceling queue`, () => {
    const deploy = readWorkflow(fixture.file).jobs.deploy

    assert.equal(deploy.needs, 'quality')
    assert.equal(deploy.if, "vars.PULUMI_CI_ENABLED == 'true'")
    assert.equal(deploy['runs-on'], 'ubuntu-latest')
    assert.equal(deploy.environment, fixture.environment)
    assert.deepEqual(deploy.permissions, {
      contents: 'read',
      'id-token': 'write',
    })
    assert.deepEqual(deploy.concurrency, {
      group: fixture.concurrencyGroup,
      'cancel-in-progress': false,
    })

    const auth = deploy.steps.find(
      (step) => step.uses === './.github/actions/auth-cloud',
    )
    assert.ok(auth)
    assert.deepEqual(auth.with, {
      'pulumi-organization': '${{ vars.PULUMI_ORGANIZATION }}',
      'gcp-project-id': fixture.projectId,
      'workload-identity-provider':
        `\${{ vars.${fixture.providerVariable} }}`,
      'service-account': `\${{ vars.${fixture.serviceAccountVariable} }}`,
    })
  })

  test(`${fixture.name} pins external actions and removes checkout credentials`, () => {
    const workflow = readWorkflow(fixture.file)
    const deploy = workflow.jobs.deploy

    assertImmutableExternalActions(workflow)
    const deployCheckouts = deploy.steps.filter(
      (step) => step.uses?.startsWith('actions/checkout@'),
    )
    assert.equal(deployCheckouts.length, 1)
    for (const checkout of deployCheckouts) {
      assert.equal(checkout.uses, checkoutAction)
      assert.equal(checkout.with['persist-credentials'], false)
    }
  })

  test(`${fixture.name} previews before up and smoke-tests the fixed stack`, () => {
    const deploy = readWorkflow(fixture.file).jobs.deploy
    const checkoutIndex = deploy.steps.findIndex(
      (step) => step.uses === checkoutAction,
    )
    const setupIndex = deploy.steps.findIndex(
      (step) => step.uses === './.github/actions/setup',
    )
    const authIndex = deploy.steps.findIndex(
      (step) => step.uses === './.github/actions/auth-cloud',
    )
    const previewIndex = deploy.steps.findIndex(
      (step) => step.with?.command === 'preview',
    )
    const upIndex = deploy.steps.findIndex(
      (step) => step.with?.command === 'up',
    )
    const smokeIndex = deploy.steps.findIndex(
      (step) => step.run?.startsWith('node scripts/ci/smoke-test.mjs '),
    )

    assert.ok(checkoutIndex >= 0)
    assert.ok(setupIndex > checkoutIndex)
    assert.ok(authIndex > setupIndex)
    assert.ok(previewIndex > authIndex)
    assert.ok(upIndex > previewIndex)
    assert.ok(smokeIndex > upIndex)

    const pulumiSteps = deploy.steps.filter(
      (step) => step.uses === pulumiAction,
    )
    assert.equal(pulumiSteps.length, 2)
    assert.equal(pulumiSteps[0].with.command, 'preview')
    assert.equal(pulumiSteps[1].id, 'up')
    assert.equal(pulumiSteps[1].with.command, 'up')

    for (const step of pulumiSteps) {
      assert.equal(
        step.with['stack-name'],
        `\${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/${fixture.stackKind}`,
      )
      assert.equal(step.with['work-dir'], 'infra')
      assert.deepEqual(parse(step.with['config-map']), {
        'windrun-ai:stackKind': { value: fixture.stackKind },
        'windrun-ai:gitCommitSha': { value: '${{ github.sha }}' },
      })
    }

    assert.equal(
      deploy.steps[smokeIndex].run,
      `node scripts/ci/smoke-test.mjs ${fixture.healthUrl} --attempts 30 --delay-ms 10000`,
    )
  })
}

const pullRequestCaller = 'pull-request.yml'
const previewDeployWorkflow = '_preview-deploy.yml'
const previewDestroyWorkflow = '_preview-destroy.yml'
const deployReusable =
  'rohanprabhu/windrun-ai/.github/workflows/_preview-deploy.yml@main'
const destroyReusable =
  'rohanprabhu/windrun-ai/.github/workflows/_preview-destroy.yml@main'

test('pull request caller is uncredentialed and delegates only same-repository events', () => {
  const workflow = readWorkflow(pullRequestCaller)
  const source = readWorkflowSource(pullRequestCaller)

  assert.deepEqual(workflow.on, {
    pull_request: {
      branches: ['main'],
      types: ['opened', 'reopened', 'synchronize', 'closed'],
    },
  })
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.doesNotMatch(source, /pull_request_target/u)

  const quality = workflow.jobs.quality
  assertIncludesEvery(quality.if, ["github.event.action != 'closed'"])
  assert.equal(quality.permissions?.['id-token'], undefined)
  assert.deepEqual(
    quality.steps.map((step) => step.uses ?? step.run),
    [
      checkoutAction,
      './.github/actions/setup',
      'pnpm ci:validate-contract',
      'pnpm ci:quality',
    ],
  )
  assert.equal(quality.steps[0].with['persist-credentials'], false)

  for (const [name, reusable] of [
    ['deploy-preview', deployReusable],
    ['destroy-preview', destroyReusable],
  ]) {
    const job = workflow.jobs[name]
    assert.equal(job.uses, reusable)
    assert.equal(job.steps, undefined)
    assert.equal(job.secrets, undefined)
    assert.deepEqual(job.permissions, {
      contents: 'read',
      'id-token': 'write',
      'pull-requests': 'write',
    })
    assertIncludesEvery(job.if, [
      "vars.PULUMI_CI_ENABLED == 'true'",
      'github.event.pull_request.head.repo.id == github.event.repository.id',
      'github.event.pull_request.head.repo.full_name == github.repository',
    ])
  }

  assert.equal(workflow.jobs['deploy-preview'].needs, 'quality')
  assertIncludesEvery(workflow.jobs['deploy-preview'].if, [
    "needs.quality.result == 'success'",
  ])
  assert.deepEqual(workflow.jobs['deploy-preview'].with, {
    'pr-number': '${{ github.event.pull_request.number }}',
    'merge-sha': '${{ github.event.pull_request.merge_commit_sha }}',
    'preview-url':
      'https://pr-${{ github.event.pull_request.number }}.staging.app.windrun.ai',
  })
  assertIncludesEvery(workflow.jobs['destroy-preview'].if, [
    "github.event.action == 'closed'",
  ])
  assert.deepEqual(workflow.jobs['destroy-preview'].with, {
    'pr-number': '${{ github.event.pull_request.number }}',
    'base-sha': '${{ github.event.pull_request.base.sha }}',
    'preview-url':
      'https://pr-${{ github.event.pull_request.number }}.staging.app.windrun.ai',
  })
})

function assertWorkflowCallInputs(workflow, expectedInputs) {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call'])
  assert.deepEqual(workflow.on.workflow_call.inputs, expectedInputs)
  assert.equal(workflow.on.workflow_call.secrets, undefined)
  assert.equal(Object.keys(workflow.jobs).length, 1)
}

function assertPreviewJobBoundary(job) {
  assert.equal(job.environment, 'preview')
  assert.deepEqual(job.permissions, {
    contents: 'read',
    'id-token': 'write',
    'pull-requests': 'write',
  })
  assert.deepEqual(job.concurrency, {
    group: 'windrun-preview-${{ inputs.pr-number }}',
    'cancel-in-progress': false,
  })
  assert.equal(job.secrets, undefined)
}

test('preview deploy revalidates immutable event data before trusted steps', () => {
  const workflow = readWorkflow(previewDeployWorkflow)
  const source = readWorkflowSource(previewDeployWorkflow)
  assertWorkflowCallInputs(workflow, {
    'pr-number': { type: 'number', required: true },
    'merge-sha': { type: 'string', required: true },
    'preview-url': { type: 'string', required: true },
  })
  assert.doesNotMatch(source, /pull_request_target/u)

  const job = workflow.jobs.deploy
  assertPreviewJobBoundary(job)
  assertIncludesEvery(job.if, [
    "github.event_name == 'pull_request'",
    "github.event.action == 'opened'",
    "github.event.action == 'reopened'",
    "github.event.action == 'synchronize'",
    "github.event.pull_request.base.ref == 'main'",
    'github.event.pull_request.base.repo.id == github.event.repository.id',
    'github.event.pull_request.head.repo.id == github.event.repository.id',
    'github.event.pull_request.head.repo.full_name == github.repository',
    'inputs.pr-number == github.event.pull_request.number',
    'inputs.merge-sha == github.event.pull_request.merge_commit_sha',
    "inputs.preview-url == format('https://pr-{0}.staging.app.windrun.ai', github.event.pull_request.number)",
  ])

  assertImmutableExternalActions(workflow)
  const checkouts = job.steps.filter((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )
  assert.equal(checkouts.length, 2)
  assert.deepEqual(checkouts.map((step) => step.with), [
    {
      ref: 'refs/heads/main',
      path: 'platform',
      'persist-credentials': false,
    },
    {
      ref: '${{ inputs.merge-sha }}',
      path: 'source',
      'persist-credentials': false,
    },
  ])
  const authIndex = job.steps.findIndex(
    (step) => step.uses === './platform/.github/actions/auth-cloud',
  )
  assert.ok(authIndex > job.steps.indexOf(checkouts[1]))
  assert.equal(job.steps.some((step) => step.uses?.startsWith('./source')), false)
  assert.equal(
    job.steps.some((step) => step['working-directory'] === 'source'),
    false,
  )

  const setup = job.steps.find(
    (step) => step.uses === './platform/.github/actions/setup',
  )
  assert.deepEqual(setup?.with, { 'working-directory': 'platform' })
  const pulumiSteps = job.steps.filter((step) => step.uses === pulumiAction)
  assert.equal(pulumiSteps.length, 2)
  for (const step of pulumiSteps) {
    assert.equal(
      step.with['stack-name'],
      '${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/pr-${{ inputs.pr-number }}',
    )
    assert.equal(step.with['work-dir'], 'platform/infra')
    assert.equal(step.with.upsert, true)
    assert.deepEqual(parse(step.with['config-map']), {
      'windrun-ai:stackKind': { value: 'preview' },
      'windrun-ai:pullRequestNumber': { value: '${{ inputs.pr-number }}' },
      'windrun-ai:gitCommitSha': { value: '${{ inputs.merge-sha }}' },
    })
    assert.equal(
      step.env.WINDRUN_APP_SOURCE,
      '${{ github.workspace }}/source',
    )
  }
  assert.equal(pulumiSteps[0].with.command, 'preview')
  assert.equal(pulumiSteps[1].id, 'up')
  assert.equal(pulumiSteps[1].with.command, 'up')

  const smoke = job.steps.find((step) => step.id === 'smoke')
  assert.equal(
    smoke?.run,
    'node platform/scripts/ci/smoke-test.mjs "${{ inputs.preview-url }}/api/health" --attempts 30 --delay-ms 10000',
  )
  const comment = job.steps.at(-1)
  assert.equal(comment.if, 'always()')
  assert.equal(comment.run, 'node platform/scripts/ci/upsert-preview-comment.mjs')
  assert.equal(comment.env.GITHUB_TOKEN, '${{ github.token }}')
  assert.match(comment.env.PREVIEW_STATE, /steps\.up\.outcome/u)
  assert.match(comment.env.PREVIEW_STATE, /steps\.smoke\.outcome/u)
})

test('preview destroy shares the queue and runs only trusted main code', () => {
  const workflow = readWorkflow(previewDestroyWorkflow)
  const source = readWorkflowSource(previewDestroyWorkflow)
  assertWorkflowCallInputs(workflow, {
    'pr-number': { type: 'number', required: true },
    'base-sha': { type: 'string', required: true },
    'preview-url': { type: 'string', required: true },
  })
  assert.doesNotMatch(source, /pull_request_target/u)

  const job = workflow.jobs.destroy
  assertPreviewJobBoundary(job)
  assertIncludesEvery(job.if, [
    "github.event_name == 'pull_request'",
    "github.event.action == 'closed'",
    "github.event.pull_request.base.ref == 'main'",
    'github.event.pull_request.base.repo.id == github.event.repository.id',
    'github.event.pull_request.head.repo.id == github.event.repository.id',
    'github.event.pull_request.head.repo.full_name == github.repository',
    'inputs.pr-number == github.event.pull_request.number',
    'inputs.base-sha == github.event.pull_request.base.sha',
    "inputs.preview-url == format('https://pr-{0}.staging.app.windrun.ai', github.event.pull_request.number)",
  ])

  assertImmutableExternalActions(workflow)
  const checkouts = job.steps.filter((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )
  assert.equal(checkouts.length, 1)
  assert.deepEqual(checkouts[0].with, {
    ref: 'refs/heads/main',
    path: 'platform',
    'persist-credentials': false,
  })
  const authIndex = job.steps.findIndex(
    (step) => step.uses === './platform/.github/actions/auth-cloud',
  )
  assert.ok(authIndex > job.steps.indexOf(checkouts[0]))
  const installPulumi = job.steps.find((step) => step.uses === pulumiAction)
  assert.ok(installPulumi)
  assert.equal(installPulumi.with?.command, undefined)
  assert.equal(installPulumi.with?.['work-dir'], 'platform/infra')

  const destroy = job.steps.find((step) => step.id === 'destroy')
  assert.equal(
    destroy?.run,
    'node platform/scripts/ci/destroy-preview.mjs "${{ vars.PULUMI_ORGANIZATION }}/windrun-ai/pr-${{ inputs.pr-number }}"',
  )
  const comment = job.steps.at(-1)
  assert.equal(comment.run, 'node platform/scripts/ci/upsert-preview-comment.mjs')
  assert.equal(comment.env.PREVIEW_STATE, 'destroyed')
  assert.equal(comment.env.GITHUB_TOKEN, '${{ github.token }}')
})

test('setup action supports a trusted checkout subdirectory', () => {
  const action = parse(
    readFileSync(
      resolve(repositoryRoot, '.github', 'actions', 'setup', 'action.yml'),
      'utf8',
    ),
  )
  assert.deepEqual(action.inputs?.['working-directory'], {
    description: 'Directory containing the pnpm workspace',
    required: false,
    default: '.',
  })
  const install = action.runs.steps.find((step) =>
    step.run?.includes('pnpm install'),
  )
  assert.equal(install?.['working-directory'], '${{ inputs.working-directory }}')
})

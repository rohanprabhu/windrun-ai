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

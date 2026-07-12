import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateContract } from './validate-contract.mjs'

const VALIDATOR_PATH = fileURLToPath(new URL('./validate-contract.mjs', import.meta.url))

const REQUIRED_SCRIPTS = {
  lint: 'lint',
  typecheck: 'typecheck',
  test: 'test',
  'test:infra': 'test:infra',
  build: 'build',
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function createFixture({
  packageJson = {},
  pulumiName = 'windrun-ai',
  deliveryStackKind = 'delivery',
  infraDependencies = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'windrun-ci-contract-'))
  const infraRoot = join(root, 'infra')
  const deliveryRoot = join(infraRoot, 'src', 'delivery')
  const opsRoot = join(root, 'scripts', 'ops')

  mkdirSync(deliveryRoot, { recursive: true })
  mkdirSync(opsRoot, { recursive: true })
  writeJson(join(root, 'package.json'), {
    packageManager: 'pnpm@11.7.0',
    scripts: REQUIRED_SCRIPTS,
    ...packageJson,
  })
  writeFileSync(join(infraRoot, 'Pulumi.yaml'), `name: ${pulumiName}\n`)
  writeFileSync(
    join(infraRoot, 'Pulumi.delivery.yaml'),
    `config:\n  windrun-ai:stackKind: ${deliveryStackKind}\n`,
  )
  writeJson(join(infraRoot, 'package.json'), {
    dependencies: {
      '@pulumi/github': '1.0.0',
      '@pulumi/pulumiservice': '1.0.0',
      ...infraDependencies,
    },
  })

  for (const file of ['index.ts', 'github.ts', 'pulumi-oidc.ts']) {
    writeFileSync(join(deliveryRoot, file), '')
  }
  writeFileSync(join(opsRoot, 'bootstrap-foundation-secret.sh'), '')

  return root
}

function removeFixture(root) {
  rmSync(root, { recursive: true, force: true })
}

test('accepts the complete CI delivery contract', () => {
  const validRoot = createFixture()

  try {
    assert.deepEqual(validateContract(validRoot), [])
  } finally {
    removeFixture(validRoot)
  }
})

test('reports a missing quality script', () => {
  const rootMissingTypecheck = createFixture({
    packageJson: {
      scripts: Object.fromEntries(
        Object.entries(REQUIRED_SCRIPTS).filter(([name]) => name !== 'typecheck'),
      ),
    },
  })

  try {
    assert.deepEqual(validateContract(rootMissingTypecheck), [
      'package.json is missing script "typecheck"',
    ])
  } finally {
    removeFixture(rootMissingTypecheck)
  }
})

test('reports the wrong Pulumi project name', () => {
  const rootWithWrongPulumiName = createFixture({ pulumiName: 'other-project' })

  try {
    assert.deepEqual(validateContract(rootWithWrongPulumiName), [
      'infra/Pulumi.yaml must declare name: windrun-ai',
    ])
  } finally {
    removeFixture(rootWithWrongPulumiName)
  }
})

test('reports an unpinned pnpm package manager', () => {
  const root = createFixture({ packageJson: { packageManager: 'npm@11.0.0' } })

  try {
    assert.deepEqual(validateContract(root), [
      'package.json packageManager must begin with pnpm@',
    ])
  } finally {
    removeFixture(root)
  }
})

test('reports a non-string package manager without throwing', () => {
  const root = createFixture({ packageJson: { packageManager: 11 } })

  try {
    assert.deepEqual(validateContract(root), [
      'package.json packageManager must begin with pnpm@',
    ])
  } finally {
    removeFixture(root)
  }
})

test('reports the wrong delivery stack kind', () => {
  const root = createFixture({ deliveryStackKind: 'foundation' })

  try {
    assert.deepEqual(validateContract(root), [
      'infra/Pulumi.delivery.yaml must declare windrun-ai:stackKind: delivery',
    ])
  } finally {
    removeFixture(root)
  }
})

test('reports missing delivery source files', () => {
  const root = createFixture()

  try {
    rmSync(join(root, 'infra', 'src', 'delivery', 'github.ts'))
    assert.deepEqual(validateContract(root), [
      'infra/src/delivery/github.ts must exist',
    ])
  } finally {
    removeFixture(root)
  }
})

test('reports a missing foundation secret handoff script', () => {
  const root = createFixture()

  try {
    rmSync(join(root, 'scripts', 'ops', 'bootstrap-foundation-secret.sh'))
    assert.deepEqual(validateContract(root), [
      'scripts/ops/bootstrap-foundation-secret.sh must exist',
    ])
  } finally {
    removeFixture(root)
  }
})

test('reports missing Pulumi delivery dependencies', () => {
  const root = createFixture()

  try {
    writeJson(join(root, 'infra', 'package.json'), { dependencies: {} })
    assert.deepEqual(validateContract(root), [
      'infra/package.json is missing dependency "@pulumi/github"',
      'infra/package.json is missing dependency "@pulumi/pulumiservice"',
    ])
  } finally {
    removeFixture(root)
  }
})

const invalidJsonDocuments = [
  ['null', null],
  ['a scalar', 0],
  ['an array', []],
]

for (const [label, document] of invalidJsonDocuments) {
  test(`rejects ${label} as the root package document`, () => {
    const root = createFixture()

    try {
      writeJson(join(root, 'package.json'), document)
      assert.deepEqual(validateContract(root), [
        'package.json must contain a JSON object',
      ])
    } finally {
      removeFixture(root)
    }
  })

  test(`rejects ${label} as the infra package document`, () => {
    const root = createFixture()

    try {
      writeJson(join(root, 'infra', 'package.json'), document)
      assert.deepEqual(validateContract(root), [
        'infra/package.json must contain a JSON object',
      ])
    } finally {
      removeFixture(root)
    }
  })
}

test('prints the success contract and exits zero for a valid root', () => {
  const root = createFixture()

  try {
    const result = spawnSync(process.execPath, [VALIDATOR_PATH], {
      cwd: root,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'CI contract OK: windrun-ai\n')
    assert.equal(result.stderr, '')
  } finally {
    removeFixture(root)
  }
})

test('prints contract errors and exits nonzero for an invalid root', () => {
  const root = createFixture({
    packageJson: {
      scripts: Object.fromEntries(
        Object.entries(REQUIRED_SCRIPTS).filter(([name]) => name !== 'typecheck'),
      ),
    },
  })

  try {
    const result = spawnSync(process.execPath, [VALIDATOR_PATH], {
      cwd: root,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'package.json is missing script "typecheck"\n')
  } finally {
    removeFixture(root)
  }
})

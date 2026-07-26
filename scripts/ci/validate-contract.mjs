import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const QUALITY_SCRIPTS = ['lint', 'typecheck', 'test', 'test:infra', 'build']
const DELIVERY_SOURCES = ['index.ts', 'github.ts', 'pulumi-oidc.ts']
const DELIVERY_DEPENDENCIES = ['@pulumi/github', '@pulumi/pulumiservice']

function readJson(path, displayPath, errors) {
  if (!existsSync(path)) {
    errors.push(`${displayPath} must exist`)
    return undefined
  }

  try {
    const document = JSON.parse(readFileSync(path, 'utf8'))
    if (
      document === null ||
      typeof document !== 'object' ||
      Array.isArray(document)
    ) {
      errors.push(`${displayPath} must contain a JSON object`)
      return undefined
    }
    return document
  } catch {
    errors.push(`${displayPath} must contain valid JSON`)
    return undefined
  }
}

function readYaml(path) {
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function validateContract(root) {
  const errors = []
  const packageJson = readJson(
    resolve(root, 'package.json'),
    'package.json',
    errors,
  )

  if (packageJson) {
    if (
      typeof packageJson.packageManager !== 'string' ||
      !packageJson.packageManager.startsWith('pnpm@')
    ) {
      errors.push('package.json packageManager must begin with pnpm@')
    }

    for (const script of QUALITY_SCRIPTS) {
      if (typeof packageJson.scripts?.[script] !== 'string') {
        errors.push(`package.json is missing script "${script}"`)
      }
    }
  }

  const pulumiProject = readYaml(resolve(root, 'infra', 'Pulumi.yaml'))
  if (pulumiProject?.name !== 'windrun-ai') {
    errors.push('infra/Pulumi.yaml must declare name: windrun-ai')
  }

  const deliveryConfigPath = resolve(root, 'infra', 'Pulumi.delivery.yaml')
  if (!existsSync(deliveryConfigPath)) {
    errors.push('infra/Pulumi.delivery.yaml must exist')
  } else {
    const deliveryConfig = readYaml(deliveryConfigPath)
    if (deliveryConfig?.config?.['windrun-ai:stackKind'] !== 'delivery') {
      errors.push(
        'infra/Pulumi.delivery.yaml must declare windrun-ai:stackKind: delivery',
      )
    }
  }

  for (const source of DELIVERY_SOURCES) {
    const displayPath = `infra/src/delivery/${source}`
    if (!existsSync(resolve(root, displayPath))) {
      errors.push(`${displayPath} must exist`)
    }
  }

  const infraPackageJson = readJson(
    resolve(root, 'infra', 'package.json'),
    'infra/package.json',
    errors,
  )

  if (infraPackageJson) {
    const dependencies = {
      ...infraPackageJson.optionalDependencies,
      ...infraPackageJson.devDependencies,
      ...infraPackageJson.dependencies,
    }

    for (const dependency of DELIVERY_DEPENDENCIES) {
      if (typeof dependencies[dependency] !== 'string') {
        errors.push(
          `infra/package.json is missing dependency "${dependency}"`,
        )
      }
    }
  }

  return errors
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  const errors = validateContract(process.cwd())

  if (errors.length === 0) {
    console.log('CI contract OK: windrun-ai')
  } else {
    for (const error of errors) {
      console.error(error)
    }
    process.exitCode = 1
  }
}

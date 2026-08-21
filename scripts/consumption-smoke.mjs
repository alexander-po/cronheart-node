import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const { contract_version: contractVersion } = JSON.parse(
  readFileSync(join(repoRoot, 'contract', 'cronheart-contract.json'), 'utf8'),
)

const SUBPATHS = [
  'api',
  'sync',
  'testing',
  'croner',
  'cron',
  'node-cron',
  'node-schedule',
  'bullmq',
  'nestjs',
]

const workspace = mkdtempSync(join(tmpdir(), 'cronheart-smoke-'))

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function consume(flavour, { moduleType, entryFile, source }) {
  const project = join(workspace, flavour)
  mkdirSync(project)
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: `cronheart-smoke-${flavour}`, private: true, version: '0.0.0', type: moduleType }, null, 2)}\n`,
  )
  writeFileSync(join(project, entryFile), source)
  run('npm', ['install', tarball, '--no-audit', '--no-fund', '--no-package-lock', '--silent'], project)

  process.stdout.write(run('node', [entryFile], project))
}

const tarballName = run('npm', ['pack', '--silent', '--pack-destination', workspace], repoRoot).trim()
const tarball = join(workspace, tarballName)

try {
  consume('esm', {
    moduleType: 'module',
    entryFile: 'index.mjs',
    source: `import assert from 'node:assert/strict'
${SUBPATHS.map((subpath) => `import 'cronheart/${subpath}'`).join('\n')}
import { SDK_VERSION, checkIn, userAgent } from 'cronheart'

assert.ok(import.meta.resolve('cronheart/cli').endsWith('/dist/cli.mjs'))

assert.equal(SDK_VERSION, ${JSON.stringify(pkg.version)})
assert.ok(userAgent().startsWith(${JSON.stringify(`cronheart-node/${pkg.version} `)}))

const result = await checkIn('a-monitor-nobody-configured')

assert.equal(result.outcome, 'suppressed')
assert.equal(result.sent, false)
console.log('esm consumption ok —', userAgent())
`,
  })

  consume('cjs', {
    moduleType: 'commonjs',
    entryFile: 'index.cjs',
    source: `const assert = require('node:assert/strict')
${SUBPATHS.map((subpath) => `require('cronheart/${subpath}')`).join('\n')}
const { SDK_VERSION, checkIn, userAgent } = require('cronheart')

assert.ok(require.resolve('cronheart/cli').endsWith('/dist/cli.mjs'))

assert.equal(SDK_VERSION, ${JSON.stringify(pkg.version)})
assert.ok(userAgent().startsWith(${JSON.stringify(`cronheart-node/${pkg.version} `)}))

checkIn('a-monitor-nobody-configured').then((result) => {
  assert.equal(result.outcome, 'suppressed')
  assert.equal(result.sent, false)
  console.log('cjs consumption ok —', userAgent())
})
`,
  })
  const esmProject = join(workspace, 'esm')
  const bin = join(esmProject, 'node_modules', '.bin', 'cronheart')
  const reported = run(bin, ['--version'], esmProject).trim()

  if (reported !== `${pkg.name} ${pkg.version} (contract ${contractVersion})`) {
    throw new Error(`the installed bin reported ${JSON.stringify(reported)}`)
  }

  // The route the specifier exists for: resolve it, then run what it resolved to. A global
  // install is not the only way onto a machine, and a bin shim is not a specifier.
  const resolved = run(
    'node',
    ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('cronheart/cli'))"],
    esmProject,
  ).trim()
  const throughTheSpecifier = run('node', [fileURLToPath(resolved), '--version'], esmProject).trim()

  if (throughTheSpecifier !== reported) {
    throw new Error(`the resolved cli reported ${JSON.stringify(throughTheSpecifier)}`)
  }

  process.stdout.write(`bin consumption ok — ${reported}\n`)
  process.stdout.write(`specifier consumption ok — cronheart/cli\n`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

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
  ['api', 'createCronheartApi'],
  ['sync', 'defineMonitors'],
  ['testing', 'createPingRecorder'],
  ['croner', 'monitored'],
  ['cron', 'monitored'],
  ['node-cron', 'monitor'],
  ['node-schedule', 'monitored'],
  ['bullmq', 'monitored'],
  ['nestjs', 'CronheartModule'],
]

// An allow-list rather than a deny-list: an entry nobody thought to exclude
// still fails the smoke.
const TARBALL_ENTRY_ALLOWED = new RegExp(
  `^package/(?:package\\.json|README\\.md|LICENSE|CHANGELOG\\.md|dist/[^/]+\\.(?:mjs|cjs|d\\.mts|d\\.cts)|(?:${SUBPATHS.map(
    ([subpath]) => subpath,
  ).join('|')})/package\\.json)$`,
)

// npm runs these in a consumer's install; the package promises it has none.
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare']

const TARBALL_ENTRY_REQUIRED = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/CHANGELOG.md',
  'package/dist/index.mjs',
  'package/dist/index.cjs',
  'package/dist/index.d.mts',
  'package/dist/index.d.cts',
  'package/dist/cli.mjs',
  ...SUBPATHS.flatMap(([subpath]) => [
    `package/${subpath}/package.json`,
    `package/dist/${subpath}.mjs`,
    `package/dist/${subpath}.cjs`,
  ]),
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
  const entries = run('tar', ['-tzf', tarball], workspace)
    .split('\n')
    .filter((entry) => entry !== '' && !entry.endsWith('/'))

  const unexpected = entries.filter((entry) => !TARBALL_ENTRY_ALLOWED.test(entry))
  const missing = TARBALL_ENTRY_REQUIRED.filter((entry) => !entries.includes(entry))

  if (unexpected.length > 0) {
    throw new Error(`the tarball carries ${unexpected.length} file(s) outside the published surface: ${unexpected.join(', ')}`)
  }

  if (missing.length > 0) {
    throw new Error(`the tarball is missing ${missing.length} file(s) the export map resolves to: ${missing.join(', ')}`)
  }

  const packed = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json'], workspace))

  if (packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error(`the tarball's manifest reads ${packed.name}@${packed.version}`)
  }

  const runtimeDependencies = Object.keys(packed.dependencies ?? {})
  const installHooks = INSTALL_LIFECYCLE.filter((hook) => packed.scripts?.[hook] !== undefined)

  if (runtimeDependencies.length > 0) {
    throw new Error(`the tarball declares ${runtimeDependencies.length} runtime dependency(ies): ${runtimeDependencies.join(', ')}`)
  }

  if (installHooks.length > 0) {
    throw new Error(`the tarball runs on install: ${installHooks.join(', ')}`)
  }

  process.stdout.write(
    `tarball ok — ${entries.length} file(s), every one of them published on purpose; no runtime dependency, nothing run on install\n`,
  )

  consume('esm', {
    moduleType: 'module',
    entryFile: 'index.mjs',
    source: `import assert from 'node:assert/strict'
${SUBPATHS.map(([subpath, exported], index) => `import { ${exported} as subpath${index} } from 'cronheart/${subpath}'`).join('\n')}
import { SDK_VERSION, checkIn, userAgent } from 'cronheart'

${SUBPATHS.map(([subpath], index) => `assert.equal(typeof subpath${index}, 'function', 'cronheart/${subpath}')`).join('\n')}

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
${SUBPATHS.map(([subpath, exported], index) => `const subpath${index} = require('cronheart/${subpath}').${exported}`).join('\n')}
const { SDK_VERSION, checkIn, userAgent } = require('cronheart')

${SUBPATHS.map(([subpath], index) => `assert.equal(typeof subpath${index}, 'function', 'cronheart/${subpath}')`).join('\n')}

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

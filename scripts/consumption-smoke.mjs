import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

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
import { SDK_VERSION, userAgent } from 'cronheart'

assert.equal(SDK_VERSION, ${JSON.stringify(pkg.version)})
assert.ok(userAgent().startsWith(${JSON.stringify(`cronheart-node/${pkg.version} `)}))
console.log('esm consumption ok —', userAgent())
`,
  })

  consume('cjs', {
    moduleType: 'commonjs',
    entryFile: 'index.cjs',
    source: `const assert = require('node:assert/strict')
${SUBPATHS.map((subpath) => `require('cronheart/${subpath}')`).join('\n')}
const { SDK_VERSION, userAgent } = require('cronheart')

assert.equal(SDK_VERSION, ${JSON.stringify(pkg.version)})
assert.ok(userAgent().startsWith(${JSON.stringify(`cronheart-node/${pkg.version} `)}))
console.log('cjs consumption ok —', userAgent())
`,
  })
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

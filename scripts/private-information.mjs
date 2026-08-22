import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// This repository is public and the service behind it is not. The strongest scan for that
// boundary cannot live here, because its deny-list would be the private vocabulary itself.
// What is here is the half that names nothing: shapes a leak takes whatever it is called.

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.pnpm-store',
  'doc-samples',
])

// The trees that hold the shapes this scan exists to find. Nothing else may be added here:
// a path on this list is a path the scan does not read.
const SKIPPED_PATHS = new Set([
  'test/fixtures/private-information',
  'test/fixtures/release-metadata',
])

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.tgz',
  '.gz',
  '.zip',
])

// A home directory belonging to a person rather than to a container's own service account.
const DEVELOPER_HOME = /(?:^|[\s"'`(=:])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([\w.-]+)[/\\]/g

const CONTAINER_ACCOUNTS = new Set(['node', 'runner', 'root', 'app', 'user'])

const EMAIL = /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g

const PUBLISHABLE_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost|users\.noreply\.github\.com)$/

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

const PLACEHOLDER_UUID = /^0{8}-0{4}-/

const CROSS_REPOSITORY_REFERENCE =
  /(?:\bgithub\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+|(?:^|\s)([\w.-]+\/[\w.-]+)#\d+)/g

const PHP_SHAPES = [
  { id: 'php-open-tag', pattern: /<\?php\b/ },
  { id: 'php-file-reference', pattern: /\b[\w/-]+\.php\b/ },
  { id: 'php-namespace', pattern: /\b(?:namespace|use)\s+[A-Z]\w*(?:\\[A-Z]\w*)+/ },
]

const CREDENTIAL_SHAPES = [
  { id: 'private-key-block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { id: 'vendor-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/ },
  {
    id: 'assigned-secret',
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|token|authorization)\b\s*[:=]\s*["'`]?([A-Za-z0-9+/=_-]{24,})(?![\w.])/i,
    guard: looksIssued,
  },
]

// A placeholder is written to be read: it repeats a filler character and reuses a small
// alphabet, where anything a service actually issued does neither.
function looksIssued(value) {
  return new Set(value).size >= 12 && !/(.)\1{5,}/.test(value)
}

// Every address a document may carry, so anything outside them is a real host somewhere.
const RESERVED_ADDRESS =
  /^(?:0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+|255\.255\.255\.\d+)$/

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g

function ownRepository() {
  try {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const named = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(manifest.repository?.url ?? '')

    return named === null ? undefined : named[1]
  } catch {
    return undefined
  }
}

function credentialPrefix() {
  try {
    const contract = readFileSync(join(repoRoot, 'contract/cronheart-contract.json'), 'utf8')
    const prefix = /"token_prefix"\s*:\s*"([^"]+)"/.exec(contract)

    return prefix === null ? undefined : prefix[1]
  } catch {
    return undefined
  }
}

function textFilesUnder(root) {
  const found = []
  const skipped = []

  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (SKIPPED_DIRECTORIES.has(entry)) {
        continue
      }

      const path = join(directory, entry)

      if (SKIPPED_PATHS.has(relative(root, path))) {
        continue
      }

      if (statSync(path).isDirectory()) {
        // A directory carrying its own .git is a working tree in its own right, not this one.
        if (existsSync(join(path, '.git'))) {
          skipped.push(relative(root, path))
          continue
        }

        walk(path)
        continue
      }

      if (BINARY_EXTENSIONS.has(extname(path))) {
        continue
      }

      found.push(path)
    }
  }

  walk(root)

  return { found, skipped }
}

function disclosuresIn(label, text, { repository, prefix }) {
  const found = []
  const report = (id, line, detail) => {
    found.push({ id, where: `${label}:${line}`, detail })
  }

  text.split('\n').forEach((line, offset) => {
    const at = offset + 1

    for (const [, account] of line.matchAll(DEVELOPER_HOME)) {
      if (!CONTAINER_ACCOUNTS.has(account)) {
        report('developer-path', at, `a home directory belonging to ${account}`)
      }
    }

    for (const [address, domain] of line.matchAll(EMAIL)) {
      if (!PUBLISHABLE_EMAIL_DOMAIN.test(domain)) {
        report('reachable-address', at, address)
      }
    }

    for (const [identifier] of line.matchAll(UUID)) {
      if (!PLACEHOLDER_UUID.test(identifier)) {
        report('live-identifier', at, identifier)
      }
    }

    for (const [reference, byUrl, byShorthand] of line.matchAll(CROSS_REPOSITORY_REFERENCE)) {
      const named = (byUrl ?? byShorthand ?? '').trim()

      if (named !== '' && named !== repository) {
        report('another-repository', at, reference.trim())
      }
    }

    for (const [address] of line.matchAll(IPV4)) {
      if (!RESERVED_ADDRESS.test(address)) {
        report('routable-address', at, address)
      }
    }

    for (const shape of [...PHP_SHAPES, ...CREDENTIAL_SHAPES]) {
      const matched = shape.pattern.exec(line)

      if (matched !== null && (shape.guard === undefined || shape.guard(matched[1] ?? ''))) {
        report(shape.id, at, line.trim().slice(0, 80))
      }
    }

    const carried = prefix === undefined ? null : new RegExp(`${prefix}([A-Za-z0-9_-]{16,})`).exec(line)

    if (carried !== null && looksIssued(carried[1])) {
      report('issued-credential', at, `a value carrying the service's token prefix`)
    }
  })

  return found
}

export function scanTree(root) {
  const context = { repository: ownRepository(), prefix: credentialPrefix() }
  const { found, skipped } = textFilesUnder(root)

  return {
    read: found.length,
    skipped,
    disclosures: found.flatMap((path) => {
      let text

      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return []
      }

      return disclosuresIn(relative(root, path), text, context)
    }),
  }
}

export function scanTarball(tarball, workspace) {
  const unpacked = join(workspace, 'unpacked')

  execFileSync('mkdir', ['-p', unpacked])
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked])

  return scanTree(unpacked)
}

// The count and the skips are the report, not decoration: a scan that read nothing says the
// same thing about a tree as a scan that read all of it, and a skip nobody sees is a hole.
export function reportDisclosures(subject, scan, out = process.stdout, err = process.stderr) {
  const { disclosures, read, skipped } = scan
  const coverage = `${read} file(s) read${skipped.map((path) => `, skipped the checkout at ${path}`).join('')}`

  if (disclosures.length === 0) {
    out.write(
      `private information — ${subject} carries none of the shapes this scan knows (${coverage})\n`,
    )

    return true
  }

  for (const disclosure of disclosures) {
    err.write(`  - ${disclosure.id}: ${disclosure.where} — ${disclosure.detail}\n`)
  }

  err.write(
    `private information FAILED — ${disclosures.length} disclosure(s) in ${subject} (${coverage})\n`,
  )

  return false
}

function main() {
  const target = process.argv[2] ?? '.'
  const root = join(process.cwd(), target)

  if (!reportDisclosures(target, scanTree(root))) {
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}

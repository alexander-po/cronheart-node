import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// What a registry page renders and what the tarball says about itself, held against each
// other and against the tree. Kept out of the pull-request gate on purpose: a branch is
// supposed to carry an unconsumed changeset, and a release is supposed to carry none.
const root = process.argv[2] === undefined ? fileURLToPath(new URL('../', import.meta.url)) : `${resolve(process.argv[2])}/`

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

const CONTRACT_NEARBY = /contract[^.\n]{0,60}?(\d+\.\d+\.\d+)|(\d+\.\d+\.\d+)[^.\n]{0,30}?contract/gi

const DESCRIBED_DOCUMENTS = ['README.md', 'CHANGELOG.md', 'CLAUDE.md', 'SECURITY.md', 'RELEASING.md']

const failures = []

function fail(where, what) {
  failures.push(`${where} — ${what}`)
}

function read(name) {
  const path = join(root, name)

  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

const manifest = JSON.parse(read('package.json') ?? '{}')
const contract = JSON.parse(read('contract/cronheart-contract.json') ?? '{}')

function checkPendingChangesets() {
  const directory = join(root, '.changeset')

  if (!existsSync(directory)) {
    fail('.changeset', 'is absent, so nothing records what a release contains')

    return 0
  }

  const pending = readdirSync(directory).filter(
    (entry) => entry.endsWith('.md') && entry !== 'README.md',
  )

  for (const entry of pending) {
    const level = /'[^']+':\s*(\w+)/.exec(readFileSync(join(directory, entry), 'utf8'))?.[1]

    fail(
      `.changeset/${entry}`,
      `is unconsumed (${level ?? 'unread'}), so CHANGELOG.md does not describe this tree — fold it in with a version run first`,
    )
  }

  return pending.length
}

function checkChangelog() {
  const changelog = read('CHANGELOG.md')

  if (changelog === undefined) {
    fail('CHANGELOG.md', 'is absent and the manifest publishes it')

    return
  }

  const newest = /^## \[?(\d+\.\d+\.\d+[\w.-]*)\]?/m.exec(changelog)?.[1]

  if (newest === undefined) {
    fail('CHANGELOG.md', 'carries no version heading, so nothing states what was released')

    return
  }

  if (newest !== manifest.version) {
    fail('CHANGELOG.md', `its newest entry is ${newest} and the manifest publishes ${manifest.version}`)
  }
}

// The wire contract's version rides in the User-Agent and prints from the binary, so a
// document quoting a different one sends a reader looking for a document that never existed.
function checkContractVersion() {
  const stated = contract.contract_version
  let compared = 0

  if (typeof stated !== 'string' || !SEMVER.test(stated)) {
    fail('contract/cronheart-contract.json', 'declares no contract version')

    return 0
  }

  for (const name of DESCRIBED_DOCUMENTS) {
    const text = read(name)

    if (text === undefined) {
      continue
    }

    text.split('\n').forEach((line, offset) => {
      for (const [, before, after] of line.matchAll(CONTRACT_NEARBY)) {
        const quoted = before ?? after

        compared += 1

        if (quoted !== stated) {
          fail(`${name}:${offset + 1}`, `quotes contract ${quoted} and the contract declares ${stated}`)
        }
      }
    })
  }

  if (compared === 0) {
    fail('contract version', 'is quoted in no document, so nothing was compared')
  }

  return compared
}

function checkRegistryFields() {
  const licence = read('LICENSE')
  const required = ['name', 'version', 'description', 'license', 'author', 'homepage']

  for (const field of required) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      fail('package.json', `has no ${field}, and a registry page renders it`)
    }
  }

  if (typeof manifest.version === 'string' && !SEMVER.test(manifest.version)) {
    fail('package.json', `version ${manifest.version} is not a version`)
  }

  if ((manifest.keywords ?? []).length < 5) {
    fail('package.json', 'carries fewer than five keywords, which is the whole of its discoverability')
  }

  if (typeof manifest.description === 'string' && manifest.description.length < 50) {
    fail('package.json', 'description is too short to say what the package is')
  }

  if (licence === undefined) {
    fail('LICENSE', 'is absent and the manifest names a licence')
  } else {
    if (typeof manifest.license === 'string' && !licence.includes(manifest.license)) {
      fail('LICENSE', `does not name the ${manifest.license} licence the manifest declares`)
    }

    if (typeof manifest.author === 'string' && !licence.includes(manifest.author)) {
      fail('LICENSE', `does not carry the copyright of ${manifest.author}`)
    }
  }

  const repository = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(manifest.repository?.url ?? '')?.[1]

  if (repository === undefined) {
    fail('package.json', 'repository.url does not name a repository, and the registry matches a publish against it')

    return
  }

  for (const [field, url] of [
    ['bugs.url', manifest.bugs?.url],
    ['homepage', manifest.homepage],
  ]) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      fail('package.json', `${field} is not an https address`)
    }
  }

  if (typeof manifest.bugs?.url === 'string' && !manifest.bugs.url.includes(repository)) {
    fail('package.json', `bugs.url does not point into ${repository}`)
  }

  for (const name of DESCRIBED_DOCUMENTS) {
    const text = read(name)

    if (text === undefined) {
      continue
    }

    text.split('\n').forEach((line, offset) => {
      for (const [, named] of line.matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:[/)\s.]|$)/g)) {
        if (named !== repository && !named.startsWith('actions/') && !named.startsWith('pnpm/')) {
          fail(`${name}:${offset + 1}`, `names github.com/${named} and the manifest publishes ${repository}`)
        }
      }
    })
  }
}

const pending = checkPendingChangesets()
checkChangelog()
const compared = checkContractVersion()
checkRegistryFields()

const tally = `${manifest.name}@${manifest.version}, contract ${contract.contract_version}, ${pending} pending changeset(s), ${compared} contract quote(s)`

if (failures.length === 0) {
  process.stdout.write(`release metadata — ${tally}, ready\n`)
} else {
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`)
  }

  process.stderr.write(`release metadata FAILED — ${failures.length} problem(s) in ${tally}\n`)
  process.exit(1)
}

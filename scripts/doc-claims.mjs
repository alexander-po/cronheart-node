import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

// The documents are an argument so this check can be pointed at a fixture and proven able to
// fail. What it reads them against — the built program, the manifest, the Makefile, the
// source — stays the real package either way.
const docsRoot = process.argv[2] === undefined ? repoRoot : `${resolve(process.argv[2])}/`

const DOCUMENTS = [
  'README.md',
  'SECURITY.md',
  'RELEASING.md',
  'CLAUDE.md',
  'src/cli/help.ts',
  'src/cli/help-pages.ts',
]

const SAMPLE_LANGUAGES = new Set(['ts', 'js', 'mts', 'typescript', 'javascript'])

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'console', 'cron'])

// A flag on a line that names another program belongs to that program. Node's own
// --env-file is discussed here precisely because it collides with one of ours.
const FOREIGN_PROGRAM = /\b(?:npm|pnpm|npx|node|docker|git|tsc|make|curl|corepack|changeset|tar|yarn|bun)\b/i

// Flags these documents discuss because they belong to another program. Each is probed like
// any other, so the day cronheart grows one of these names the entry stops being true and
// this check says so rather than quietly excusing a real flag.
const FOREIGN_FLAGS = new Map([
  ['env-file', 'node'],
  ['experimental-strip-types', 'node'],
  ['location', 'npm'],
])

const RECIPE = /^(make|pnpm run) ([\w:-]+)$/

const SENTINEL = 'a-flag-no-cronheart-command-declares'

const ROOT_FLAGS = new Set(['help', 'version'])

const SAMPLES_DIRECTORY = join(repoRoot, 'test/fixture-consumer/doc-samples')

const SAMPLE_PROJECT = 'test/fixture-consumer/tsconfig.doc-samples.json'

const cli = join(repoRoot, 'dist/cli.mjs')

const failures = []

function fail(where, what) {
  failures.push(`${where} — ${what}`)
}

function documents() {
  return DOCUMENTS.filter((name) => existsSync(join(docsRoot, name))).map((name) => ({
    name,
    text: readFileSync(join(docsRoot, name), 'utf8'),
  }))
}

function fencedBlocks({ name, text }) {
  const blocks = []
  let open

  text.split('\n').forEach((line, offset) => {
    const fence = /^```([A-Za-z]*)\s*$/.exec(line)

    if (fence === null) {
      open?.code.push(line)

      return
    }

    if (open === undefined) {
      open = { language: fence[1].toLowerCase(), line: offset + 1, code: [] }

      return
    }

    blocks.push({ file: name, language: open.language, line: open.line, code: open.code.join('\n') })
    open = undefined
  })

  if (open !== undefined) {
    fail(`${name}:${open.line}`, 'a fenced block is never closed')
  }

  return blocks
}

// The shipped help pages hold their samples indented inside a template literal rather than
// fenced, and a sample a reader meets through --help rots the way a fenced one does.
function indentedBlocks({ name, text }) {
  const lines = text.split('\n')
  const blocks = []

  for (let offset = 0; offset < lines.length; offset += 1) {
    const opens = /^(\s{4,})import\s/.exec(lines[offset])

    if (opens === null) {
      continue
    }

    const indent = opens[1].length
    const code = []
    let end = offset

    for (; end < lines.length; end += 1) {
      const line = lines[end]

      if (line.trim() === '') {
        code.push('')
        continue
      }

      if (line.search(/\S/) < indent) {
        break
      }

      code.push(line.slice(indent))
    }

    while (code.at(-1) === '') {
      code.pop()
    }

    blocks.push({ file: name, language: 'ts', line: offset + 1, code: code.join('\n') })
    offset = end
  }

  return blocks
}

function blocksIn(document) {
  return document.name.endsWith('.ts') ? indentedBlocks(document) : fencedBlocks(document)
}

function withoutComment(line) {
  return line.replace(/\s+#.*$/, '').trim()
}

// A flag is written down in a code span or a shell line and discussed in the prose around
// it. The fragment is what gets read; the line it came from is what decides whose flag it is.
function codeFragments(documents, blocks) {
  const fragments = []

  for (const { name, text } of documents) {
    if (name.endsWith('.ts')) {
      text.split('\n').forEach((line, offset) => {
        fragments.push({ file: name, line: offset + 1, text: line, context: line })
      })

      continue
    }

    text.split('\n').forEach((line, offset) => {
      for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
        fragments.push({ file: name, line: offset + 1, text: span, context: line })
      }
    })
  }

  for (const block of blocks) {
    if (!SHELL_LANGUAGES.has(block.language)) {
      continue
    }

    block.code.split('\n').forEach((line, offset) => {
      fragments.push({
        file: block.file,
        line: block.line + offset + 1,
        text: withoutComment(line),
        context: line,
      })
    })
  }

  return fragments
}

function runCli(argv) {
  const run = spawnSync(process.execPath, [cli, ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  })

  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

// The program's own refusal is the oracle: it names every flag it does not take, so the set
// it declines to name is the set it accepts. Nothing here restates a list the parser holds.
function refusedBy(command, flags) {
  const output = runCli([
    command,
    ...flags.map((flag) => `--${flag}=probe`),
    `--${SENTINEL}`,
    '--',
    'true',
  ])
  const refusal = /does not take (--.*)$/m.exec(output)

  if (refusal === null) {
    return undefined
  }

  return new Set(refusal[1].split(', ').map((flag) => flag.replace(/^--/, '').trim()))
}

function commandsOfTheProgram() {
  return [...runCli(['--help']).matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)].map((match) => match[1])
}

function writeSamples(samples) {
  rmSync(SAMPLES_DIRECTORY, { recursive: true, force: true })
  mkdirSync(SAMPLES_DIRECTORY, { recursive: true })

  samples.forEach((sample, index) => {
    const stem = `${String(index + 1).padStart(2, '0')}-${sample.file.replaceAll(/[^\w]/g, '-')}-${sample.line}`

    writeFileSync(join(SAMPLES_DIRECTORY, `${stem}.mts`), `${sample.code}\n`)
    sample.module = `${stem}.mts`
  })
}

function typecheckSamples(samples) {
  const run = spawnSync('npx', ['tsc', '--project', SAMPLE_PROJECT], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 900_000,
  })

  if (run.error !== undefined && run.error !== null) {
    fail('doc samples', `the compiler could not be started: ${run.error.message}`)

    return
  }

  if (run.status === 0) {
    return
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const reported = output.split('\n').filter((line) => /error TS\d+/.test(line))

  for (const line of reported) {
    const at = /doc-samples[/\\]([\w.-]+)\((\d+),\d+\)/.exec(line)
    const sample = samples.find((one) => one.module === at?.[1])
    const where = sample === undefined ? 'doc samples' : `${sample.file}:${sample.line}`
    const within = at === undefined || at === null ? '' : ` (sample line ${at[2]})`

    fail(where, `the sample does not compile${within} — ${line.slice(line.indexOf('error')).trim()}`)
  }

  if (reported.length === 0) {
    fail('doc samples', `the compiler refused them without naming one: ${output}`)
  }
}

function invocationsIn(fragments) {
  const invocations = []

  for (const fragment of fragments) {
    const spoken = /(?:^|\s)(?:\S*\/)?cronheart\s+(.*)$/.exec(fragment.text)

    if (spoken === null) {
      continue
    }

    const tokens = spoken[1].split(/\s+/).filter((token) => token !== '')
    const command = tokens[0]

    if (command === undefined || command.startsWith('-') || !/^[a-z][a-z-]*$/.test(command)) {
      continue
    }

    invocations.push({
      where: `${fragment.file}:${fragment.line}`,
      command,
      flags: tokens
        .slice(1)
        .filter((token) => token.startsWith('--') && token !== '--')
        .map((token) => token.slice(2).split('=')[0])
        .filter((flag) => /^[a-z][\w-]*$/.test(flag)),
    })
  }

  return invocations
}

function flagsIn(fragments, { theirs } = { theirs: false }) {
  const mentioned = new Map()

  for (const fragment of fragments) {
    if (!theirs && FOREIGN_PROGRAM.test(fragment.context)) {
      continue
    }

    for (const [, flag] of fragment.text.matchAll(/--([a-z][\w-]*)/g)) {
      if (!mentioned.has(flag)) {
        mentioned.set(flag, `${fragment.file}:${fragment.line}`)
      }
    }
  }

  return mentioned
}

function environmentVariablesIn(documents) {
  const mentioned = new Map()

  for (const { name, text } of documents) {
    text.split('\n').forEach((line, offset) => {
      for (const [, variable] of line.matchAll(/\b(CRONHEART_[A-Z_]+|CRON_MONITOR_[A-Z_]+)\b/g)) {
        if (!mentioned.has(variable)) {
          mentioned.set(variable, `${name}:${offset + 1}`)
        }
      }
    })
  }

  return mentioned
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)

    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }

    return path.endsWith('.ts') ? [path] : []
  })
}

function environmentVariablesRead() {
  const resolver = readFileSync(join(repoRoot, 'src/ping/env.ts'), 'utf8')
  const names = new Set()

  if (!resolver.includes('CRONHEART_${name}') || !resolver.includes('CRON_MONITOR_${name}')) {
    fail('src/ping/env.ts', 'no longer reads a canonical name with a CRON_MONITOR_ fallback')
  }

  for (const file of sourceFiles(join(repoRoot, 'src'))) {
    const text = readFileSync(file, 'utf8')

    for (const [, suffix] of text.matchAll(/(?:readEnv|numberFrom)\([\w.]+, '([A-Z_]+)'\)/g)) {
      names.add(`CRONHEART_${suffix}`)
      names.add(`CRON_MONITOR_${suffix}`)
    }

    for (const [, whole] of text.matchAll(/\b(CRONHEART_[A-Z_]+|CRON_MONITOR_[A-Z_]+)\b/g)) {
      names.add(whole)
    }
  }

  return names
}

function checkSamples(blocks) {
  const samples = blocks.filter((block) => SAMPLE_LANGUAGES.has(block.language))

  if (samples.length === 0) {
    fail('doc samples', 'none were found, so nothing was compiled')

    return 0
  }

  writeSamples(samples)
  typecheckSamples(samples)

  return samples.length
}

function checkFlags(fragments) {
  const commands = commandsOfTheProgram()
  const mentioned = flagsIn(fragments)
  const invocations = invocationsIn(fragments)

  if (commands.length === 0) {
    fail('cronheart --help', 'names no command, so nothing could be probed against it')

    return 0
  }

  const deaf = commands.filter((command) => !refusedBy(command, [])?.has(SENTINEL))

  for (const command of deaf) {
    fail(`cronheart ${command}`, 'does not name an undeclared flag, so no probe against it means anything')
  }

  if (deaf.length > 0) {
    return 0
  }

  const accepted = new Map(
    commands.map((command) => {
      const asked = [...mentioned.keys()].filter((flag) => !ROOT_FLAGS.has(flag))
      const refused = refusedBy(command, asked)

      return [command, new Set(asked.filter((flag) => !refused.has(flag)))]
    }),
  )

  for (const invocation of invocations) {
    if (!accepted.has(invocation.command)) {
      fail(invocation.where, `cronheart has no ${invocation.command} command`)

      continue
    }

    for (const flag of invocation.flags) {
      if (ROOT_FLAGS.has(flag)) {
        continue
      }

      if (!accepted.get(invocation.command).has(flag)) {
        fail(invocation.where, `cronheart ${invocation.command} does not take --${flag}`)
      }
    }
  }

  for (const [flag, where] of mentioned) {
    if (ROOT_FLAGS.has(flag)) {
      continue
    }

    const taken = [...accepted.values()].some((flags) => flags.has(flag))
    const foreign = FOREIGN_FLAGS.get(flag)

    if (foreign !== undefined) {
      if (taken) {
        fail(where, `--${flag} is excused as ${foreign}'s flag and cronheart takes one of that name`)
      }

      continue
    }

    if (!taken) {
      fail(where, `--${flag} is documented and no cronheart command takes it`)
    }
  }

  const anywhere = flagsIn(fragments, { theirs: true })

  for (const [flag, foreign] of FOREIGN_FLAGS) {
    if (!anywhere.has(flag)) {
      fail('doc flags', `--${flag} is excused as ${foreign}'s flag and no document mentions it`)
    }
  }

  return mentioned.size + invocations.length
}

function checkEnvironment(documents) {
  const mentioned = environmentVariablesIn(documents)
  const read = environmentVariablesRead()

  if (mentioned.size === 0) {
    fail('doc environment', 'documents no variable, so nothing was compared')

    return 0
  }

  for (const [variable, where] of mentioned) {
    if (variable.endsWith('_UUID')) {
      continue
    }

    if (!read.has(variable)) {
      fail(where, `${variable} is documented and nothing under src reads it`)
    }
  }

  return mentioned.size
}

function checkRecipes(fragments) {
  const makefile = readFileSync(join(repoRoot, 'Makefile'), 'utf8')
  const targets = new Set([...makefile.matchAll(/^([a-z][\w-]*):/gm)].map((match) => match[1]))
  const scripts = new Set(
    Object.keys(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts),
  )
  let checked = 0

  for (const fragment of fragments) {
    const recipe = RECIPE.exec(fragment.text.trim())

    if (recipe === null) {
      continue
    }

    checked += 1

    if (recipe[1] === 'make' && !targets.has(recipe[2])) {
      fail(`${fragment.file}:${fragment.line}`, `the Makefile has no ${recipe[2]} target`)
    }

    if (recipe[1] === 'pnpm run' && !scripts.has(recipe[2])) {
      fail(`${fragment.file}:${fragment.line}`, `package.json has no ${recipe[2]} script`)
    }
  }

  return checked
}

const gathered = documents()

if (gathered.length === 0) {
  process.stderr.write(`doc claims FAILED — no document to read under ${docsRoot}\n`)
  process.exit(1)
}

const blocks = gathered.flatMap((document) => blocksIn(document))
const fragments = codeFragments(gathered, blocks)

const sampleCount = checkSamples(blocks)
const flagCount = checkFlags(fragments)
const variableCount = checkEnvironment(gathered)
const recipeCount = checkRecipes(fragments)

const tally = `${gathered.length} document(s), ${sampleCount} compiled sample(s), ${flagCount} flag claim(s), ${variableCount} variable(s), ${recipeCount} recipe(s)`

if (failures.length === 0) {
  process.stdout.write(`doc claims — ${tally}, all held\n`)
} else {
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`)
  }

  process.stderr.write(`doc claims FAILED — ${failures.length} problem(s) in ${tally}\n`)
  process.exit(1)
}

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCli } from './support/cli.js'

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

const CRON_BLOCK = /```cron\n([\s\S]*?)```/g

const SCHEDULE_LINE = /^\s*[\d*@][^\n]*cronheart[^\n]*$/

const ABSOLUTE_BINARY = /\s\/\S*cronheart\s/

const VARIABLE_ASSIGNMENT = /^\s*CRONHEART_[A-Z0-9_]+_UUID=/m

// A flag no other command offers, so a page that carries someone else's is the global text.
const BELONGS_ELSEWHERE: Readonly<Record<string, string>> = {
  run: '--action=',
  ping: '--kill-after=',
  doctor: '--env-path=',
  init: '--strict',
}

function cronBlocks(): string[] {
  return [...README.matchAll(CRON_BLOCK)].map((match) => String(match[1]))
}

function scheduleLines(block: string): string[] {
  return block.split('\n').filter((line) => SCHEDULE_LINE.test(line))
}

describe('cronheart --help answers for the command that was asked about', () => {
  it.each(Object.keys(BELONGS_ELSEWHERE))('describes %s and not the whole tool', async (command) => {
    const ran = await runCli([command, '--help'])

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain(`cronheart ${command}`)
    expect(ran.stdout).not.toContain(BELONGS_ELSEWHERE[command])
  })

  it('gives each command a different page rather than four copies of one', async () => {
    const pages = await Promise.all(
      Object.keys(BELONGS_ELSEWHERE).map(async (command) => (await runCli([command, '--help'])).stdout),
    )

    expect(new Set(pages).size).toBe(4)
  })

  it('still lists every command when no command was named', async () => {
    const ran = await runCli(['--help'])

    expect(ran.status).toBe(0)

    for (const command of Object.keys(BELONGS_ELSEWHERE)) {
      expect(ran.stdout).toContain(`cronheart ${command}`)
    }
  })
})

// The doc-claims gate proves that a documented flag exists. This is the other direction,
// which nothing mechanical can take: a flag the program answers and no page names.
const ENTRY = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')

const GLOBAL_FLAG_READ = /readFlag\(args, '([\w-]+)'\)/g

const GLOBAL_FLAGS = [
  ...new Set([...ENTRY.matchAll(GLOBAL_FLAG_READ)].map((match) => String(match[1]))),
].sort()

// --help is a substring of --helpful and -h is one of --help, so a page naming neither
// would satisfy a plain containment check on both.
function names(page: string, flag: string): boolean {
  const written = flag.length === 1 ? `-${flag}` : `--${flag}`

  return new RegExp(`(?<![-\\w])${written}(?![\\w-])`).test(page)
}

describe('the flags answered before any command is dispatched', () => {
  it('reads them off the entry point, so the list below cannot go stale', () => {
    expect(GLOBAL_FLAGS).toEqual(['V', 'h', 'help', 'version'])
  })

  it.each(GLOBAL_FLAGS)('names %s on the page a reader with no command reaches', async (flag) => {
    const ran = await runCli(['--help'])

    expect(ran.status).toBe(0)
    expect(names(ran.stdout, flag)).toBe(true)
  })

  it('proves that check can fail, on a flag no page has any reason to name', async () => {
    const ran = await runCli(['--help'])

    expect(names(ran.stdout, 'quiet')).toBe(false)
  })
})

describe('the examples the help gives a crontab', () => {
  it('shows the run command with the id inline, which is what cron can resolve', async () => {
    const ran = await runCli(['run', '--help'])
    const lines = scheduleLines(ran.stdout)

    expect(ran.stdout).toContain('Examples')
    expect(lines.length).toBeGreaterThan(0)

    for (const line of lines) {
      expect(line).toMatch(ABSOLUTE_BINARY)
    }

    expect(lines.some((line) => line.includes('--uuid='))).toBe(true)
  })

  it('sets the variable in the crontab itself wherever it shows the --name form', async () => {
    const ran = await runCli(['run', '--help'])
    const named = scheduleLines(ran.stdout).filter((line) => line.includes('--name='))

    expect(named.length).toBeGreaterThan(0)
    expect(ran.stdout).toMatch(VARIABLE_ASSIGNMENT)
  })
})

describe('the crontab lines the README publishes', () => {
  it('has cron blocks to check at all', () => {
    expect(cronBlocks().length).toBeGreaterThan(0)
    expect(cronBlocks().flatMap(scheduleLines).length).toBeGreaterThan(0)
  })

  it('invokes cronheart by absolute path, because cron’s PATH is not a login shell’s', () => {
    for (const line of cronBlocks().flatMap(scheduleLines)) {
      expect(line).toMatch(ABSOLUTE_BINARY)
    }
  })

  it('never shows --name without the variable that answers for it in the same block', () => {
    for (const block of cronBlocks()) {
      if (!block.includes('--name=')) {
        continue
      }

      expect(block).toMatch(VARIABLE_ASSIGNMENT)
    }
  })
})

describe('a page that documents every flag its command accepts', () => {
  it.each([
    ['init', ['--schedule', '--channels', '--env-path', '--print-env', '--name', '--uuid']],
    ['sync', ['--config', '--apply', '--check', '--prune', '--print-env', '--yes', '--all']],
  ])('names each of %s’s flags in the usage line and again in the options', async (command, flags) => {
    const ran = await runCli([command, '--help'])
    const usage = String(ran.stdout.split('\nOptions')[0])
    const options = String(ran.stdout.split('\nOptions')[1])

    for (const flag of flags) {
      expect(usage).toContain(flag)
      expect(options).toContain(flag)
    }
  })

  it('says that cronheart init creates a monitor on the account when a key is configured', async () => {
    const said = String((await runCli(['init', '--help'])).stdout.split('\nEnvironment')[0])

    expect(said).toContain('creates a monitor')
    expect(said).toContain('CRONHEART_API_KEY')
  })

  // A build that reads anything non-zero as drift reads "your key expired" as "there are
  // changes to make", which is the one reading this status exists to prevent.
  it('documents every status --check can end on, not only the two that answer the question', async () => {
    const ran = await runCli(['sync', '--help'])
    const check = String(
      /\n {2}--check[\s\S]*?(?=\n {2}--)/.exec(String(ran.stdout.split('\nOptions')[1]))?.[0] ?? '',
    )

    expect(check).not.toBe('')

    for (const status of ['0', '1', '2']) {
      expect(check).toContain(status)
    }
  })

  it('says sync needs an API key on a paid plan on the page a sync reader is on', async () => {
    const said = String((await runCli(['sync', '--help'])).stdout.split('\nEnvironment')[0])

    expect(said).toContain('CRONHEART_API_KEY')
    expect(said).toContain('Starter')
  })
})

describe('what the README says before a reader reaches the sync section', () => {
  const SYNC_SECTION = String(/\n## Declarative sync\n[\s\S]*?(?=\n## )/.exec(README)?.[0] ?? '')

  const CLI_SECTION = String(/\n## CLI\n[\s\S]*?(?=\n## )/.exec(README)?.[0] ?? '')

  it('found both sections to read', () => {
    expect(SYNC_SECTION).not.toBe('')
    expect(CLI_SECTION).not.toBe('')
  })

  it('states the key and the plan sync needs inside the sync section itself', () => {
    expect(SYNC_SECTION).toContain('CRONHEART_API_KEY')
    expect(SYNC_SECTION).toContain('Starter')
  })

  it('documents all three statuses --check ends on', () => {
    for (const status of ['exit 0', 'exit 1', 'exit 2']) {
      expect(SYNC_SECTION).toContain(status)
    }
  })

  it('links the sync section from the place a CLI reader first meets the command', () => {
    expect(CLI_SECTION).toContain('#declarative-sync')
  })

  // Stripping is not checking: a misspelled key is dropped at run time where a typecheck
  // would have named it, and the section is otherwise silent about that.
  it('says a .ts config is stripped rather than checked, and what to run that does check it', () => {
    expect(SYNC_SECTION).toContain('tsc --noEmit')
    expect(SYNC_SECTION).toMatch(/strip\w* is not check\w*/i)
  })
})

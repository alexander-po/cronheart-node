import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCli } from './support/cli.js'

const root = new URL('../', import.meta.url)

const RECIPE = 'skills/add-cronheart/SKILL.md'

const POINTER = 'AGENTS.md'

const recipe = readFileSync(new URL(RECIPE, root), 'utf8')

const pointer = readFileSync(new URL(POINTER, root), 'utf8')

const readme = readFileSync(new URL('README.md', root), 'utf8')

const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  files: readonly string[]
}

// The two fields a Claude Code skill declares. The loader's own bounds on their length are
// not something this repository invokes and so not something it can hold a number against;
// what is checked here is what the file itself settles — the field set, and that name matches
// the directory it lives in in the kebab-case shape every loaded skill in this format uses.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const SHELL_FENCE = /^```(?:bash|sh|shell|console|cron)\s*$/

const CODE_SPAN = /`([^`]+)`/g

const INVOCATION = /(?:^|\s)(?:\S*\/)?cronheart\s+([a-z][a-z-]*)/g

function frontmatterOf(document: string): Record<string, string> {
  const opened = /^---\n([\s\S]*?)\n---\n/.exec(document)

  if (opened === null) {
    throw new Error('the document does not open with a frontmatter block')
  }

  const fields: Record<string, string> = {}

  for (const line of String(opened[1]).split('\n')) {
    const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line)

    if (field === null) {
      throw new Error(`the frontmatter line ${JSON.stringify(line)} is not a field`)
    }

    fields[String(field[1])] = String(field[2]).trim()
  }

  return fields
}

// The same reading the documented-claims gate takes: a command is what follows the program's
// name in a code span or a shell block, and prose is left alone.
function commandsNamedIn(document: string): string[] {
  const fragments: string[] = []
  let inShell = false
  let inOtherFence = false

  for (const line of document.split('\n')) {
    if (/^```/.test(line)) {
      if (inShell || inOtherFence) {
        inShell = false
        inOtherFence = false
      } else if (SHELL_FENCE.test(line)) {
        inShell = true
      } else {
        inOtherFence = true
      }

      continue
    }

    if (inShell) {
      fragments.push(line)
    } else if (!inOtherFence) {
      fragments.push(...[...line.matchAll(CODE_SPAN)].map((match) => String(match[1])))
    }
  }

  return [
    ...new Set(fragments.flatMap((fragment) => [...fragment.matchAll(INVOCATION)].map((match) => String(match[1])))),
  ].sort()
}

async function commandsOfTheProgram(): Promise<string[]> {
  const ran = await runCli(['--help'])

  return [...ran.stdout.matchAll(/^ {2}([a-z][a-z-]*) {2,}\S/gm)].map((match) => String(match[1])).sort()
}

describe('the agent recipe is a skill the loader will accept', () => {
  const fields = frontmatterOf(recipe)

  it('declares a name and a description and nothing else', () => {
    expect(Object.keys(fields).sort()).toEqual(['description', 'name'])
  })

  it('is named after its directory, in the shape every skill name here takes', () => {
    expect(fields['name']).toBe('add-cronheart')
    expect(fields['name']).toMatch(SKILL_NAME)
  })

  it('describes when to use it, on one line', () => {
    const description = String(fields['description'])

    expect(description).toMatch(/^Add cronheart\.com check-in monitoring/)
    expect(description).toMatch(/Use when/)
    expect(description).not.toContain('\n')
  })
})

describe('the agent recipe names the commands the program has', () => {
  it('names every command the program has and no other, so a command that is gone or new is caught here', async () => {
    const program = await commandsOfTheProgram()

    expect(program.length).toBeGreaterThanOrEqual(5)
    expect(commandsNamedIn(recipe)).toEqual(program)
  })

  it('would report a recipe whose frontmatter is short a field and whose command the program does not have', async () => {
    const drifted = [
      '---',
      'name: add-cronheart',
      '---',
      '',
      'Enrol the job with `cronheart enrol --name=nightly-backup`, then run `cronheart doctor`.',
      '',
      '```bash',
      'cronheart reconcile --apply',
      '```',
      '',
      'Prose saying cronheart never throws is not a command, and neither is a `cronheart/api` import.',
    ].join('\n')
    const program = await commandsOfTheProgram()
    const named = commandsNamedIn(drifted)

    expect(Object.keys(frontmatterOf(drifted))).toEqual(['name'])
    expect(named).toEqual(['doctor', 'enrol', 'reconcile'])
    expect(named.filter((command) => !program.includes(command))).toEqual(['enrol', 'reconcile'])
  })

  it('refuses a document with no frontmatter at all', () => {
    expect(() => frontmatterOf('# A recipe with no header\n')).toThrow(/frontmatter/)
  })
})

describe('the recipe is reachable from the root and from the README, and ships in neither tarball nor silence', () => {
  it('is pointed at by AGENTS.md', () => {
    expect(pointer).toContain(`](${RECIPE})`)
    expect(existsSync(new URL(RECIPE, root))).toBe(true)
  })

  it('is linked from a README section written for agents, together with the pointer', () => {
    const section = /^## For coding agents\n([\s\S]*?)^## /m.exec(readme)

    expect(section).not.toBeNull()
    expect(String(section?.[1])).toContain(`](${RECIPE})`)
    expect(String(section?.[1])).toContain(`](${POINTER})`)
  })

  it('stays out of the tarball, whose allow-list names neither the skills directory nor the pointer', () => {
    expect(manifest.files.filter((entry) => /^(?:\.\/)?(?:skills|AGENTS\.md)(?:\/|$)/.test(entry))).toEqual([])
  })
})

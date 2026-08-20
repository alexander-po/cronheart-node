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

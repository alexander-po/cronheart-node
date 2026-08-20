import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scripts: Record<string, string> = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).scripts

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

function leavesOf(name: string, seen = new Set<string>()): Set<string> {
  const body = scripts[name]

  if (body === undefined || seen.has(name)) {
    return new Set()
  }

  seen.add(name)

  const referenced = [...body.matchAll(/pnpm run ([\w:-]+)/g)].map((match) => match[1] as string)

  if (referenced.length === 0) {
    return new Set([name])
  }

  return new Set(referenced.flatMap((child) => [...leavesOf(child, seen)]))
}

describe('the workflow cannot quietly stop running part of the gate', () => {
  const gate = leavesOf('check')
  const workflowRuns = new Set(
    [...workflow.matchAll(/pnpm run ([\w:-]+)/g)].map((match) => match[1] as string),
  )

  it('finds a gate to compare against', () => {
    expect(gate.size).toBeGreaterThan(5)
    expect(workflowRuns.size).toBeGreaterThan(5)
  })

  it('runs every leaf of the gate chain', () => {
    expect([...gate].filter((script) => !workflowRuns.has(script)).sort()).toEqual([])
  })
})

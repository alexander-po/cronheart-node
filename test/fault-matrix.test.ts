import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FAULTS, MONITOR_ID } from './support/faults.js'
import { hosts, observe, violations } from './support/fault-harness.js'
import { INTEGRATIONS, REGISTRY } from './support/integrations.js'

function parameterListAfter(source: string, open: number): string {
  let depth = 0

  for (let index = open; index < source.length; index += 1) {
    const char = source[index]

    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1

      if (depth === 0) {
        return source.slice(open + 1, index)
      }
    }
  }

  return ''
}

function callableTakingFunctions(source: string): string[] {
  const declaration = /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\(/g

  return [...source.matchAll(declaration)]
    .filter((match) => parameterListAfter(source, match.index + match[0].length - 1).includes('=>'))
    .map((match) => String(match[1]))
}

describe('the fault matrix registry', () => {
  it('holds every exported function that takes a host callable', () => {
    const integrationsDir = new URL('../src/integrations/', import.meta.url)
    const declared = [
      ...callableTakingFunctions(
        readFileSync(new URL('../dist/index.d.mts', import.meta.url), 'utf8'),
      ),
      ...readdirSync(integrationsDir)
        .filter((name) => name.endsWith('.ts'))
        .flatMap((name) =>
          callableTakingFunctions(readFileSync(new URL(name, integrationsDir), 'utf8')),
        ),
    ]
    const registered = new Set(REGISTRY.flatMap((integration) => integration.exports))

    expect(declared.length).toBeGreaterThan(0)
    expect([...new Set(declared)].filter((name) => !registered.has(name))).toEqual([])
  })

  it('covers every fault against every integration and host', () => {
    expect(INTEGRATIONS.length * FAULTS.length * hosts().length).toBeGreaterThan(200)
  })
})

describe.each(INTEGRATIONS)('$id survives', (integration) => {
  describe.each(FAULTS)('$id', (fault) => {
    it.each(hosts())('while the job $id', async (host) => {
      const observation = await observe(integration, fault, host)

      expect(violations(observation, host, MONITOR_ID)).toEqual([])
    })
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defineMonitors } from '../src/sync/define.js'
import { ROUTING_MODES, routingKeys } from '../src/sync/routing.js'
import type { ResolvedRouting } from '../src/sync/types.js'

const syncSources = new URL('../src/sync/', import.meta.url)

function everyResolvedRouting(): readonly ResolvedRouting[] {
  return ROUTING_MODES.map((mode) =>
    mode === 'listed' ? { mode, ids: ['7', '9'] } : { mode },
  ) as readonly ResolvedRouting[]
}

describe('the field that replaces a monitor’s routing wholesale', () => {
  // The service reads this key as a replacement when it is present — even empty — and leaves
  // the routing alone when it is absent. Every mode is enumerated from the union's own list,
  // so a mode added later without a decision here fails rather than defaulting into one.
  it('is written by exactly one mode-dependent decision, over every mode the union has', () => {
    const written = everyResolvedRouting().map((routing) => [
      routing.mode,
      Object.hasOwn(routingKeys(routing), 'channelIds'),
      routingKeys(routing).channelIds,
    ])

    expect(written).toEqual([
      ['listed', true, ['7', '9']],
      ['none', true, []],
      ['unmanaged', false, undefined],
    ])
  })

  it('is absent as a key, not merely undefined, when the configuration says nothing', () => {
    const keys = routingKeys({ mode: 'unmanaged' })

    expect(Object.keys(keys)).toEqual([])
    expect(JSON.stringify(keys)).toBe('{}')
  })

  it('covers every mode a configuration can produce, so none can fall through unenumerated', () => {
    const produced = new Set(
      defineMonitors([
        { name: 'listed-job', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'silent-job', schedule: '@daily', channels: 'none' },
        { name: 'untouched-job', schedule: '@daily' },
      ]).monitors.map((monitor) => monitor.routing.mode),
    )

    expect([...produced].sort()).toEqual([...ROUTING_MODES].sort())
  })
})

describe('where the routing key can be decided', () => {
  // A second writer is how the absent case becomes an empty array again, so the count is
  // asserted rather than the behaviour of the one that exists today.
  it('is one file, and the rest of the reconciler never names the key at all', () => {
    const naming = readdirSync(syncSources)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) =>
        /channelIds\s*:/.test(readFileSync(new URL(name, syncSources), 'utf8')),
      )

    expect(naming).toEqual(['routing.ts'])
  })

  it('finds a file to point at, so the filter above is not selecting nothing', () => {
    expect(readdirSync(syncSources).filter((name) => name.endsWith('.ts')).length).toBeGreaterThan(4)
  })
})

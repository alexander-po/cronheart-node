import { describe, expect, it } from 'vitest'
import { staticGraph, wholeGraph } from './support/module-graph.js'

const dist = new URL('../dist/', import.meta.url)

const EAGER = staticGraph(dist, 'cli.mjs')

const WHOLE = wholeGraph(dist, 'cli.mjs')

// The two lazily-loaded commands are identified by an import and a sentence only they own,
// so the assertion breaks if either is pulled onto the eager path by a stray static import.
const INIT_ONLY = 'node:readline'

const TIER_ONLY = 'needs the Starter plan'

describe('what a per-minute cron pays to start', () => {
  it('reads one file to start and reaches the rest only when a command asks for them', () => {
    expect(EAGER.names).toEqual(['cli.mjs'])
    expect(EAGER.dynamics.length).toBeGreaterThan(0)
    expect(WHOLE.names.length).toBeGreaterThan(EAGER.names.length)
  })

  it('carries the wrapper and the ping path, and neither init nor the plan messaging', () => {
    expect(EAGER.source).toContain('node:child_process')
    expect(EAGER.source).toContain('/ping/')
    expect(EAGER.source).not.toContain(INIT_ONLY)
    expect(EAGER.source).not.toContain(TIER_ONLY)
  })

  it('still ships both, reached through a dynamic import rather than dropped', () => {
    expect(WHOLE.source).toContain(INIT_ONLY)
    expect(WHOLE.source).toContain(TIER_ONLY)
    expect(EAGER.dynamics.length).toBeGreaterThan(0)
  })

  it('reaches the ping path but never the management entry, a different install profile', () => {
    expect(WHOLE.source).toContain('/ping/')
    expect(WHOLE.names).not.toContain('api.mjs')
    expect(WHOLE.names).not.toContain('sync.mjs')
  })
})

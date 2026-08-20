import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isCronheartApiError } from '../src/api/errors.js'
import * as sync from '../src/sync.js'
import { SyncConfigurationError } from '../src/sync/errors.js'
import { staticGraph } from './support/module-graph.js'

const dist = new URL('../dist/', import.meta.url)

const sources = new URL('../src/sync/', import.meta.url)

describe('what cronheart/sync exports', () => {
  it('hands back the four things a reconciler is built from, and nothing that runs on its own', () => {
    expect(Object.keys(sync).sort()).toEqual([
      'SyncConfigurationError',
      'applySync',
      'defineMonitors',
      'envLinesFor',
      'isSyncConfigurationError',
      'planSync',
      'renderPlan',
      'renderResult',
    ])
  })

  it('reaches no node builtin from any file it is built out of', () => {
    const offenders = readdirSync(sources)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /["']node:/.test(readFileSync(new URL(name, sources), 'utf8')))

    expect(offenders).toEqual([])
    expect(/["']node:/.test(readFileSync(new URL('../src/sync.ts', import.meta.url), 'utf8'))).toBe(
      false,
    )
  })

  it('builds to a bundle that reaches none either, which is what a worker runtime needs', () => {
    expect(staticGraph(dist, 'sync.mjs').source).not.toMatch(/["']node:/)
  })
})

describe('the errors a reconciler raises', () => {
  it('are recognised across two copies of this package, which instanceof cannot do', () => {
    const raised = new SyncConfigurationError('a refusal')

    expect(sync.isSyncConfigurationError(raised)).toBe(true)
    expect(sync.isSyncConfigurationError(new Error('something else'))).toBe(false)
    expect(sync.isSyncConfigurationError({ name: 'SyncConfigurationError' })).toBe(false)
  })

  it('are not mistaken for the management client’s, which mean the service refused something', () => {
    expect(isCronheartApiError(new SyncConfigurationError('a refusal'))).toBe(false)
  })
})

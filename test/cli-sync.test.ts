import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ApiServer, startApiServer } from './support/api-server.js'
import { runCli, runCliUnderTerminal } from './support/cli.js'
import {
  type MonitorStore,
  channelRow,
  createMonitorStore,
  monitorRow,
} from './support/monitor-store.js'

const API_KEY = `cmk_${'0'.repeat(28)}synthetic`

const VERIFIED = channelRow({ id: '7', label: 'ops inbox', verified: true })

let store: MonitorStore
let server: ApiServer
let workspace: string

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_API_KEY: API_KEY,
    CRONHEART_TIMEOUT_MS: '4000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function writeConfig(body: string, name = 'cronheart.config.mjs'): string {
  const path = join(workspace, name)

  writeFileSync(path, body)

  return path
}

function jsonConfig(monitors: unknown, name = 'cronheart.config.json'): string {
  return writeConfig(JSON.stringify({ monitors }, null, 2), name)
}

const SYNC_ENTRY = new URL('../dist/sync.mjs', import.meta.url).href

function moduleConfig(monitors: unknown): string {
  return writeConfig(
    `import { defineMonitors } from ${JSON.stringify(SYNC_ENTRY)}\nexport default defineMonitors(${JSON.stringify(monitors)})\n`,
  )
}

function methodsSeen(): string[] {
  return store.requests.map((request) => request.method)
}

beforeEach(async () => {
  store = createMonitorStore([], [VERIFIED])
  server = await startApiServer(store)
  workspace = mkdtempSync(join(tmpdir(), 'cronheart-sync-'))
})

afterEach(async () => {
  await server.close()
  rmSync(workspace, { recursive: true, force: true })
})

describe('cronheart sync changes nothing unless it is told to', () => {
  it('prints the plan and writes nothing on a bare run', async () => {
    const config = jsonConfig([
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('create')
    expect(ran.stdout).toContain('nightly-backup')
    expect(methodsSeen()).toEqual(['GET', 'GET'])
    expect(store.monitors).toEqual([])
  })

  it('says how to make the changes it just described', async () => {
    const config = jsonConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])
    const ran = await runCli(['sync', `--config=${config}`], { env: envFor() })

    expect(ran.stdout).toContain('--apply')
  })

  it('creates what it planned once --apply is given', async () => {
    const config = jsonConfig([
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['nightly-backup'])
    expect(store.monitors[0]?.channel_ids).toEqual(['7'])
  })

  it('leaves the configuration file exactly as it found it', async () => {
    const config = jsonConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])
    const before = { text: readFileSync(config, 'utf8'), at: statSync(config).mtimeMs }

    await runCli(['sync', `--config=${config}`, '--apply', '--print-env'], { env: envFor() })

    expect(readFileSync(config, 'utf8')).toBe(before.text)
    expect(statSync(config).mtimeMs).toBe(before.at)
  })
})

describe('what --check turns a configuration file into', () => {
  it('exits 2 while the service and the configuration disagree', async () => {
    const config = jsonConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])
    const ran = await runCli(['sync', `--config=${config}`, '--check'], { env: envFor() })

    expect(ran.status).toBe(2)
    expect(methodsSeen().filter((method) => method !== 'GET')).toEqual([])
  })

  it('exits 0 once they agree', async () => {
    const config = jsonConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])

    await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    const ran = await runCli(['sync', `--config=${config}`, '--check'], { env: envFor() })

    expect(ran.status).toBe(0)
  })

  it('reads a monitor the configuration does not describe as drift only when pruning is asked for', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const quiet = await runCli(['sync', `--config=${config}`, '--check'], { env: envFor() })
    const pruning = await runCli(['sync', `--config=${config}`, '--check', '--prune'], {
      env: envFor(),
    })

    expect(quiet.status).toBe(0)
    expect(quiet.stdout).toContain('orphan')
    expect(pruning.status).toBe(2)
    expect(store.monitors).toHaveLength(1)
  })

  it('refuses to be asked for a dry run and a check at once', async () => {
    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--check', '--apply'], {
      env: envFor(),
    })

    expect(ran.status).toBe(64)
    expect(store.requests).toEqual([])
  })
})

describe('deleting a monitor is the one thing sync will not do on being asked once', () => {
  it('reports an orphan and deletes nothing under --apply alone', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('orphan')
    expect(store.monitors).toHaveLength(1)
    expect(methodsSeen()).not.toContain('DELETE')
  })

  it('refuses to prune with nothing to confirm it, rather than assuming consent', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--apply', '--prune'], {
      env: envFor(),
      input: '',
    })

    expect(ran.status).toBe(1)
    expect(store.monitors).toHaveLength(1)
    expect(methodsSeen()).not.toContain('DELETE')
  })

  it('prunes when the confirmation is given in writing', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--apply', '--prune', '--yes'], {
      env: envFor(),
    })

    expect(ran.status).toBe(0)
    expect(store.monitors).toEqual([])
    expect(ran.stdout).toContain('retired')
  })

  // The interactive half of the same decision: at a terminal the confirmation is typed, and
  // anything but the word leaves every monitor where it is.
  it('asks at a terminal, and keeps the monitor when the answer is not the word', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const refused = await runCliUnderTerminal(
      ['sync', `--config=${config}`, '--apply', '--prune'],
      { env: envFor(), input: 'no\n' },
    )

    expect(refused.stdout).toContain('retired')
    expect(store.monitors).toHaveLength(1)

    const agreed = await runCliUnderTerminal(
      ['sync', `--config=${config}`, '--apply', '--prune'],
      { env: envFor(), input: 'delete\n' },
    )

    expect(agreed.stdout).toContain('retired')
    expect(store.monitors).toEqual([])
  })

  it('says what will be lost before it asks', async () => {
    store.monitors.push(monitorRow({ name: 'retired' }))

    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--apply', '--prune'], {
      env: envFor(),
      input: '',
    })

    expect(`${ran.stdout}${ran.stderr}`).toContain('history')
  })
})

describe('closing the gap between a monitor and the job that has to address it', () => {
  it('prints the variable for every monitor it reconciled', async () => {
    const config = jsonConfig([
      { name: 'nightly backup', schedule: '@daily', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`, '--apply', '--print-env'], {
      env: envFor(),
    })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toMatch(
      /^CRONHEART_NIGHTLY_BACKUP_UUID=00000000-0000-4000-8000-[0-9a-f]{12}$/m,
    )
  })

  it('prints no identifier at all without being asked for one', async () => {
    store.monitors.push(monitorRow())

    const config = jsonConfig([
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('00000000-0000-4000-8000-0000000000a1')
  })
})

describe('what sync refuses before it reaches the service', () => {
  it('states the plan a REST token needs, in its own words, when there is no key', async () => {
    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`], {
      env: { CRONHEART_URL: server.url },
    })

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('CRONHEART_API_KEY')
    expect(store.requests).toEqual([])
  })

  it('refuses a configuration with two monitors of one name, before authenticating', async () => {
    const config = jsonConfig([
      { name: 'a-job', schedule: '@daily', channels: ['ops inbox'] },
      { name: 'a-job', schedule: '@hourly', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`], { env: envFor() })

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('a-job')
    expect(store.requests).toEqual([])
  })

  it('ends an --apply that could not resolve a row with a status that says so', async () => {
    store.monitors.push(
      monitorRow({ uuid: '00000000-0000-4000-8000-00000000000a' }),
      monitorRow({ uuid: '00000000-0000-4000-8000-00000000000b' }),
    )

    const config = jsonConfig([
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])
    const ran = await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('conflict')
    expect(methodsSeen()).not.toContain('PATCH')
  })

  it('says where it looked when there is no configuration file to read', async () => {
    const ran = await runCli(['sync', `--config=${join(workspace, 'absent.json')}`], {
      env: envFor(),
    })

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('absent.json')
    expect(store.requests).toEqual([])
  })

  it('names the flags it does not take', async () => {
    const config = jsonConfig([])
    const ran = await runCli(['sync', `--config=${config}`, '--force'], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--force')
  })
})

describe('the shapes a configuration file can be written in', () => {
  it('reads a module that calls defineMonitors', async () => {
    const config = moduleConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])
    const ran = await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['a-job'])
  })

  // Nothing here compiles the file: the runtime strips the types itself, which every Node
  // this package supports does. The sentence for a runtime that cannot is pinned separately.
  it('reads a TypeScript module through the runtime that loads it', async () => {
    const config = writeConfig(
      `import { defineMonitors } from ${JSON.stringify(SYNC_ENTRY)}\nconst name: string = 'ts-job'\nexport default defineMonitors([{ name, schedule: '@daily', channels: 'none' }])\n`,
      'cronheart.config.ts',
    )
    const ran = await runCli(['sync', `--config=${config}`, '--apply'], { env: envFor() })

    expect(`${ran.stdout}${ran.stderr}`).not.toContain('TypeScript')
    expect(ran.status).toBe(0)
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['ts-job'])
  })

  it('finds the file itself when none is named', async () => {
    jsonConfig([{ name: 'a-job', schedule: '@daily', channels: ['ops inbox'] }])

    const ran = await runCli(['sync', '--apply'], { env: envFor(), cwd: workspace })

    expect(ran.status).toBe(0)
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['a-job'])
  })
})

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)
const entry = new URL('dist/index.mjs', repoRoot).href

const MONITOR_ID = '00000000-0000-4000-8000-0000000000e5'

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

// Vitest holds the event loop open for the whole run, so a timer that cannot keep
// the process alive is indistinguishable in-process from one that can. Only a real
// process with nothing else pending tells the two apart.
function run(source: string): Run {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: fileURLToPath(repoRoot),
    encoding: 'utf8',
    timeout: 30_000,
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function clientSource(options: string): string {
  return `
    import { createPingClient } from ${JSON.stringify(entry)}

    const client = createPingClient({
      baseUrl: 'https://exit.example',
      monitors: { job: ${JSON.stringify(MONITOR_ID)} },
      env: {},
      fetch: () => new Promise(() => {}),
      ${options}
    })
  `
}

describe('a check-in in a process with nothing else pending', () => {
  it('times out and hands back a result rather than dropping the process at exit', () => {
    const outcome = run(`
      ${clientSource('timeoutMs: 200, retries: 0,')}
      const result = await client.ping('job')
      process.stdout.write('outcome=' + result.outcome + '\\n')
    `)

    expect(outcome.stderr).toBe('')
    expect(outcome.stdout.trim()).toBe('outcome=timeout')
    expect(outcome.status).toBe(0)
  })

  it('lets flush reach its own deadline, so the lines after it still run', () => {
    const outcome = run(`
      ${clientSource('timeoutMs: 400, retries: 0,')}
      void client.ping('job')
      await client.flush(150)
      process.stdout.write('after-flush\\n')
    `)

    expect(outcome.stderr).toBe('')
    expect(outcome.stdout.trim()).toBe('after-flush')
    expect(outcome.status).toBe(0)
  })
})

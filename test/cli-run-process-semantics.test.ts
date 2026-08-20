import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MONITOR_ID,
  type PingServer,
  runCli,
  runCliUnderTerminal,
  startCli,
  startPingServer,
} from './support/cli.js'

let server: PingServer

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_JOB_UUID: MONITOR_ID,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function node(source: string): string[] {
  return ['--', process.execPath, '-e', source]
}

function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function failBody(): string {
  const request = server.requests.find((one) => one.action === 'fail')

  if (request === undefined) {
    throw new Error('no fail check-in was sent')
  }

  return request.body
}

// A grandchild that inherits the wrapper's stderr keeps that pipe open after the command
// itself is gone, which is the window every deadline and every teardown below runs in.
function holdsStderrFor(ms: number, then: string = ''): string {
  return [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => { ${then} }, ${String(ms)})`)}], { stdio: ["ignore", "ignore", "inherit"], detached: true }).unref()`,
  ].join('; ')
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('a deadline that outlives the command it bounded', () => {
  it('reports the command’s own status when it exited before the deadline fell', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--timeout=400ms', ...node(`${holdsStderrFor(1200)}; process.exit(3)`)],
      { env: envFor() },
    )

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('exited with status 3')
    expect(failBody()).not.toContain('timed out')
  })
})

describe('a duration no timer can hold', () => {
  it('refuses a --timeout past the timer ceiling instead of firing it at once', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--timeout=597h', ...node('process.exit(42)')],
      { env: envFor() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--timeout=597h')
    expect(server.requests).toHaveLength(0)
  })

  it('reads a --kill-after past the timer ceiling as never escalate, not escalate now', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        '--kill-after=720h',
        ...node(
          'process.on("SIGTERM", () => setTimeout(() => process.exit(42), 500)); setInterval(() => {}, 50)',
        ),
      ],
      { env: envFor() },
    )

    await after(600)
    live.child.kill('SIGTERM')

    const ran = await live.settled

    expect({ status: ran.status, signal: ran.signal }).toEqual({ status: 42, signal: null })
  })
})

describe('the parent’s own stderr', () => {
  it('keeps the command’s status when the reader of that stderr goes away', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        ...node(
          'const b = Buffer.alloc(65536, "x"); const t = setInterval(() => process.stderr.write(b), 20); setTimeout(() => { clearInterval(t); process.exit(3) }, 900)',
        ),
      ],
      { env: envFor() },
    )

    await after(200)
    live.dropStderr()

    const ran = await live.settled

    expect({ status: ran.status, signal: ran.signal }).toEqual({ status: 3, signal: null })
  })

  it('pauses the command rather than buffering for it when the parent cannot keep up', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        ...node(
          'const b = Buffer.alloc(65536, "x"); let sent = 0; const pump = () => { while (sent < 4194304) { sent += b.length; if (!process.stderr.write(b)) { process.stderr.once("drain", pump); return } } process.stdout.write("CHILD-WROTE-EVERYTHING") }; pump()',
        ),
      ],
      { env: envFor(), holdStderr: true },
    )

    await after(1500)

    const stalled = live.stdoutSoFar()

    live.releaseStderr()

    const ran = await live.settled

    expect(stalled).not.toContain('CHILD-WROTE-EVERYTHING')
    expect(ran.stdout).toContain('CHILD-WROTE-EVERYTHING')
    expect(ran.status).toBe(0)
  }, 20_000)

  it('owes the caller nothing by the time it exits, however late the caller reads', async () => {
    const live = startCli(
      ['run', '--name=job', ...node('process.stderr.write("y".repeat(300000))')],
      { env: envFor(), holdStderr: true },
    )
    const source = live.child.stderr
    let received = 0

    source?.on('data', (chunk: string) => {
      received += chunk.length
    })

    await after(3000)
    source?.resume()

    const ran = await live.settled

    expect(ran.status).toBe(0)
    expect(received).toBe(300_000)
  }, 30_000)
})

describe('the excerpt switched off', () => {
  it('leaves the command’s own stderr in place, so its background work survives', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--stderr-bytes=0',
        ...node(
          `${holdsStderrFor(2600, 'process.stderr.write("GRANDCHILD-SURVIVED\\n")')}; setInterval(() => {}, 100).unref(); process.exit(0)`,
        ),
      ],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(ran.stderr).toContain('GRANDCHILD-SURVIVED')
  }, 15_000)
})

describe('an interrupt that reached the whole process group', () => {
  it('is delivered to the command once, not once by the group and once by the wrapper', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        ...node(
          'let seen = 0; process.on("SIGINT", () => { seen += 1; if (seen === 1) setTimeout(() => { process.stderr.write("INTERRUPTS=" + seen + "\\n"); process.exit(7) }, 500) }); setInterval(() => {}, 50)',
        ),
      ],
      { env: envFor(), detached: true },
    )

    await after(600)
    process.kill(-(live.child.pid ?? 0), 'SIGINT')

    const ran = await live.settled

    expect(ran.stderr).toContain('INTERRUPTS=1')
    expect(ran.status).toBe(7)
  })
})

describe('an interrupt during the terminal check-in', () => {
  it('finishes with the status already in hand rather than dying by the signal', async () => {
    server.replyWith((request) => (request.action === 'start' ? {} : { delayMs: 4000 }))

    const live = startCli(['run', '--name=job', ...node('process.exit(5)')], { env: envFor() })

    await after(700)
    live.child.kill('SIGINT')

    const ran = await live.settled

    expect({ status: ran.status, signal: ran.signal }).toEqual({ status: 5, signal: null })
  }, 20_000)
})

describe('what --timeout terminates', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cronheart-tree-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('terminates the command’s children too, as the summary it sends claims', async () => {
    const marker = join(directory, 'grandchild-was-still-running')
    const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`
    const source = [
      'const { spawn } = require("node:child_process")',
      `spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => { ${grandchild} }, 1200)`)}], { stdio: "ignore" })`,
      'setInterval(() => {}, 50)',
    ].join('; ')

    const ran = await runCli(
      ['run', '--name=job', '--timeout=400ms', '--kill-after=200ms', ...node(source)],
      { env: envFor() },
    )

    expect(ran.status).toBe(124)

    await after(1600)

    expect(existsSync(marker)).toBe(false)
  }, 15_000)
})

describe('the delay a monitoring outage adds to the command it wraps', () => {
  it('stays inside one budget even on the per-check-in timeout the SDK ships with', async () => {
    server.replyWith(() => ({ delayMs: 20_000 }))

    const ran = await runCli(['run', '--name=job', ...node('process.exit(2)')], {
      env: {
        CRONHEART_URL: server.url,
        CRONHEART_JOB_UUID: MONITOR_ID,
      },
    })

    expect(ran.status).toBe(2)
    expect(ran.elapsedMs).toBeLessThan(4000)
  }, 40_000)
})

// Reads its own process group out of /proc rather than shelling out, so the answer is the
// kernel's rather than a tool's, and reports whether a controlling terminal is still reachable.
const PROBE = [
  'const fs = require("node:fs")',
  'let terminal = "LOST"',
  'try { fs.closeSync(fs.openSync("/dev/tty", "r")); terminal = "REACHABLE" } catch {}',
  'const stat = fs.readFileSync("/proc/self/stat", "utf8")',
  'const group = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]',
  'process.stdout.write("TTY=" + terminal + " GROUP=" + (group === String(process.pid) ? "OWN" : "SHARED") + "\\n")',
  'process.exit(3)',
].join('; ')

describe('the terminal the wrapped command is allowed to keep', () => {
  let directory: string
  let probe: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cronheart-tty-'))
    probe = join(directory, 'probe.cjs')
    writeFileSync(probe, PROBE)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves a command run from a terminal able to prompt for a password', async () => {
    const ran = await runCliUnderTerminal(
      ['run', '--name=job', '--', process.execPath, probe],
      { env: envFor() },
    )

    expect(ran.status).toBe(3)
    expect(ran.stdout).toContain('TTY=REACHABLE')
    expect(ran.stdout).toContain('GROUP=SHARED')
  })

  it('gives a command run without one its own group, which is what a deadline terminates', async () => {
    const ran = await runCli(['run', '--name=job', '--', process.execPath, probe], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(ran.stdout).toContain('GROUP=OWN')
  })
})

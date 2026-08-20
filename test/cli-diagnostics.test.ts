import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

let server: PingServer

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_CLEANUP_UUID: MONITOR_ID,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function node(source: string): string[] {
  return ['--', process.execPath, '-e', source]
}

function everything(ran: { stdout: string; stderr: string }): string {
  return `${ran.stdout}${ran.stderr}`
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('the sentence the library wrote reaches the person reading the terminal', () => {
  it('says which variable to set rather than printing the outcome token', async () => {
    const ran = await runCli(['ping', 'cleanup'], { env: { CRONHEART_URL: server.url } })

    expect(server.requests).toHaveLength(0)
    expect(ran.stderr).toContain('no monitor id for "cleanup"')
    expect(ran.stderr).toContain('CRONHEART_CLEANUP_UUID')
    expect(everything(ran)).not.toContain('suppressed')
  })

  it('spells out what a paused monitor means instead of relaying its status code alone', async () => {
    server.replyWith(() => ({ status: 410, body: 'Gone' }))

    const ran = await runCli(['ping', 'cleanup'], { env: envFor() })

    expect(server.requests).toHaveLength(1)
    expect(ran.stderr).toContain('no alert will fire')
    expect(everything(ran)).not.toMatch(/for "cleanup" paused/)
  })

  it('names the variable behind a monitor the server does not recognise', async () => {
    server.replyWith(() => ({ status: 404, body: 'Not Found' }))

    const ran = await runCli(['ping', 'cleanup'], { env: envFor() })

    expect(ran.stderr).toContain('does not recognise')
    expect(ran.stderr).toContain('CRONHEART_CLEANUP_UUID')
  })

  it('carries the same sentence through the wrapper, where a crontab reads it', async () => {
    const ran = await runCli(['run', '--name=cleanup', ...node('process.exit(0)')], {
      env: { CRONHEART_URL: server.url },
    })

    expect(ran.status).toBe(0)
    expect(server.requests).toHaveLength(0)
    expect(ran.stderr).toContain('no monitor id for "cleanup"')
    expect(ran.stderr).toContain("The command's exit status is unchanged.")
    expect(everything(ran)).not.toContain('suppressed')
  })

  it('carries it through doctor, which is where a silent monitor is meant to be found', async () => {
    server.replyWith(() => ({ status: 410, body: 'Gone' }))

    const ran = await runCli(['doctor', 'cleanup'], { env: envFor() })

    expect(ran.status).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(ran.stdout).toContain('no alert will fire')
  })
})

describe('what a wrapped command that failed leaves in the cron mail', () => {
  it('writes the summary on failure and nothing at all on success', async () => {
    const failed = await runCli(['run', '--name=cleanup', ...node('process.exit(1)')], {
      env: envFor(),
    })
    const passed = await runCli(['run', '--name=cleanup', ...node('process.exit(0)')], {
      env: envFor(),
    })

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('exited with status 1')
    expect(passed.status).toBe(0)
    expect(everything(passed)).toBe('')
  })

  it('names the command and the reason when cron’s PATH does not carry it', async () => {
    const ran = await runCli(['run', '--name=cleanup', '--', 'backup-that-is-not-installed.sh'], {
      env: envFor(),
    })

    expect(ran.status).toBe(127)
    expect(ran.stderr).toContain('backup-that-is-not-installed.sh')
    expect(ran.stderr).toContain('PATH')
  })

  it('says the deadline was the wrapper’s doing rather than leaving 124 unexplained', async () => {
    const ran = await runCli(
      ['run', '--name=cleanup', '--timeout=400ms', '--kill-after=300ms', ...node('setTimeout(() => {}, 60000)')],
      { env: envFor() },
    )

    expect(ran.status).toBe(124)
    expect(ran.stderr).toContain('timed out after 400ms')
  })
})

describe('what a healthy check-in prints', () => {
  it('prints nothing on a run cron would otherwise mail about', async () => {
    const ran = await runCli(['ping', 'cleanup'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(everything(ran)).toBe('')
  })

  it('confirms the check-in when the confirmation was asked for', async () => {
    const ran = await runCli(['ping', 'cleanup', '--verbose'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('accepted')
  })

  it('still reports a failed check-in without being asked', async () => {
    server.replyWith(() => ({ status: 500, body: 'nope' }))

    const ran = await runCli(['ping', 'cleanup'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(ran.stderr).toContain('cronheart:')
  })
})

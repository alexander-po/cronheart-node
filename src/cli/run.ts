import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import process from 'node:process'
import { PING_BODY_BUDGET_BYTES } from '../ping/body.js'
import type { EnvSource } from '../ping/env.js'
import { type ParsedArgs, type Read, readText, unknownFlags } from './args.js'
import { describeResult, environment, monitorSecrets, openClient } from './client.js'
import { describeDuration, parseDuration } from './duration.js'
import {
  EXIT_NOT_EXECUTABLE,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_TIMED_OUT,
  EXIT_USAGE,
  SIGNAL_EXIT_BASE,
} from './exit.js'
import type { Io } from './io.js'
import { REDACT_FLAG, planRedaction } from './redact.js'
import { createStderrTail } from './stderr-tail.js'

const FLAGS = ['name', 'uuid', 'timeout', 'stderr-bytes', 'kill-after', REDACT_FLAG]

// Check-ins need no key, so withholding an account-wide credential costs nothing.
const WITHHELD_FROM_THE_CHILD = ['CRONHEART_API_KEY', 'CRON_MONITOR_API_KEY']

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const DEFAULT_KILL_AFTER_MS = 5000

const STDERR_DRAIN_BUDGET_MS = 2000

const FLUSH_BUDGET_MS = 2000

export const MAX_STDERR_TAIL_BYTES = PING_BODY_BUDGET_BYTES - 256

export interface RunSpec {
  readonly monitor: string
  readonly timeoutMs: number | undefined
  readonly killAfterMs: number
  readonly stderrBytes: number
  readonly redact: readonly RegExp[]
  readonly command: string
  readonly args: readonly string[]
}

interface Ended {
  readonly code: number | null
  readonly signal: string | null
  readonly startFailure: string | undefined
  readonly timedOut: boolean
  readonly forwarded: string | undefined
}

interface Completed {
  readonly ended: Ended
  readonly tail: string
  readonly runtimeMs: number
}

function refuse(problem: string): Read<RunSpec> {
  return { ok: false, problem }
}

function duration(args: ParsedArgs, flag: string): Read<number | undefined> {
  const given = readText(args, flag)

  if (!given.ok) {
    return given
  }

  if (given.value === undefined) {
    return { ok: true, value: undefined }
  }

  const parsed = parseDuration(given.value)

  if (parsed === undefined || parsed === 0) {
    return {
      ok: false,
      problem: `--${flag}=${given.value} is not a duration — write it as 30s, 500ms, 5m or 2h`,
    }
  }

  return { ok: true, value: parsed }
}

export function planRun(args: ParsedArgs, env: EnvSource): Read<RunSpec> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    return refuse(`run does not take --${unknown.join(', --')}`)
  }

  const name = readText(args, 'name')
  const uuid = readText(args, 'uuid')

  if (!name.ok) {
    return name
  }

  if (!uuid.ok) {
    return uuid
  }

  if (name.value !== undefined && uuid.value !== undefined) {
    return refuse('pass either --name or --uuid, not both')
  }

  const monitor = name.value ?? uuid.value

  if (monitor === undefined || monitor === '') {
    return refuse('run needs a monitor — pass --name=<name> or --uuid=<id>')
  }

  const timeout = duration(args, 'timeout')

  if (!timeout.ok) {
    return timeout
  }

  const killAfter = duration(args, 'kill-after')

  if (!killAfter.ok) {
    return killAfter
  }

  const budget = readText(args, 'stderr-bytes')

  if (!budget.ok) {
    return budget
  }

  const stderrBytes = budget.value === undefined ? MAX_STDERR_TAIL_BYTES : Number(budget.value)

  if (
    !/^[0-9]+$/.test(budget.value ?? '0') ||
    !Number.isSafeInteger(stderrBytes) ||
    stderrBytes > MAX_STDERR_TAIL_BYTES
  ) {
    return refuse(
      `--stderr-bytes must be a whole number of bytes, at most ${MAX_STDERR_TAIL_BYTES} — the rest of the check-in body has to fit alongside it`,
    )
  }

  const redact = planRedaction(args, env)

  if (!redact.ok) {
    return redact
  }

  const rest = args.rest

  if (rest === undefined) {
    return refuse('put the command after a -- separator, as in: cronheart run --name=job -- ls -la')
  }

  const command = rest[0]

  if (command === undefined || command === '') {
    return refuse('nothing to run — the -- separator was not followed by a command')
  }

  return {
    ok: true,
    value: {
      monitor,
      timeoutMs: timeout.value,
      killAfterMs: killAfter.value ?? DEFAULT_KILL_AFTER_MS,
      stderrBytes,
      redact: redact.value,
      command,
      args: rest.slice(1),
    },
  }
}

function signalNumber(name: string): number {
  const table = constants.signals as unknown as Record<string, number | undefined>

  return table[name] ?? 0
}

function childEnvironment(): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = { ...process.env }

  for (const name of WITHHELD_FROM_THE_CHILD) {
    delete inherited[name]
  }

  return inherited
}

function passThrough(chunk: Uint8Array): void {
  try {
    process.stderr.write(chunk)
  } catch {}
}

function execute(spec: RunSpec, patterns: readonly (string | RegExp)[]): Promise<Completed> {
  return new Promise<Completed>((resolve) => {
    const tail = createStderrTail(spec.stderrBytes, patterns)
    const startedAt = Date.now()
    let child: ChildProcess

    try {
      child = spawn(spec.command, [...spec.args], {
        stdio: ['inherit', 'inherit', 'pipe'],
        env: childEnvironment(),
      })
    } catch (error) {
      resolve({
        ended: {
          code: null,
          signal: null,
          startFailure: (error as { code?: string }).code ?? 'spawn failed',
          timedOut: false,
          forwarded: undefined,
        },
        tail: '',
        runtimeMs: 0,
      })

      return
    }

    let settled = false
    let timedOut = false
    let forwarded: string | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined

    const listeners = FORWARDED_SIGNALS.map((name) => {
      const listener = (): void => {
        forwarded ??= name
        try {
          child.kill(name)
        } catch {}
        escalate()
      }

      process.on(name, listener)

      return { name, listener }
    })

    // Forwarding stops when there is nothing left to forward to: a wrapper still settling its
    // last check-in must answer Ctrl-C itself rather than swallow it on a command that is gone.
    const cleanup = (): void => {
      for (const { name, listener } of listeners) {
        process.off(name, listener)
      }

      clearTimeout(escalation)
      clearTimeout(deadline)
      clearTimeout(drain)
    }

    function escalate(): void {
      escalation ??= setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, spec.killAfterMs)
    }

    const done = (code: number | null, signal: string | null): void => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      child.stderr?.destroy()
      resolve({
        ended: { code, signal, startFailure: undefined, timedOut, forwarded },
        tail: tail.text(),
        runtimeMs: Date.now() - startedAt,
      })
    }

    child.stderr?.on('data', (chunk: Uint8Array) => {
      passThrough(chunk)
      tail.push(chunk)
    })
    child.stderr?.on('error', () => {})

    child.on('error', (error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve({
        ended: {
          code: null,
          signal: null,
          startFailure: (error as { code?: string }).code ?? 'spawn failed',
          timedOut: false,
          forwarded,
        },
        tail: tail.text(),
        runtimeMs: Date.now() - startedAt,
      })
    })

    // A grandchild inheriting the pipe can hold it open long after the command itself is
    // gone, so the excerpt gets a bounded drain rather than the wrapper waiting on close.
    child.on('exit', (code, signal) => {
      drain ??= setTimeout(() => {
        done(code, signal)
      }, STDERR_DRAIN_BUDGET_MS)
    })

    child.on('close', (code, signal) => {
      done(code, signal)
    })

    if (spec.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {}
        escalate()
      }, spec.timeoutMs)
    }
  })
}

function exitCodeFor(ended: Ended): number {
  if (ended.startFailure !== undefined) {
    return ended.startFailure === 'ENOENT' ? EXIT_NOT_FOUND : EXIT_NOT_EXECUTABLE
  }

  if (ended.timedOut) {
    return EXIT_TIMED_OUT
  }

  if (ended.signal !== null) {
    return SIGNAL_EXIT_BASE + signalNumber(ended.signal)
  }

  return ended.code ?? EXIT_OK
}

function summaryFor(ended: Ended, spec: RunSpec): string {
  const relayed = ended.forwarded === undefined ? '' : ` (cronheart forwarded ${ended.forwarded})`

  if (ended.startFailure !== undefined) {
    return `the command could not be started: ${ended.startFailure}`
  }

  if (ended.timedOut) {
    const limit = spec.timeoutMs === undefined ? 'its deadline' : describeDuration(spec.timeoutMs)

    return `timed out after ${limit} and was terminated${relayed}`
  }

  if (ended.signal !== null) {
    return `terminated by ${ended.signal}${relayed} — exit ${SIGNAL_EXIT_BASE + signalNumber(ended.signal)}`
  }

  return `exited with status ${ended.code ?? 0}${relayed}`
}

export async function runCommand(args: ParsedArgs, io: Io): Promise<number> {
  const env = environment()
  const plan = planRun(args, env)

  if (!plan.ok) {
    io.err(`cronheart: ${plan.problem}\n`)

    return EXIT_USAGE
  }

  const spec = plan.value
  const reported = new Set<string>()
  const opened = openClient({
    truncate: 'tail',
    redact: spec.redact,
    onResult: (result) => {
      if (result.ok || reported.has(result.outcome)) {
        return
      }

      reported.add(result.outcome)
      io.err(`cronheart: ${describeResult(result)} — the command's exit status is unchanged.\n`)
    },
  })

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem} — the command still ran, unmonitored.\n`)
  }

  const client = opened.ok ? opened.client : undefined

  void client?.start(spec.monitor)

  const completed = await execute(spec, [...spec.redact, ...monitorSecrets(env, spec.monitor)])
  const code = exitCodeFor(completed.ended)
  const summary = summaryFor(completed.ended, spec)

  if (client !== undefined) {
    const body = completed.tail === '' ? summary : `${summary}\n\n${completed.tail}`

    await (code === EXIT_OK
      ? client.success(spec.monitor, { runtimeMs: completed.runtimeMs })
      : client.fail(spec.monitor, { body, runtimeMs: completed.runtimeMs, truncate: 'tail' }))
    await client.flush(FLUSH_BUDGET_MS)
  }

  return code
}

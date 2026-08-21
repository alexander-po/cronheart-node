import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import process from 'node:process'
import { PING_BODY_BUDGET_BYTES } from '../ping/body.js'
import { describePingResult } from '../ping/describe.js'
import type { EnvSource } from '../ping/env.js'
import { countdown } from '../timer.js'
import { type ParsedArgs, type Read, readText, unknownFlags } from './args.js'
import {
  environment,
  idFlagRefusal,
  monitorSecrets,
  nameFlagRefusal,
  openClient,
} from './client.js'
import { MAX_TIMER_MS, describeDuration, parseDuration } from './duration.js'
import {
  EXIT_NOT_EXECUTABLE,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_TIMED_OUT,
  EXIT_USAGE,
  SIGNAL_EXIT_BASE,
} from './exit.js'
import { type Io, writeQuietly } from './io.js'
import { REDACT_FLAG, planRedaction } from './redact.js'
import { createStderrTail } from './stderr-tail.js'

const FLAGS = ['name', 'uuid', 'timeout', 'output-bytes', 'stderr-bytes', 'kill-after', REDACT_FLAG]

// Check-ins need no key, so withholding an account-wide credential costs nothing.
const WITHHELD_FROM_THE_CHILD = ['CRONHEART_API_KEY', 'CRON_MONITOR_API_KEY']

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const

const DEFAULT_KILL_AFTER_MS = 5000

const STDERR_DRAIN_BUDGET_MS = 2000

// Delivery and flush together: a monitoring outage may delay the command by this and no more.
const TERMINAL_CHECK_IN_BUDGET_MS = 2000

const LONGEST_HELD_TIMEOUT_MS = MAX_TIMER_MS - (MAX_TIMER_MS % 3_600_000)

const SIGNALS_REACH_A_GROUP = process.platform !== 'win32'

// Detaching calls setsid, which costs the command its controlling terminal and with it any
// /dev/tty prompt. Worth a whole process tree to signal only where there is no terminal to lose.
function leadsItsOwnGroup(): boolean {
  return SIGNALS_REACH_A_GROUP && process.stdin.isTTY !== true
}

const NOT_STARTED: Readonly<Record<string, string>> = {
  ENOENT: 'not found on PATH',
  EACCES: 'not executable',
}

export const MAX_OUTPUT_TAIL_BYTES = PING_BODY_BUDGET_BYTES - 256

export interface RunSpec {
  readonly monitor: string | undefined
  readonly monitorRefusal: string | undefined
  readonly timeoutMs: number | undefined
  readonly killAfterMs: number | undefined
  readonly outputBytes: number
  readonly redact: readonly RegExp[]
  readonly excerptRefusal: string | undefined
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

function unmonitored(problem: string): string {
  return `cronheart: ${problem} The command still ran, unmonitored.\n`
}

// A monitor this wrapper cannot use is never a reason not to run the command. The flag was
// written, so monitoring was asked for; what went missing is the value behind it, which in a
// crontab is one unset variable. Exiting here would trade the job for the diagnosis.
function monitorProblem(
  name: string | undefined,
  uuid: string | undefined,
): string | undefined {
  if (name !== undefined && uuid !== undefined) {
    return 'both --name and --uuid were given, so there is no one monitor this run belongs to.'
  }

  if (name === '' || uuid === '') {
    return 'the monitor this run was given is empty, which is what an unset variable expands to.'
  }

  if (uuid !== undefined) {
    return idFlagRefusal(uuid)
  }

  return name === undefined ? undefined : nameFlagRefusal(name)
}

interface GivenDuration {
  readonly ms: number
  readonly given: string
}

function duration(args: ParsedArgs, flag: string): Read<GivenDuration | undefined> {
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

  return { ok: true, value: { ms: parsed, given: given.value } }
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

  if (name.value === undefined && uuid.value === undefined) {
    return refuse('run needs a monitor — pass --name=<name> or --uuid=<id>')
  }

  const monitorRefusal = monitorProblem(name.value, uuid.value)
  const monitor = monitorRefusal === undefined ? (name.value ?? uuid.value) : undefined

  const timeout = duration(args, 'timeout')

  if (!timeout.ok) {
    return timeout
  }

  if (timeout.value !== undefined && timeout.value.ms > MAX_TIMER_MS) {
    return refuse(
      `--timeout=${timeout.value.given} is longer than a deadline can be held for — use at most ${describeDuration(LONGEST_HELD_TIMEOUT_MS)}`,
    )
  }

  const killAfter = duration(args, 'kill-after')

  if (!killAfter.ok) {
    return killAfter
  }

  const asked = readText(args, 'output-bytes')

  if (!asked.ok) {
    return asked
  }

  const legacy = readText(args, 'stderr-bytes')

  if (!legacy.ok) {
    return legacy
  }

  const given = asked.value ?? legacy.value
  const budget = given === undefined ? MAX_OUTPUT_TAIL_BYTES : Number(given)

  if (
    !/^[0-9]+$/.test(given ?? '0') ||
    !Number.isSafeInteger(budget) ||
    budget > MAX_OUTPUT_TAIL_BYTES
  ) {
    return refuse(
      `--output-bytes must be a whole number of bytes, at most ${MAX_OUTPUT_TAIL_BYTES} — the rest of the check-in body has to fit alongside it`,
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

  const refusal = redact.value.refusal

  return {
    ok: true,
    value: {
      monitor,
      monitorRefusal,
      timeoutMs: timeout.value?.ms,
      killAfterMs:
        killAfter.value === undefined
          ? DEFAULT_KILL_AFTER_MS
          : killAfter.value.ms > MAX_TIMER_MS
            ? undefined
            : killAfter.value.ms,
      outputBytes: refusal === undefined ? budget : 0,
      redact: redact.value.patterns,
      excerptRefusal: refusal,
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

// A negative pid signals the whole group, so a shell script's children go with the command —
// but only where the command was given a group of its own to lead.
function signalTree(child: ChildProcess, name: NodeJS.Signals, ownGroup: boolean): void {
  const pid = child.pid

  if (pid !== undefined && ownGroup) {
    try {
      process.kill(-pid, name)

      return
    } catch {}
  }

  try {
    child.kill(name)
  } catch {}
}

function execute(spec: RunSpec, patterns: readonly (string | RegExp)[]): Promise<Completed> {
  return new Promise<Completed>((resolve) => {
    const tail = createStderrTail(spec.outputBytes, patterns)
    const startedAt = Date.now()
    const ownGroup = leadsItsOwnGroup()
    const excerpting = spec.outputBytes > 0
    let child: ChildProcess

    try {
      // With no excerpt to take, no pipe is inserted at all: anything the command leaves
      // running keeps the caller's own streams rather than ones this wrapper later destroys.
      child = spawn(spec.command, [...spec.args], {
        stdio: ['inherit', excerpting ? 'pipe' : 'inherit', excerpting ? 'pipe' : 'inherit'],
        env: childEnvironment(),
        detached: ownGroup,
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
    let exited = false
    let stalls = 0
    let endedWith: { readonly code: number | null; readonly signal: string | null } | undefined
    let timedOut = false
    let forwarded: string | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined

    // A terminal has already delivered the interrupt to the whole foreground group, the command
    // included, so relaying it there would be the second delivery many tools read as abort now.
    const listeners = FORWARDED_SIGNALS.map((name) => {
      const listener = (): void => {
        if (ownGroup || !SIGNALS_REACH_A_GROUP) {
          forwarded ??= name
          signalTree(child, name, ownGroup)
        }

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
      if (exited || spec.killAfterMs === undefined) {
        return
      }

      escalation ??= setTimeout(() => {
        signalTree(child, 'SIGKILL', ownGroup)
      }, spec.killAfterMs)
    }

    const done = (code: number | null, signal: string | null): void => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        ended: { code, signal, startFailure: undefined, timedOut, forwarded },
        tail: tail.text(),
        runtimeMs: Date.now() - startedAt,
      })
    }

    // The budget below bounds a pipe nobody is writing to any more, so it must not run down
    // while this wrapper is the one not reading: that time is the caller's, not a grandchild's.
    function armDrain(): void {
      if (settled || stalls > 0 || drain !== undefined) {
        return
      }

      const ended = endedWith

      if (ended === undefined) {
        return
      }

      drain = setTimeout(() => {
        done(ended.code, ended.signal)
      }, STDERR_DRAIN_BUDGET_MS)
    }

    // Unwrapped, a command writing faster than the reader takes blocks on the pipe buffer;
    // draining it into memory instead would change its timing. A parent stream that has gone
    // away takes the tee with it rather than stalling a run whose status still has to arrive.
    function tee(source: NodeJS.ReadableStream, sink: NodeJS.WriteStream): void {
      let stalled = false

      const resumeTee = (): void => {
        if (!stalled) {
          return
        }

        stalled = false
        stalls -= 1
        sink.off('drain', resumeTee)
        sink.off('close', resumeTee)
        source.resume()
        armDrain()
      }

      source.on('data', (chunk: Uint8Array) => {
        tail.push(chunk)

        if (!sink.writable || writeQuietly(sink, chunk)) {
          return
        }

        stalled = true
        stalls += 1
        clearTimeout(drain)
        drain = undefined
        source.pause()
        sink.once('drain', resumeTee)
        sink.once('close', resumeTee)
      })
      source.on('error', () => {})
    }

    if (child.stdout !== null) {
      tee(child.stdout, process.stdout)
    }

    if (child.stderr !== null) {
      tee(child.stderr, process.stderr)
    }

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

    // A grandchild inheriting the pipes can hold them open long after the command itself is
    // gone, so the excerpt gets a bounded drain rather than the wrapper waiting on close.
    child.on('exit', (code, signal) => {
      exited = true
      clearTimeout(deadline)
      clearTimeout(escalation)
      endedWith = { code, signal }
      armDrain()
    })

    child.on('close', (code, signal) => {
      done(code, signal)
    })

    if (spec.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        if (exited) {
          return
        }

        timedOut = true
        signalTree(child, 'SIGTERM', ownGroup)
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
    const why = NOT_STARTED[ended.startFailure] ?? 'could not be started'

    return `${spec.command}: ${why} (${ended.startFailure})`
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

// What is still in flight when this settles is abandoned: the command's status is already
// known, and neither an outage nor an interrupt may change it.
function within(budgetMs: number, work: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const budget = countdown(budgetMs)
    const listeners = FORWARDED_SIGNALS.map((name) => {
      const listener = (): void => {
        stop()
      }

      process.on(name, listener)

      return { name, listener }
    })

    function stop(): void {
      for (const { name, listener } of listeners) {
        process.off(name, listener)
      }

      budget.cancel()
      resolve()
    }

    void budget.reached.then(stop)
    void work.then(stop, stop)
  })
}

export async function runCommand(args: ParsedArgs, io: Io): Promise<number> {
  const env = environment()
  const plan = planRun(args, env)

  if (!plan.ok) {
    io.err(`cronheart: ${plan.problem}\n`)

    return EXIT_USAGE
  }

  const spec = plan.value

  if (spec.excerptRefusal !== undefined) {
    io.err(`cronheart: ${spec.excerptRefusal}\n`)
  }

  const reported = new Set<string>()
  const monitor = spec.monitor
  const opened =
    monitor === undefined
      ? undefined
      : openClient({
          truncate: 'tail',
          redact: spec.redact,
          onResult: (result) => {
            if (result.ok || reported.has(result.outcome)) {
              return
            }

            reported.add(result.outcome)
            io.err(
              `cronheart: ${describePingResult(result)} The command's exit status is unchanged.\n`,
            )
          },
        })

  if (spec.monitorRefusal !== undefined) {
    io.err(unmonitored(spec.monitorRefusal))
  }

  if (opened?.ok === false) {
    io.err(unmonitored(opened.problem))
  }

  const client = opened?.ok === true ? opened.client : undefined

  if (monitor !== undefined) {
    void client?.start(monitor)
  }

  const completed = await execute(spec, [
    ...spec.redact,
    ...(monitor === undefined ? [] : monitorSecrets(env, monitor)),
  ])
  const code = exitCodeFor(completed.ended)
  const summary = summaryFor(completed.ended, spec)

  if (code !== EXIT_OK) {
    io.err(`cronheart: ${summary}\n`)
  }

  if (client !== undefined && monitor !== undefined) {
    const body = completed.tail === '' ? summary : `${summary}\n\n${completed.tail}`
    const delivered = (async (): Promise<void> => {
      await (code === EXIT_OK
        ? client.success(monitor, { runtimeMs: completed.runtimeMs })
        : client.fail(monitor, { body, runtimeMs: completed.runtimeMs, truncate: 'tail' }))
      await client.flush(TERMINAL_CHECK_IN_BUDGET_MS)
    })()

    await within(TERMINAL_CHECK_IN_BUDGET_MS, delivered)
  }

  return code
}

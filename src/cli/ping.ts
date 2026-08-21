import process from 'node:process'
import { PING_ACTIONS, type PingAction } from '../ping/action.js'
import { describePingResult } from '../ping/describe.js'
import type { PingClient, PingOptions, PingResult } from '../ping/types.js'
import type { EnvSource } from '../ping/env.js'
import { type ParsedArgs, type Read, readFlag, readText, unknownFlags } from './args.js'
import { environment, openClient } from './client.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { REDACT_FLAG, planRedaction } from './redact.js'

const FLAGS = ['action', 'body', 'strict', 'verbose', REDACT_FLAG]

const STDIN_CAP_BYTES = 65_536

interface PingSpec {
  readonly monitor: string
  readonly action: PingAction | undefined
  readonly fromStdin: boolean
  readonly body: string | undefined
  readonly strict: boolean
  readonly verbose: boolean
  readonly redact: readonly RegExp[]
  readonly excerptRefusal: string | undefined
}

// Validated here, against a closed list of literals, because the far side does not reject an
// action it does not know: it records a heartbeat, which marks the monitor up.
function readAction(args: ParsedArgs): Read<PingAction | undefined> {
  const given = readText(args, 'action')

  if (!given.ok) {
    return given
  }

  if (given.value === undefined) {
    return { ok: true, value: undefined }
  }

  const allowed: readonly string[] = PING_ACTIONS

  if (!allowed.includes(given.value)) {
    return {
      ok: false,
      problem: `--action=${given.value} is not a check-in this SDK will send. Use ${PING_ACTIONS.join(', ')}, or leave --action off — the server reads anything else as a heartbeat and marks the monitor up.`,
    }
  }

  return { ok: true, value: given.value as PingAction }
}

export function planPing(args: ParsedArgs, env: EnvSource): Read<PingSpec> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    return { ok: false, problem: `ping does not take --${unknown.join(', --')}` }
  }

  const monitor = args.positional[1]

  if (monitor === undefined || monitor === '') {
    return { ok: false, problem: 'ping needs a monitor — cronheart ping <name-or-id>' }
  }

  const action = readAction(args)

  if (!action.ok) {
    return action
  }

  const body = readText(args, 'body')

  if (!body.ok) {
    return body
  }

  const redact = planRedaction(args, env)

  if (!redact.ok) {
    return redact
  }

  return {
    ok: true,
    value: {
      monitor,
      action: action.value,
      fromStdin: body.value === '-',
      body: body.value === '-' ? undefined : body.value,
      strict: readFlag(args, 'strict'),
      verbose: readFlag(args, 'verbose') || process.stdout.isTTY === true,
      redact: redact.value.patterns,
      excerptRefusal: redact.value.refusal,
    },
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  let held = 0

  try {
    for await (const chunk of process.stdin) {
      const bytes = chunk as Uint8Array
      chunks.push(bytes)
      held += bytes.length

      if (held >= STDIN_CAP_BYTES) {
        break
      }
    }
  } catch {}

  const joined = new Uint8Array(held)
  let offset = 0

  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }

  return new TextDecoder().decode(joined)
}

function bodyFor(spec: PingSpec): Promise<string | undefined> {
  return spec.fromStdin ? readStdin() : Promise.resolve(spec.body)
}

function send(client: PingClient, spec: PingSpec, options: PingOptions): Promise<PingResult> {
  if (spec.action === 'start') {
    return client.start(spec.monitor, options)
  }

  if (spec.action === 'success') {
    return client.success(spec.monitor, options)
  }

  if (spec.action === 'fail') {
    return client.fail(spec.monitor, options)
  }

  return client.ping(spec.monitor, options)
}

export async function pingCommand(args: ParsedArgs, io: Io): Promise<number> {
  const plan = planPing(args, environment())

  if (!plan.ok) {
    io.err(`cronheart: ${plan.problem}\n`)

    return EXIT_USAGE
  }

  const spec = plan.value

  if (spec.excerptRefusal !== undefined) {
    io.err(`cronheart: ${spec.excerptRefusal}\n`)
  }

  const opened = openClient({ onResult: () => {}, redact: spec.redact })

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem}\n`)

    return spec.strict ? EXIT_PROBLEM : EXIT_OK
  }

  const body = spec.excerptRefusal !== undefined ? undefined : await bodyFor(spec)
  const result = await send(opened.client, spec, { body })
  const line = `cronheart: ${describePingResult(result)}\n`

  if (result.ok) {
    if (spec.verbose) {
      io.out(line)
    }

    return EXIT_OK
  }

  io.err(line)

  return spec.strict ? EXIT_PROBLEM : EXIT_OK
}

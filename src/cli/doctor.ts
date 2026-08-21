import process from 'node:process'
import { outcomeLine } from '../ping/describe.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, resolveMonitor } from '../ping/resolve.js'
import type { FetchLike, PingHttpResponse } from '../ping/types.js'
import { ambientFetch } from '../transport/send.js'
import { CONTRACT_VERSION, SDK_VERSION } from '../version.js'
import { type ParsedArgs, unknownFlags } from './args.js'
import {
  baseUrlOf,
  environment,
  hasApiKey,
  killSwitchOn,
  openClient,
  originOf,
} from './client.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { PAID_ONLY_NOTICE } from './tier.js'

const CONFIGURED_MONITOR = /^(CRONHEART|CRON_MONITOR)_(.+)_UUID$/

const IN_STEP_MS = 5000

const NOT_CHECKED =
  'whether this monitor has a notification channel attached, and whether that channel is verified — either gap leaves a missed run alerting nobody. Both are on the monitor’s page at https://cronheart.com/dashboard'

interface Configured {
  readonly name: string
  readonly variable: string
  readonly legacy: boolean
  readonly resolved: boolean
}

interface Skew {
  readonly measured: boolean
  readonly milliseconds: number
}

function configuredMonitors(env: EnvSource): Configured[] {
  const byName = new Map<string, Configured>()

  for (const key of Object.keys(env).sort()) {
    const match = CONFIGURED_MONITOR.exec(key)
    const value = (env[key] ?? '').trim()

    if (match === null || value === '') {
      continue
    }

    const stem = String(match[2])
    const canonical = `CRONHEART_${stem}_UUID`
    const legacy = key !== canonical

    if (legacy && (env[canonical] ?? '').trim() !== '') {
      continue
    }

    const name = stem.toLowerCase().replace(/_/g, '-')

    if (byName.has(name)) {
      continue
    }

    byName.set(name, { name, variable: key, legacy, resolved: isMonitorId(value) })
  }

  return [...byName.values()].sort((one, other) => one.name.localeCompare(other.name))
}

function watchTheClock(record: { response: PingHttpResponse | undefined; sentAt: number; gotAt: number }):
  | FetchLike
  | undefined {
  const transport = ambientFetch()

  if (transport === undefined) {
    return undefined
  }

  return (url, init) => {
    record.sentAt = Date.now()

    return transport(url, init).then((response) => {
      record.gotAt = Date.now()
      record.response = response

      return response
    })
  }
}

function skewFrom(record: {
  response: PingHttpResponse | undefined
  sentAt: number
  gotAt: number
}): Skew {
  const served = record.response?.headers?.get('date') ?? null

  if (served === null) {
    return { measured: false, milliseconds: 0 }
  }

  const serverMs = Date.parse(served)

  if (!Number.isFinite(serverMs)) {
    return { measured: false, milliseconds: 0 }
  }

  return { measured: true, milliseconds: record.sentAt + (record.gotAt - record.sentAt) / 2 - serverMs }
}

function describeSkew(skew: Skew): string {
  if (!skew.measured) {
    return 'not measured — the server sent no readable date'
  }

  if (Math.abs(skew.milliseconds) <= IN_STEP_MS) {
    return 'in step with the server, to the second the header carries'
  }

  const seconds = Math.round(Math.abs(skew.milliseconds) / 1000)

  return `this host is ${seconds} s ${skew.milliseconds > 0 ? 'ahead of' : 'behind'} the server`
}

function label(name: string, value: string): string {
  return `  ${name.padEnd(13)} ${value}\n`
}

export async function doctorCommand(args: ParsedArgs, io: Io): Promise<number> {
  const unknown = unknownFlags(args, [])

  if (unknown.length > 0) {
    io.err(`cronheart: doctor does not take --${unknown.join(', --')}\n`)

    return EXIT_USAGE
  }

  const env = environment()
  const base = baseUrlOf(env)
  const monitors = configuredMonitors(env)
  const asked = args.positional[1]
  // A monitor whose value does not resolve cannot answer anything, so picking one as the
  // subject of the check-in would report a configuration fault as a connectivity fault.
  const target = asked ?? monitors.find((monitor) => monitor.resolved)?.name
  const disabled = killSwitchOn(env)
  let problems = 0

  io.out('cronheart doctor\n')
  io.out(label('package', `cronheart-node ${SDK_VERSION} (contract ${CONTRACT_VERSION})`))
  io.out(label('runtime', `node ${process.versions.node} on ${process.platform}`))
  io.out(label('base url', `${originOf(base.url)} — from ${base.source}`))

  if (hasApiKey(env)) {
    io.out(label('api key', `configured; its plan cannot be verified here. ${PAID_ONLY_NOTICE}`))
  }

  if (disabled) {
    problems += 1
    io.out(label('kill switch', 'CRONHEART_DISABLED is set — nothing checks in while it stays set'))
  } else {
    io.out(label('kill switch', 'CRONHEART_DISABLED is not set'))
  }

  if (monitors.length === 0) {
    io.out(label('monitors', 'no monitor is configured in this environment'))
  } else {
    io.out(label('monitors', `${monitors.length} configured`))

    for (const monitor of monitors) {
      const leg = monitor.legacy ? ' (legacy variable name)' : ''
      const state = monitor.resolved ? 'resolved' : 'not a monitor id'

      if (!monitor.resolved) {
        problems += 1
      }

      io.out(`    ${monitor.name.padEnd(24)} ${monitor.variable}${leg} — ${state}\n`)
    }
  }

  io.out(label('not checked', NOT_CHECKED))

  if (asked !== undefined && resolveMonitor(asked, {}, env).id === undefined) {
    const known =
      monitors.length === 0
        ? 'no monitor is configured in this environment'
        : `the monitors configured here are ${monitors.map((monitor) => monitor.name).join(', ')}`

    io.out(label('check-in', `skipped — nothing resolves ${JSON.stringify(asked)}; ${known}`))

    return EXIT_PROBLEM
  }

  if (target === undefined) {
    io.out(
      label(
        'check-in',
        monitors.length === 0
          ? 'skipped — there is no monitor to check in for'
          : 'skipped — no monitor resolves to an id, so there is nothing to check in for',
      ),
    )

    return problems === 0 ? EXIT_OK : EXIT_PROBLEM
  }

  if (disabled) {
    io.out(label('check-in', 'skipped — CRONHEART_DISABLED would suppress it anyway'))

    return EXIT_PROBLEM
  }

  const record = { response: undefined as PingHttpResponse | undefined, sentAt: 0, gotAt: 0 }
  const watching = watchTheClock(record)
  const opened = openClient(
    watching === undefined ? { onResult: () => {} } : { fetch: watching, onResult: () => {} },
  )

  if (!opened.ok) {
    io.out(label('check-in', `skipped — ${opened.problem}`))

    return EXIT_PROBLEM
  }

  const result = await opened.client.ping(target)

  io.out(label('check-in', `${outcomeLine(result)} in ${result.durationMs} ms`))

  if (result.message !== undefined) {
    io.out(label('', result.message))
  }

  io.out(label('clock', describeSkew(skewFrom(record))))

  if (!result.ok) {
    problems += 1
  }

  return problems === 0 ? EXIT_OK : EXIT_PROBLEM
}

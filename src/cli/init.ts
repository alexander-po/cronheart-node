import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { envVarFor, isMonitorId } from '../ping/resolve.js'
import { type ParsedArgs, readFlag, readText, unknownFlags } from './args.js'
import { describeResult, environment, hasApiKey, openClient } from './client.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { MANAGEMENT_CLIENT_PENDING, paidOnly } from './tier.js'

const FLAGS = ['name', 'uuid', 'env-path', 'print-env']

const DASHBOARD = 'https://cronheart.com/dashboard'

const DEFAULT_ENV_FILE = '.env'

interface Answers {
  readonly name: string | undefined
  readonly id: string | undefined
}

function questionFor(field: string): string {
  return field === 'name' ? 'Monitor name: ' : 'Monitor id (paste it): '
}

// Read as a stream of lines rather than question by question: an input that ends without
// answering closes the interface instead of settling a pending question, and the command
// would then wait on a stream that is already gone.
async function askFor(missing: readonly string[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {}

  if (missing.length === 0) {
    return answers
  }

  const session = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  })

  process.stdout.write(questionFor(String(missing[0])))

  try {
    for await (const line of session) {
      const field = missing[Object.keys(answers).length]

      if (field === undefined) {
        break
      }

      answers[field] = String(line).trim()

      const next = missing[Object.keys(answers).length]

      if (next === undefined) {
        break
      }

      process.stdout.write(questionFor(next))
    }
  } catch {
  } finally {
    session.close()
    process.stdin.pause()
  }

  return answers
}

export function upsertEnvLine(existing: string | undefined, key: string, value: string): string {
  const line = `${key}=${value}`

  if (existing === undefined || existing === '') {
    return `${line}\n`
  }

  const lines = existing.split('\n')
  const at = lines.findIndex((one) => new RegExp(`^\\s*(?:export\\s+)?${key}=`).test(one))

  if (at >= 0) {
    lines[at] = line

    return lines.join('\n')
  }

  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n`
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function initCommand(args: ParsedArgs, io: Io): Promise<number> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    io.err(`cronheart: init does not take --${unknown.join(', --')}\n`)

    return EXIT_USAGE
  }

  const name = readText(args, 'name')
  const uuid = readText(args, 'uuid')
  const envFile = readText(args, 'env-path')

  for (const read of [name, uuid, envFile]) {
    if (!read.ok) {
      io.err(`cronheart: ${read.problem}\n`)

      return EXIT_USAGE
    }
  }

  const env = environment()

  const missing = [
    ...(name.ok && name.value === undefined ? ['name'] : []),
    ...(uuid.ok && uuid.value === undefined ? ['uuid'] : []),
  ]

  io.out('cronheart init\n')
  io.out(`  Create a monitor in your dashboard: ${DASHBOARD}\n`)

  if (hasApiKey(env)) {
    io.out(`  ${paidOnly(MANAGEMENT_CLIENT_PENDING)}\n`)
  }

  if (missing.includes('uuid')) {
    io.out('  Then paste its id below — that id is all a check-in needs.\n')
  }

  const answered = await askFor(missing)
  const given: Answers = {
    name: (name.ok ? name.value : undefined) ?? answered['name'],
    id: (uuid.ok ? uuid.value : undefined) ?? answered['uuid'],
  }

  if (given.name === undefined || given.name === '') {
    io.err('cronheart: init needs a monitor name — pass --name=<name> or answer the prompt\n')

    return EXIT_USAGE
  }

  if (given.id === undefined || !isMonitorId(given.id)) {
    io.err(
      'cronheart: that is not a monitor id — copy the 36-character identifier from the monitor’s page\n',
    )

    return EXIT_USAGE
  }

  const variable = envVarFor(given.name)
  const path = (envFile.ok ? envFile.value : undefined) ?? DEFAULT_ENV_FILE

  if (readFlag(args, 'print-env')) {
    io.out(`${variable}=${given.id}\n`)
  } else {
    writeFileSync(path, upsertEnvLine(readIfPresent(path), variable, given.id))
    io.out(`  wrote ${variable} to ${path}\n`)
  }

  const opened = openClient({ monitors: { [given.name]: given.id }, onResult: () => {} })

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem}\n`)

    return EXIT_PROBLEM
  }

  const result = await opened.client.ping(given.name)

  io.out(`  test ${describeResult(result)}\n`)

  return result.ok ? EXIT_OK : EXIT_PROBLEM
}

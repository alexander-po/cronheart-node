import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { escapeLiteral } from '../ping/body.js'
import { envVarFor, isMonitorId } from '../ping/resolve.js'
import { type ParsedArgs, readFlag, readText, unknownFlags } from './args.js'
import { describeResult, environment, hasApiKey, openClient } from './client.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { MANAGEMENT_CLIENT_PENDING, paidOnly } from './tier.js'

const FLAGS = ['name', 'uuid', 'env-path', 'print-env']

const DASHBOARD = 'https://cronheart.com/dashboard'

const DEFAULT_ENV_FILE = '.env'

const OWNER_ONLY = 0o600

const SECRET_FIELD = 'uuid'

interface Answers {
  readonly name: string | undefined
  readonly id: string | undefined
}

interface Echoing {
  _writeToOutput?: (text: string) => void
  readonly output?: { write(text: string): unknown } | null | undefined
}

type Existing =
  | { readonly ok: true; readonly text: string | undefined; readonly mode: number | undefined }
  | { readonly ok: false; readonly problem: string }

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? 'unknown error'
}

// On a terminal readline echoes what it reads, which would put the pasted id — the whole
// credential for the check-in route — into scrollback and into any screen being shared.
export function muteEchoWhile(session: Echoing, hidden: () => boolean): void {
  const output = session.output

  if (output === null || output === undefined) {
    return
  }

  session._writeToOutput = (text) => {
    if (!hidden()) {
      output.write(text)
    }
  }
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

  const terminal = process.stdin.isTTY === true
  const session = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
  })
  let asking = String(missing[0])

  muteEchoWhile(session as unknown as Echoing, () => asking === SECRET_FIELD)
  process.stdout.write(questionFor(asking))

  try {
    for await (const line of session) {
      const wasHidden = asking === SECRET_FIELD

      answers[asking] = String(line).trim()

      if (wasHidden && terminal) {
        process.stdout.write('\n')
      }

      const next = missing[Object.keys(answers).length]

      if (next === undefined) {
        break
      }

      asking = next
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
  const at = lines.findIndex((one) =>
    new RegExp(`^\\s*(?:export\\s+)?${escapeLiteral(key)}=`).test(one),
  )

  if (at >= 0) {
    lines[at] = line

    return lines.join('\n')
  }

  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n`
}

// Absent is the one failure that means "write a new one". A file that is unreadable would
// otherwise be replaced by a single line, and a link would divert the credential.
function inspect(path: string): Existing {
  let entry

  try {
    entry = lstatSync(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return { ok: true, text: undefined, mode: undefined }
    }

    return { ok: false, problem: `${path} cannot be examined (${codeOf(error)})` }
  }

  if (entry.isSymbolicLink()) {
    return {
      ok: false,
      problem: `${path} is a symbolic link, and a file that will hold a credential is not written through one`,
    }
  }

  try {
    return { ok: true, text: readFileSync(path, 'utf8'), mode: entry.mode & 0o777 }
  } catch (error) {
    return {
      ok: false,
      problem: `${path} exists but cannot be read (${codeOf(error)}), so it was left untouched rather than replaced`,
    }
  }
}

// Written beside the target and renamed over it: an interrupted write cannot leave half a
// secrets file behind, and a file this command creates is readable by its owner alone.
function writeSecretly(path: string, text: string, mode: number | undefined): string | undefined {
  const temporary = `${path}.${process.pid}.cronheart-tmp`

  try {
    writeFileSync(temporary, text, { mode: OWNER_ONLY, flag: 'wx' })
    chmodSync(temporary, mode ?? OWNER_ONLY)
    renameSync(temporary, path)

    return undefined
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}

    return `${path} could not be written (${codeOf(error)})`
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
    const existing = inspect(path)

    if (!existing.ok) {
      io.err(`cronheart: ${existing.problem}\n`)

      return EXIT_PROBLEM
    }

    const failed = writeSecretly(
      path,
      upsertEnvLine(existing.text, variable, given.id),
      existing.mode,
    )

    if (failed !== undefined) {
      io.err(`cronheart: ${failed}\n`)

      return EXIT_PROBLEM
    }

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

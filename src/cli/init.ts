import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { escapeLiteral } from '../ping/body.js'
import { envVarFor, isMonitorId } from '../ping/resolve.js'
import { isSyncConfigurationError } from '../sync/errors.js'
import { idempotencyKeyFor } from '../sync/key.js'
import { describeApiRefusal } from '../sync/refusal.js'
import { normaliseSchedule } from '../sync/schedule.js'
import { type ParsedArgs, readFlag, readText, unknownFlags } from './args.js'
import {
  describeResult,
  environment,
  hasApiKey,
  openClient,
  readMonitorId,
  readMonitorName,
} from './client.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { openManagementClient } from './managed.js'

const FLAGS = ['name', 'uuid', 'schedule', 'env-path', 'print-env']

const NOBODY_TO_ALERT =
  'this account has no verified notification channel, so a monitor created now would alert nobody when a run goes missing. Add one and verify it first — the REST surface attaches no channel by itself, unlike the form in the dashboard'


const DASHBOARD = 'https://cronheart.com/dashboard'

const DEFAULT_ENV_FILE = '.env'

const EXAMPLE_BINARY = '/usr/local/bin/cronheart'

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
  if (field === 'name') {
    return 'Monitor name: '
  }

  return field === 'schedule'
    ? 'Schedule (0 3 * * *, @daily, every_5_minutes or 5m): '
    : 'Monitor id (paste it): '
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

// An env file is read by an application at startup; cron reads none, and a crontab entry that
// resolves a name through one gets no id, sends nothing, and exits 0.
function nextSteps(variable: string, name: string): string {
  return [
    '',
    '  Next: that file is read by your application, not by cron. To run this job from a',
    '  crontab, put the variable there too:',
    '',
    `    ${variable}=<the id for this monitor>`,
    `    */5 * * * * ${EXAMPLE_BINARY} run --name=${name} -- /path/to/your-job`,
    '',
    '  cronheart init --print-env prints that first line with the id filled in.',
    '',
  ].join('\n')
}


type Created =
  | { readonly kind: 'created'; readonly name: string; readonly uuid: string; readonly alerts: string }
  | { readonly kind: 'refused'; readonly problem: string }
  | { readonly kind: 'usage'; readonly problem: string }
  | { readonly kind: 'degraded'; readonly notice: string }

// Everything the dashboard's own form does that this surface does not do by itself: the
// account's verified channels are read and attached, because a monitor with none of them
// alerts nobody when a run goes missing, and nothing about the create would say so.
async function createThroughTheApi(
  ask: (missing: readonly string[]) => Promise<Record<string, string>>,
  given: { readonly name: string | undefined; readonly schedule: string | undefined },
  io: Io,
): Promise<Created> {
  const opened = openManagementClient()

  if (!opened.ok) {
    return { kind: 'degraded', notice: opened.problem }
  }

  let verified: readonly { id: string; kind: string; label: string }[]

  try {
    verified = (await opened.api.channels.list()).data.filter((channel) => channel.verified)
  } catch (error) {
    return { kind: 'degraded', notice: describeApiRefusal(error, 'creating a monitor here') }
  }

  if (verified.length === 0) {
    return { kind: 'refused', problem: NOBODY_TO_ALERT }
  }

  const answered = await ask([
    ...(given.name === undefined ? ['name'] : []),
    ...(given.schedule === undefined ? ['schedule'] : []),
  ])
  const name = given.name ?? answered['name'] ?? ''
  const written = given.schedule ?? answered['schedule'] ?? ''

  if (name === '') {
    return { kind: 'usage', problem: 'init needs a monitor name — pass --name=<name> or answer the prompt' }
  }

  let request

  try {
    const schedule = normaliseSchedule(written, name)

    request = {
      name,
      scheduleKind: schedule.kind,
      scheduleExpr: schedule.expr,
      channelIds: verified.map((channel) => channel.id),
    }
  } catch (error) {
    return {
      kind: 'usage',
      problem: isSyncConfigurationError(error) ? error.message : String(error),
    }
  }

  try {
    const made = await opened.api.monitors.create(request, {
      idempotencyKey: await idempotencyKeyFor(request),
    })

    io.out(`  created ${JSON.stringify(made.name)}\n`)

    return {
      kind: 'created',
      name,
      uuid: made.uuid,
      alerts: verified.map((channel) => `${channel.label} (${channel.kind})`).join(', '),
    }
  } catch (error) {
    return { kind: 'degraded', notice: describeApiRefusal(error, 'creating a monitor here') }
  }
}

export async function initCommand(args: ParsedArgs, io: Io): Promise<number> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    io.err(`cronheart: init does not take --${unknown.join(', --')}\n`)

    return EXIT_USAGE
  }

  const name = readMonitorName(args)
  const uuid = readMonitorId(args)
  const envFile = readText(args, 'env-path')

  for (const read of [name, uuid, envFile]) {
    if (!read.ok) {
      io.err(`cronheart: ${read.problem}\n`)

      return EXIT_USAGE
    }
  }

  const env = environment()
  const schedule = readText(args, 'schedule')

  if (!schedule.ok) {
    io.err(`cronheart: ${schedule.problem}\n`)

    return EXIT_USAGE
  }

  const named = name.ok ? name.value : undefined
  const pasted = uuid.ok ? uuid.value : undefined

  io.out('cronheart init\n')

  // A pasted id is a monitor that already exists, whatever the account can do, so the key is
  // not consulted for one. Without an id and with a key, the monitor is made here.
  const made =
    pasted === undefined && hasApiKey(env)
      ? await createThroughTheApi(askFor, { name: named, schedule: schedule.value }, io)
      : undefined

  if (made?.kind === 'usage') {
    io.err(`cronheart: ${made.problem}\n`)

    return EXIT_USAGE
  }

  if (made?.kind === 'refused') {
    io.err(`cronheart: ${made.problem}\n`)

    return EXIT_PROBLEM
  }

  if (made?.kind === 'created') {
    io.out(`  alerts: ${made.alerts}\n`)
  } else {
    if (made?.kind === 'degraded') {
      io.out(`  ${made.notice}\n`)
    }

    io.out(`  Create a monitor in your dashboard: ${DASHBOARD}\n`)

    if (pasted === undefined) {
      io.out('  Then paste its id below — that id is all a check-in needs.\n')
    }
  }

  const answered =
    made?.kind === 'created'
      ? {}
      : await askFor([
          ...(named === undefined ? ['name'] : []),
          ...(pasted === undefined ? ['uuid'] : []),
        ])
  const given: Answers = {
    name: made?.kind === 'created' ? made.name : (named ?? answered['name']),
    id: made?.kind === 'created' ? made.uuid : (pasted ?? answered['uuid']),
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
    const directory = dirname(path)

    if (!existsSync(directory)) {
      io.err(
        `cronheart: ${path} cannot be written because ${directory} does not exist — create it first, or point --env-path at a file in a directory that does\n`,
      )

      return EXIT_USAGE
    }

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
  io.out(nextSteps(variable, given.name))

  return result.ok ? EXIT_OK : EXIT_PROBLEM
}

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
import type { CronheartApi, Monitor } from '../api/types.js'

const FLAGS = ['name', 'uuid', 'schedule', 'channels', 'env-path', 'print-env']

const WOULD_ALERT_NOBODY = 'a monitor created now would alert nobody when a run goes missing'

const OPT_OUT_INSTEAD =
  'or pass --channels=none to say that a monitor nobody is alerted about is what you meant'

const TWO_OF_ONE_NAME =
  'two or more monitors of this project already carry that name, and nothing here can tell which one was meant — a name is all this command has to go on, and the service enforces no uniqueness on one. Give the id of the one you meant with --uuid, or rename them where they can be seen'


const DASHBOARD = 'https://cronheart.com/dashboard'

const CHANNELS_PAGE = 'https://cronheart.com/channels'

const NO_CHANNELS = 'none'

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
// The closing advice gets followed, so it may not name a form that asks for the name again:
// a name typed differently the second time is a second monitor of one job, which is the state
// the reconciler cannot resolve.
function nextSteps(variable: string, name: string, printed: boolean): string {
  return [
    '',
    '  Next: an env file is read by your application, not by cron. To run this job from a',
    '  crontab, put the variable there too:',
    '',
    `    ${variable}=<the id for this monitor>`,
    `    */5 * * * * ${EXAMPLE_BINARY} run --name=${name} -- /path/to/your-job`,
    '',
    printed
      ? '  The assignment printed above is that first line, with the id already filled in.'
      : `  cronheart init --name=${name} --print-env prints it with the id filled in, and creates nothing.`,
    '',
  ].join('\n')
}


type Created =
  | { readonly kind: 'created'; readonly name: string; readonly uuid: string; readonly alerts: string }
  | { readonly kind: 'refused'; readonly problem: string }
  | { readonly kind: 'usage'; readonly problem: string }
  | { readonly kind: 'degraded'; readonly notice: string }

async function named(api: CronheartApi, name: string): Promise<readonly Monitor[]> {
  const found: Monitor[] = []

  for await (const monitor of api.monitors.iterate()) {
    if (monitor.name === name) {
      found.push(monitor)
    }
  }

  return found
}

function describeChannels(channels: readonly { kind: string; label: string }[]): string {
  return channels.map((channel) => `${channel.label} (${channel.kind})`).join(', ')
}

function alertsOf(
  attached: readonly { readonly id: string }[],
  verified: readonly { id: string; kind: string; label: string }[],
): string {
  const reaching = verified.filter((channel) =>
    attached.some((entry) => entry.id === channel.id),
  )

  return reaching.length === 0 ? 'nobody' : describeChannels(reaching)
}

function nothingToAlertThrough(channels: readonly { kind: string; label: string }[]): string {
  return channels.length === 0
    ? `this account has no notification channel, so ${WOULD_ALERT_NOBODY}. Add one at ${CHANNELS_PAGE}, then run this again — ${OPT_OUT_INSTEAD}`
    : `${describeChannels(channels)} — not one of this account's channels is verified, and the service skips an unverified channel when it sends an alert, so ${WOULD_ALERT_NOBODY}. Verify one at ${CHANNELS_PAGE}, then run this again — ${OPT_OUT_INSTEAD}`
}

// Everything the dashboard's own form does that this surface does not do by itself: the
// account's verified channels are read and attached, because a monitor with none of them
// alerts nobody when a run goes missing, and nothing about the create would say so. The
// closing advice here is to run this again, so running it again has to reuse rather than
// make a second monitor of one name — which is the state the reconciler cannot resolve.
async function createThroughTheApi(
  ask: (missing: readonly string[]) => Promise<Record<string, string>>,
  given: {
    readonly name: string | undefined
    readonly schedule: string | undefined
    readonly alertsNobody: boolean
  },
  io: Io,
): Promise<Created> {
  const opened = openManagementClient()

  if (!opened.ok) {
    return { kind: 'degraded', notice: opened.problem }
  }

  let channels: readonly { id: string; kind: string; label: string; verified: boolean }[]

  try {
    channels = (await opened.api.channels.list()).data
  } catch (error) {
    return { kind: 'degraded', notice: describeApiRefusal(error, 'creating a monitor here') }
  }

  const verified = channels.filter((channel) => channel.verified)

  if (verified.length === 0 && !given.alertsNobody) {
    return { kind: 'refused', problem: nothingToAlertThrough(channels) }
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
      // Sorted the way the key is derived over: the service fingerprints the raw bytes, so a
      // listing that came back in another order would be a second body under one key.
      channelIds: given.alertsNobody
        ? []
        : [...verified]
            .map((channel) => channel.id)
            .sort((one, other) => Number(one) - Number(other)),
    }
  } catch (error) {
    return {
      kind: 'usage',
      problem: isSyncConfigurationError(error) ? error.message : String(error),
    }
  }

  let already: readonly Monitor[]

  try {
    already = await named(opened.api, name)
  } catch (error) {
    return { kind: 'degraded', notice: describeApiRefusal(error, 'creating a monitor here') }
  }

  if (already.length > 1) {
    return { kind: 'refused', problem: TWO_OF_ONE_NAME }
  }

  const only = already[0]

  if (only !== undefined) {
    io.out(`  ${JSON.stringify(only.name)} is already here — using it rather than making a second\n`)

    return {
      kind: 'created',
      name,
      uuid: only.uuid,
      alerts: alertsOf(only.channels, verified),
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
      alerts: given.alertsNobody ? 'nobody' : describeChannels(verified),
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

  const routing = readText(args, 'channels')

  if (!routing.ok || (routing.value !== undefined && routing.value !== NO_CHANNELS)) {
    io.err(
      `cronheart: --channels takes ${NO_CHANNELS} and nothing else — it is how a run says a monitor nobody is alerted about is what was meant, the same word the configuration file takes\n`,
    )

    return EXIT_USAGE
  }

  const given = name.ok ? name.value : undefined
  const pasted = uuid.ok ? uuid.value : undefined

  io.out('cronheart init\n')

  // A pasted id is a monitor that already exists, whatever the account can do, so the key is
  // not consulted for one. Without an id and with a key, the monitor is made here.
  const made =
    pasted === undefined && hasApiKey(env)
      ? await createThroughTheApi(
          askFor,
          { name: given, schedule: schedule.value, alertsNobody: routing.value === NO_CHANNELS },
          io,
        )
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
          ...(given === undefined ? ['name'] : []),
          ...(pasted === undefined ? ['uuid'] : []),
        ])
  const answers: Answers = {
    name: made?.kind === 'created' ? made.name : (given ?? answered['name']),
    id: made?.kind === 'created' ? made.uuid : (pasted ?? answered['uuid']),
  }

  if (answers.name === undefined || answers.name === '') {
    io.err('cronheart: init needs a monitor name — pass --name=<name> or answer the prompt\n')

    return EXIT_USAGE
  }

  if (answers.id === undefined || !isMonitorId(answers.id)) {
    io.err(
      'cronheart: that is not a monitor id — copy the 36-character identifier from the monitor’s page\n',
    )

    return EXIT_USAGE
  }

  const variable = envVarFor(answers.name)
  const path = (envFile.ok ? envFile.value : undefined) ?? DEFAULT_ENV_FILE

  const printEnv = readFlag(args, 'print-env')

  if (printEnv) {
    io.out(`${variable}=${answers.id}\n`)
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
      upsertEnvLine(existing.text, variable, answers.id),
      existing.mode,
    )

    if (failed !== undefined) {
      io.err(`cronheart: ${failed}\n`)

      return EXIT_PROBLEM
    }

    io.out(`  wrote ${variable} to ${path}\n`)
  }

  const opened = openClient({ monitors: { [answers.name]: answers.id }, onResult: () => {} })

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem}\n`)

    return EXIT_PROBLEM
  }

  const result = await opened.client.ping(answers.name)

  io.out(`  test ${describeResult(result)}\n`)
  io.out(nextSteps(variable, answers.name, printEnv))

  return result.ok ? EXIT_OK : EXIT_PROBLEM
}

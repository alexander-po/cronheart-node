import { accessSync, constants, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { API_KEY_VARIABLE } from '../api/constants.js'
import { isCronheartApiError } from '../api/errors.js'
import type { SignupClient, SignupPollResult, SignupStarted } from '../api/types.js'
import { countdown } from '../timer.js'
import { type ParsedArgs, readFlag, readText, unknownFlags } from './args.js'
import { baseUrlOf, environment, originOf } from './client.js'
import { MAX_TIMER_MS } from './duration.js'
import { DEFAULT_ENV_FILE, assigns, inspect, upsertEnvLine, writeSecretly } from './env-file.js'
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { openSignupClient } from './managed.js'

const FLAGS = ['accept-terms', 'env-path', 'print-env']

const SHORTEST_POLL_SECONDS = 1

const LOST_TOKEN =
  'If the code was already confirmed, the account exists and its key is not shown again: set a password with Forgot password on the sign-in page, then create a key under Account → API tokens.'

type Claimed =
  | {
      readonly ok: true
      readonly token: string
      readonly prefix: string | null
      readonly project: string | null
    }
  | { readonly ok: false; readonly problem: string }

type Polled =
  | { readonly kind: 'answered'; readonly result: SignupPollResult }
  | { readonly kind: 'wait'; readonly seconds: number; readonly notice: string | undefined }
  | { readonly kind: 'stop'; readonly problem: string }

function termsRefusal(origin: string): string {
  return [
    `cronheart: signing up accepts the Terms of Service and the Privacy Policy of ${origin}:`,
    '',
    `  ${origin}/terms`,
    `  ${origin}/privacy`,
    '',
    'Read them, and run this again with --accept-terms once the person the address belongs to',
    'accepts them. The acceptance the service records is the click of whoever confirms on the',
    'page the mailed link opens.',
    '',
  ].join('\n')
}

// Asked before anything is requested, since the key is shown once, and again before the write,
// since the file can change during the wait.
function destinationRefusal(path: string): string | undefined {
  const directory = dirname(path)

  if (!existsSync(directory)) {
    return `${path} cannot be written because ${directory} does not exist — create it first, or point --env-path at a file in a directory that does`
  }

  try {
    accessSync(directory, constants.W_OK)
  } catch {
    return `${directory} is not writable, so the key could not be saved once it is issued — point --env-path at a file in a directory that is`
  }

  const existing = inspect(path)

  if (!existing.ok) {
    return existing.problem
  }

  if (assigns(existing.text, API_KEY_VARIABLE)) {
    return `${path} already assigns ${API_KEY_VARIABLE}, and a signup would replace that key — point --env-path at another file, or pass --print-env`
  }

  // The file keeps its mode when a line is added, so one others can reach would hand them the
  // key. Windows reports no such bits, so it is not asked there.
  return process.platform !== 'win32' && existing.mode !== undefined && (existing.mode & 0o077) !== 0
    ? `${path} can be read or written by others (mode ${existing.mode.toString(8)}), and it would hold the account's key — run chmod 600 on it, or point --env-path at another file`
    : undefined
}

function messageOf(error: unknown): string {
  return isCronheartApiError(error)
    ? error.message
    : 'the request failed in a way this command did not model'
}

function transient(error: unknown): boolean {
  if (!isCronheartApiError(error)) {
    return false
  }

  return error.kind === 'transport' || (error.kind === 'unexpected' && (error.status ?? 0) >= 500)
}

async function pollOnce(client: SignupClient, started: SignupStarted): Promise<Polled> {
  const interval = Math.max(started.interval, SHORTEST_POLL_SECONDS)

  try {
    return { kind: 'answered', result: await client.poll(started.deviceCode) }
  } catch (error) {
    if (isCronheartApiError(error) && error.kind === 'rate-limit') {
      return {
        kind: 'wait',
        seconds: Math.max(interval, error.retryAfterSeconds ?? interval),
        notice: undefined,
      }
    }

    if (transient(error)) {
      return {
        kind: 'wait',
        seconds: interval,
        notice: `  a poll went unanswered (${messageOf(error)}) — asking again\n`,
      }
    }

    if (isCronheartApiError(error) && error.kind === 'signup-expired') {
      return { kind: 'stop', problem: messageOf(error) }
    }

    return { kind: 'stop', problem: `${messageOf(error)} ${LOST_TOKEN}` }
  }
}

async function waitForToken(
  client: SignupClient,
  started: SignupStarted,
  say: (text: string) => void,
): Promise<Claimed> {
  const deadline = Date.now() + started.expiresIn * 1000
  let seconds = Math.max(started.interval, SHORTEST_POLL_SECONDS)

  for (;;) {
    const waited = countdown(
      Math.max(0, Math.min(seconds * 1000, deadline - Date.now(), MAX_TIMER_MS)),
    )

    await waited.reached

    if (Date.now() >= deadline) {
      return {
        ok: false,
        problem: `the code's lifetime ran out before a key was handed over. Run cronheart signup again for a new one. ${LOST_TOKEN}`,
      }
    }

    const polled = await pollOnce(client, started)

    if (polled.kind === 'stop') {
      return { ok: false, problem: polled.problem }
    }

    if (polled.kind === 'wait') {
      if (polled.notice !== undefined) {
        say(polled.notice)
      }

      seconds = polled.seconds
      continue
    }

    if (polled.result.status === 'pending') {
      seconds = Math.max(started.interval, SHORTEST_POLL_SECONDS)
      continue
    }

    return {
      ok: true,
      token: polled.result.token,
      prefix: polled.result.tokenPrefix,
      project: polled.result.project,
    }
  }
}

function showCode(email: string, started: SignupStarted): string {
  const minutes = Math.max(1, Math.ceil(started.expiresIn / 60))

  return [
    `  A mail with a confirmation link is on its way to ${email}. If that address already`,
    '  has an account, nothing here will be confirmed and an active one is mailed that nothing',
    '  changed — take a key from Account → API tokens then.',
    '',
    '  Open the link and type this code on the page it opens:',
    '',
    `      ${started.userCode}`,
    '',
    `  Waiting for the confirmation. The code expires in ${minutes} minute${minutes === 1 ? '' : 's'}; Ctrl-C stops waiting.`,
    '',
  ].join('\n')
}

function shellWord(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

function afterwards(written: string | undefined): string {
  return [
    '',
    '  The account has no password yet. Set one with Forgot password on the sign-in page to use',
    '  the dashboard.',
    '',
    ...(written === undefined
      ? []
      : [
          `  cronheart init and cronheart sync read ${API_KEY_VARIABLE} from the environment, not from`,
          `  ${written}. To use the key from this shell:`,
          '',
          `    export ${API_KEY_VARIABLE}="$(sed -n 's/^${API_KEY_VARIABLE}=//p' ${shellWord(written)})"`,
          '',
        ]),
  ].join('\n')
}

function prefixOf(prefix: string | null): string {
  return prefix === null ? 'the key' : `${prefix}…`
}

export async function signupCommand(args: ParsedArgs, io: Io): Promise<number> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    io.err(`cronheart: signup does not take --${unknown.join(', --')}\n`)

    return EXIT_USAGE
  }

  const addresses = args.positional.slice(1)
  const envFile = readText(args, 'env-path')

  if (addresses.length !== 1 || args.rest !== undefined) {
    io.err('cronheart: signup takes one email address — cronheart signup you@example.com --accept-terms\n')

    return EXIT_USAGE
  }

  if (!envFile.ok) {
    io.err(`cronheart: ${envFile.problem}\n`)

    return EXIT_USAGE
  }

  const env = environment()
  const printEnv = readFlag(args, 'print-env')
  const path = envFile.value ?? DEFAULT_ENV_FILE
  const opened = openSignupClient({ env })

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem}\n`)

    return EXIT_PROBLEM
  }

  if (!readFlag(args, 'accept-terms')) {
    io.err(termsRefusal(originOf(baseUrlOf(env).url)))

    return EXIT_USAGE
  }

  const refused = printEnv ? undefined : destinationRefusal(path)

  if (refused !== undefined) {
    io.err(`cronheart: ${refused}\n`)

    return EXIT_USAGE
  }

  // Under --print-env stdout is what a shell reads back, so it carries the assignment and
  // nothing else.
  const say = printEnv ? io.err : io.out
  const email = String(addresses[0])
  let started: SignupStarted

  say('cronheart signup\n')

  try {
    started = await opened.api.start({ email, acceptTerms: true })
  } catch (error) {
    io.err(`cronheart: ${messageOf(error)}\n`)

    return isCronheartApiError(error) && error.kind === 'invalid-request' ? EXIT_USAGE : EXIT_PROBLEM
  }

  say(showCode(email, started))

  const claimed = await waitForToken(opened.api, started, say)

  if (!claimed.ok) {
    io.err(`cronheart: ${claimed.problem}\n`)

    return EXIT_PROBLEM
  }

  const shown = prefixOf(claimed.prefix)
  const scope =
    claimed.project === null
      ? "scoped to the account's default project"
      : `scoped to the account's ${JSON.stringify(claimed.project)} project`

  if (printEnv) {
    io.out(`${API_KEY_VARIABLE}=${claimed.token}\n`)
    say(`  confirmed — ${shown} is printed above, ${scope}\n${afterwards(undefined)}`)

    return EXIT_OK
  }

  const refusedNow = destinationRefusal(path)
  const existing = inspect(path)
  const failed =
    refusedNow ??
    (existing.ok
      ? writeSecretly(path, upsertEnvLine(existing.text, API_KEY_VARIABLE, claimed.token), existing.mode)
      : existing.problem)

  if (failed !== undefined) {
    io.err(`cronheart: ${failed}. The key is shown once and this is the only copy, so it follows on stdout — store it now.\n`)
    io.out(`${API_KEY_VARIABLE}=${claimed.token}\n`)

    return EXIT_PROBLEM
  }

  say(`  confirmed — wrote ${API_KEY_VARIABLE} (${shown}) to ${path}, ${scope}\n${afterwards(path)}`)

  return EXIT_OK
}

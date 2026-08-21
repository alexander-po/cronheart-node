#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CONTRACT_VERSION, SDK_VERSION } from './version.js'
import { type ParsedArgs, parseArgv, readFlag } from './cli/args.js'
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, finish } from './cli/exit.js'
import { HELP } from './cli/help.js'
import { type Io, processIo, silenceStreamErrors } from './cli/io.js'
import { pingCommand } from './cli/ping.js'
import { runCommand } from './cli/run.js'

type Command = (args: ParsedArgs, io: Io) => Promise<number>

// A Map rather than an object literal, so a name every object inherits is not a command
// this program appears to have. The last three are loaded on demand: a wrapper a crontab
// runs every minute pays the startup cost of everything the entry file reaches.
const COMMANDS = new Map<string, Command>([
  ['run', runCommand],
  ['ping', pingCommand],
  ['doctor', async (args, io) => (await import('./cli/doctor.js')).doctorCommand(args, io)],
  ['init', async (args, io) => (await import('./cli/init.js')).initCommand(args, io)],
  ['sync', async (args, io) => (await import('./cli/sync.js')).syncCommand(args, io)],
])

async function dispatch(args: ParsedArgs, io: Io): Promise<number> {
  const name = args.positional[0]
  const command = name === undefined ? undefined : COMMANDS.get(name)

  // Ahead of --help and --version: a typo in a crontab that answers 0 reads as a success.
  if (name !== undefined && command === undefined) {
    io.err(`cronheart: ${JSON.stringify(name)} is not a cronheart command\n${HELP}`)

    return EXIT_USAGE
  }

  if (readFlag(args, 'version') || readFlag(args, 'V')) {
    io.out(`cronheart ${SDK_VERSION} (contract ${CONTRACT_VERSION})\n`)

    return EXIT_OK
  }

  if (readFlag(args, 'help') || readFlag(args, 'h')) {
    io.out(name === undefined ? HELP : (await import('./cli/help-pages.js')).helpFor(name))

    return EXIT_OK
  }

  if (command === undefined) {
    io.err(HELP)

    return EXIT_USAGE
  }

  return command(args, io)
}

// This file is published under a specifier as well as under bin, and a module somebody
// imported rather than launched must not read that program's arguments or end its process.
// The comparison is by real path because every route onto a machine — a bin shim, a package
// manager's link — is a symlink, and the loader already resolved this module's URL through one.
function launchedDirectly(): boolean {
  const entry = process.argv[1]

  if (entry === undefined) {
    return false
  }

  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    return true
  }
}

if (launchedDirectly()) {
  silenceStreamErrors()

  void dispatch(parseArgv(process.argv.slice(2)), processIo).then(finish, (error: unknown) => {
    processIo.err(`cronheart: ${error instanceof Error ? error.message : String(error)}\n`)
    finish(EXIT_INTERNAL)
  })
}

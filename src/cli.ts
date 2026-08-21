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

async function dispatch(args: ParsedArgs, io: Io): Promise<number> {
  const command = args.positional[0]

  if (readFlag(args, 'version') || readFlag(args, 'V')) {
    io.out(`cronheart ${SDK_VERSION} (contract ${CONTRACT_VERSION})\n`)

    return EXIT_OK
  }

  if (readFlag(args, 'help') || readFlag(args, 'h')) {
    io.out(command === undefined ? HELP : (await import('./cli/help-pages.js')).helpFor(command))

    return EXIT_OK
  }

  if (command === undefined) {
    io.err(HELP)

    return EXIT_USAGE
  }

  if (command === 'run') {
    return runCommand(args, io)
  }

  if (command === 'ping') {
    return pingCommand(args, io)
  }

  // Loaded on demand: a wrapper a crontab runs every minute pays the startup cost of
  // everything the entry file reaches, and neither of these is on that path.
  if (command === 'doctor') {
    return (await import('./cli/doctor.js')).doctorCommand(args, io)
  }

  if (command === 'init') {
    return (await import('./cli/init.js')).initCommand(args, io)
  }

  if (command === 'sync') {
    return (await import('./cli/sync.js')).syncCommand(args, io)
  }

  io.err(`cronheart: ${JSON.stringify(command)} is not a cronheart command\n${HELP}`)

  return EXIT_USAGE
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

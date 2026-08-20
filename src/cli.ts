#!/usr/bin/env node
import process from 'node:process'
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
    io.out(`cronheart-node ${SDK_VERSION} (contract ${CONTRACT_VERSION})\n`)

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

silenceStreamErrors()

void dispatch(parseArgv(process.argv.slice(2)), processIo).then(finish, (error: unknown) => {
  processIo.err(`cronheart: ${error instanceof Error ? error.message : String(error)}\n`)
  finish(EXIT_INTERNAL)
})

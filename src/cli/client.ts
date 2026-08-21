import { DEFAULT_BASE_URL } from '../constants.js'
import { inAnyCase } from '../ping/body.js'
import { createPingClient } from '../ping/client.js'
import { ambientEnv, envSource, isDisabled, readEnv } from '../ping/env.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, labelFor, looksLikeAnId, resolveMonitor } from '../ping/resolve.js'
import type { PingClient, PingClientOptions } from '../ping/types.js'
import { type ParsedArgs, type Read, readText } from './args.js'

export type Opened =
  | { readonly ok: true; readonly client: PingClient }
  | { readonly ok: false; readonly problem: string }

export function environment(): EnvSource {
  return ambientEnv()
}

export function baseUrlOf(env: EnvSource): { readonly url: string; readonly source: string } {
  const configured = readEnv(env, 'URL')

  return configured === undefined
    ? { url: DEFAULT_BASE_URL, source: 'the built-in default' }
    : { url: configured, source: envSource(env, 'URL') ?? 'CRONHEART_URL' }
}

// An origin carries no userinfo, path, query or fragment; anything unparseable is described.
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return 'not a URL'
  }
}

// The client redacts the id too, but only on what the wrapper hands it — by then the
// wrapper's own byte budget has already cut, which is too late for a straddling id.
export function monitorSecrets(env: EnvSource, monitor: string): readonly RegExp[] {
  const resolved = resolveMonitor(monitor, {}, env).id

  return resolved === undefined ? [] : [inAnyCase(resolved)]
}

export function hasApiKey(env: EnvSource): boolean {
  return readEnv(env, 'API_KEY') !== undefined
}

export function killSwitchOn(env: EnvSource): boolean {
  return isDisabled(env)
}

export function killSwitchVariable(env: EnvSource): string {
  return envSource(env, 'DISABLED') ?? 'CRONHEART_DISABLED'
}

export function openClient(options: PingClientOptions): Opened {
  try {
    return { ok: true, client: createPingClient(options) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, problem: message.replace(/^cronheart:\s*/, '') }
  }
}

const WRAPPERS = [
  ['{', '}', 'braces'],
  ['<', '>', 'angle brackets'],
  ['"', '"', 'quotation marks'],
  ["'", "'", 'quotation marks'],
] as const

interface GivenId {
  readonly core: string
  readonly around: string | undefined
}

// A shell rarely hands over the id alone — a substituted file keeps its line break, a copied
// GUID its braces — and reading that off is what lets the refusal cut the value it prints and
// still name the mistake it is diagnosing.
function readIdFlag(value: string): GivenId {
  const trimmed = value.trim()
  const wrapper = WRAPPERS.find(
    ([open, close]) => trimmed.length > 2 && trimmed.startsWith(open) && trimmed.endsWith(close),
  )
  const around: string[] = []

  if (trimmed !== value) {
    around.push(/[\n\r]/.test(value) ? 'a line break' : 'whitespace')
  }

  if (wrapper !== undefined) {
    around.push(wrapper[2])
  }

  return {
    core: wrapper === undefined ? trimmed : trimmed.slice(1, -1).trim(),
    around: around.length === 0 ? undefined : around.join(' and '),
  }
}

function wrongWith(core: string, around: string | undefined): string {
  if (around !== undefined) {
    return isMonitorId(core)
      ? `the 36 characters inside are an id, but ${around} came with them`
      : `${around} came with it, and what is left is not an id either`
  }

  return core.length === 36
    ? 'it is 36 characters long, but not hexadecimal in groups of 8-4-4-4-12'
    : `it is ${core.length} characters long, not 36`
}

// This is the flag a real id is passed behind, so a refusal that quoted it would print the
// check-in capability on every tick of the crontab entry that carries the mistake.
export function idFlagRefusal(value: string): string | undefined {
  if (isMonitorId(value)) {
    return undefined
  }

  const { core, around } = readIdFlag(value)

  if (!looksLikeAnId(core)) {
    return `--uuid=${core} is not a monitor id — an id is 36 characters, hexadecimal in groups of 8-4-4-4-12. To address a monitor by the name you configured it under, pass --name.`
  }

  const fix =
    around === undefined
      ? 'Copy the 36-character identifier from the monitor’s page again.'
      : 'Pass the 36 characters alone.'

  return `--uuid=${labelFor(core)} is not a monitor id — ${wrongWith(core, around)}, and it is shown cut because a whole one is a working check-in capability. ${fix}`
}

export function nameFlagRefusal(value: string): string | undefined {
  const { core } = readIdFlag(value)

  return looksLikeAnId(core)
    ? `--name=${labelFor(core)} reads as a monitor id rather than a name, so it is shown cut — pass an id as --uuid, or pick a name that is not hexadecimal in groups of 8-4-4-4-12.`
    : undefined
}

function refusedAs(given: Read<string | undefined>, refusal: string | undefined): Read<string | undefined> {
  return refusal === undefined ? given : { ok: false, problem: refusal }
}

export function readMonitorId(args: ParsedArgs): Read<string | undefined> {
  const given = readText(args, 'uuid')

  return !given.ok || given.value === undefined
    ? given
    : refusedAs(given, idFlagRefusal(given.value))
}

export function readMonitorName(args: ParsedArgs): Read<string | undefined> {
  const given = readText(args, 'name')

  return !given.ok || given.value === undefined
    ? given
    : refusedAs(given, nameFlagRefusal(given.value))
}

import { DEFAULT_BASE_URL } from '../constants.js'
import { inAnyCase } from '../ping/body.js'
import { createPingClient } from '../ping/client.js'
import { ambientEnv, isDisabled, readEnv } from '../ping/env.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, looksLikeAnId, resolveMonitor } from '../ping/resolve.js'
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
    : { url: configured, source: 'CRONHEART_URL' }
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

export function openClient(options: PingClientOptions): Opened {
  try {
    return { ok: true, client: createPingClient(options) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, problem: message.replace(/^cronheart:\s*/, '') }
  }
}

export function idFlagRefusal(value: string): string | undefined {
  return isMonitorId(value)
    ? undefined
    : `--uuid=${value} is not a monitor id — an id is 36 characters, hexadecimal in groups of 8-4-4-4-12. To address a monitor by the name you configured it under, pass --name.`
}

export function nameFlagRefusal(value: string): string | undefined {
  return looksLikeAnId(value)
    ? `--name=${value} reads as a monitor id, and would be printed back redacted rather than as a name — pass an id as --uuid, or pick a name that is not hexadecimal in groups of 8-4-4-4-12.`
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

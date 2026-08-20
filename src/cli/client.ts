import { DEFAULT_BASE_URL } from '../constants.js'
import { inAnyCase } from '../ping/body.js'
import { createPingClient } from '../ping/client.js'
import { ambientEnv, isDisabled, readEnv } from '../ping/env.js'
import type { EnvSource } from '../ping/env.js'
import { resolveMonitor } from '../ping/resolve.js'
import type { PingClient, PingClientOptions, PingResult } from '../ping/types.js'
import { withoutUserinfo } from '../wiring/validate.js'

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

export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return withoutUserinfo(baseUrl)
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

export function describeResult(result: PingResult): string {
  const status = result.status === undefined ? '' : ` (HTTP ${result.status})`

  return `${result.action} check-in for ${JSON.stringify(result.monitor)} ${result.outcome}${status}`
}

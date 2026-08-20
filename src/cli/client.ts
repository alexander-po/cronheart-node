import { DEFAULT_BASE_URL } from '../constants.js'
import { createPingClient } from '../ping/client.js'
import { ambientEnv, isDisabled, readEnv } from '../ping/env.js'
import type { EnvSource } from '../ping/env.js'
import type { PingClient, PingClientOptions, PingResult } from '../ping/types.js'

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

export type EnvSource = Readonly<Record<string, string | undefined>>

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

export function ambientEnv(): EnvSource {
  const host = globalThis as { process?: { env?: EnvSource } }

  return host.process?.env ?? {}
}

export function readEnv(env: EnvSource, name: string): string | undefined {
  const canonical = env[`CRONHEART_${name}`]
  const legacy = env[`CRON_MONITOR_${name}`]
  const value = (canonical ?? legacy ?? '').trim()

  return value === '' ? undefined : value
}

export function isDisabled(env: EnvSource): boolean {
  const value = readEnv(env, 'DISABLED')

  return value !== undefined && TRUTHY.has(value.toLowerCase())
}

export function numberFrom(env: EnvSource, name: string): number | undefined {
  const value = readEnv(env, name)

  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined
  }

  const parsed = Number(value)

  return Number.isSafeInteger(parsed) ? parsed : undefined
}

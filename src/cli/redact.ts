import type { EnvSource } from '../ping/env.js'
import { readEnv } from '../ping/env.js'
import { type ParsedArgs, type Read, readAllText } from './args.js'

export const REDACT_FLAG = 'redact'

const REDACT_ENV = 'CRONHEART_REDACT'

function compile(source: string, where: string): Read<RegExp> {
  try {
    return { ok: true, value: new RegExp(source, 'g') }
  } catch {
    return {
      ok: false,
      problem: `${where} is not a regular expression, so it would redact nothing: ${source}`,
    }
  }
}

// A pattern that cannot compile is refused, not skipped: a control that silently does nothing
// is worse than none, because whoever wrote it believes the excerpt is safe.
export function planRedaction(args: ParsedArgs, env: EnvSource): Read<readonly RegExp[]> {
  const given = readAllText(args, REDACT_FLAG)

  if (!given.ok) {
    return given
  }

  const configured = (readEnv(env, 'REDACT') ?? '')
    .split('\n')
    .map((one) => one.replace(/\r$/, ''))
    .filter((one) => one.trim() !== '')
    .map((one) => [one, REDACT_ENV] as const)
  const patterns: RegExp[] = []

  for (const [source, where] of [
    ...configured,
    ...given.value.map((one) => [one, `--${REDACT_FLAG}`] as const),
  ]) {
    const compiled = compile(source, where)

    if (!compiled.ok) {
      return compiled
    }

    patterns.push(compiled.value)
  }

  return { ok: true, value: patterns }
}

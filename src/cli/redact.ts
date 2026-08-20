import type { EnvSource } from '../ping/env.js'
import { readEnv } from '../ping/env.js'
import { type ParsedArgs, type Read, readAllText } from './args.js'

export const REDACT_FLAG = 'redact'

const REDACT_ENV = 'CRONHEART_REDACT'

export interface RedactionPlan {
  readonly patterns: readonly RegExp[]
  readonly refusal: string | undefined
}

function compile(source: string): RegExp | undefined {
  try {
    return new RegExp(source, 'g')
  } catch {
    return undefined
  }
}

function configuredIn(env: EnvSource): readonly string[] {
  return (readEnv(env, 'REDACT') ?? '')
    .split('\n')
    .map((one) => one.replace(/\r$/, ''))
    .filter((one) => one.trim() !== '')
}

// A pattern that cannot compile never silently does nothing, because whoever wrote it
// believes the excerpt is safe. On the command line the author is present, so it is a usage
// error; in an account-wide variable it would stop every wrapped job on the machine, so the
// job runs and the excerpt is withheld instead.
export function planRedaction(args: ParsedArgs, env: EnvSource): Read<RedactionPlan> {
  const given = readAllText(args, REDACT_FLAG)

  if (!given.ok) {
    return given
  }

  const fromFlags: RegExp[] = []

  for (const source of given.value) {
    const compiled = compile(source)

    if (compiled === undefined) {
      return {
        ok: false,
        problem: `--${REDACT_FLAG} is not a regular expression, so it would redact nothing: ${source}`,
      }
    }

    fromFlags.push(compiled)
  }

  const fromEnv: RegExp[] = []

  for (const source of configuredIn(env)) {
    const compiled = compile(source)

    if (compiled === undefined) {
      return {
        ok: true,
        value: {
          patterns: [],
          refusal: `${REDACT_ENV} is not a regular expression, so nothing will be excerpted at all — the command runs unchanged and the check-in carries only its one-line summary: ${source}`,
        },
      }
    }

    fromEnv.push(compiled)
  }

  return { ok: true, value: { patterns: [...fromEnv, ...fromFlags], refusal: undefined } }
}

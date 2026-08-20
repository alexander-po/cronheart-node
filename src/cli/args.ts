export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, readonly (string | true)[]>
  readonly positional: readonly string[]
  readonly rest: readonly string[] | undefined
}

export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string }

export function parseArgv(tokens: readonly string[]): ParsedArgs {
  const flags = new Map<string, (string | true)[]>()
  const positional: string[] = []
  let rest: string[] | undefined

  const remember = (name: string, value: string | true): void => {
    const seen = flags.get(name)

    if (seen === undefined) {
      flags.set(name, [value])

      return
    }

    seen.push(value)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''

    if (token === '--') {
      rest = tokens.slice(index + 1)
      break
    }

    if (token.startsWith('--') && token.length > 2) {
      const equals = token.indexOf('=')

      if (equals === -1) {
        remember(token.slice(2), true)
      } else {
        remember(token.slice(2, equals), token.slice(equals + 1))
      }

      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      remember(token.slice(1), true)
      continue
    }

    positional.push(token)
  }

  return { flags, positional, rest }
}

function needsAValue(name: string): string {
  return `--${name} needs a value — write it as --${name}=<value>`
}

export function readText(args: ParsedArgs, name: string): Read<string | undefined> {
  const given = args.flags.get(name)
  const value = given?.[given.length - 1]

  if (value === undefined) {
    return { ok: true, value: undefined }
  }

  if (value === true) {
    return { ok: false, problem: needsAValue(name) }
  }

  return { ok: true, value }
}

export function readAllText(args: ParsedArgs, name: string): Read<readonly string[]> {
  const given = args.flags.get(name) ?? []

  for (const value of given) {
    if (value === true) {
      return { ok: false, problem: needsAValue(name) }
    }
  }

  return { ok: true, value: given as readonly string[] }
}

export function readFlag(args: ParsedArgs, name: string): boolean {
  const given = args.flags.get(name)

  return given?.[given.length - 1] === true
}

export function unknownFlags(args: ParsedArgs, allowed: readonly string[]): string[] {
  const known = new Set(allowed)

  return [...args.flags.keys()].filter((name) => !known.has(name))
}

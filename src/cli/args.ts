export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, string | true>
  readonly positional: readonly string[]
  readonly rest: readonly string[] | undefined
}

export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string }

export function parseArgv(tokens: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  let rest: string[] | undefined

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''

    if (token === '--') {
      rest = tokens.slice(index + 1)
      break
    }

    if (token.startsWith('--') && token.length > 2) {
      const equals = token.indexOf('=')

      if (equals === -1) {
        flags.set(token.slice(2), true)
      } else {
        flags.set(token.slice(2, equals), token.slice(equals + 1))
      }

      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      flags.set(token.slice(1), true)
      continue
    }

    positional.push(token)
  }

  return { flags, positional, rest }
}

export function readText(args: ParsedArgs, name: string): Read<string | undefined> {
  const value = args.flags.get(name)

  if (value === undefined) {
    return { ok: true, value: undefined }
  }

  if (value === true) {
    return { ok: false, problem: `--${name} needs a value — write it as --${name}=<value>` }
  }

  return { ok: true, value }
}

export function readFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

export function unknownFlags(args: ParsedArgs, allowed: readonly string[]): string[] {
  const known = new Set(allowed)

  return [...args.flags.keys()].filter((name) => !known.has(name))
}

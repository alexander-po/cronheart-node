import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const CONFIG_NAMES: readonly string[] = [
  'cronheart.config.ts',
  'cronheart.config.mts',
  'cronheart.config.mjs',
  'cronheart.config.js',
  'cronheart.config.json',
]

const TYPESCRIPT = /\.m?ts$/

export type Loaded =
  | { readonly ok: true; readonly path: string; readonly value: unknown }
  | { readonly ok: false; readonly problem: string }

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? ''
}

// Nothing here compiles anything, and nothing is added to make it: the runtime either strips
// the types itself or it does not, and a build dependency to close that gap would cost every
// consumer of this package the thing it is sold on.
export function explainConfigFailure(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error)

  if (TYPESCRIPT.test(path) && (codeOf(error) === 'ERR_UNKNOWN_FILE_EXTENSION' || /TypeScript|type strip|Unknown file extension/i.test(message))) {
    return `${path} is TypeScript, and this Node did not load it. Node strips types by itself from 22.18 onward and needs --experimental-strip-types before that. Run a newer Node, pass that flag, or point --config at a .mjs or .json file — this package adds no compiler of its own.`
  }

  return `${path} could not be read (${message})`
}

function found(given: string | undefined, cwd: string): string | undefined {
  if (given !== undefined) {
    return isAbsolute(given) ? given : resolve(cwd, given)
  }

  return CONFIG_NAMES.map((name) => join(cwd, name)).find((candidate) => existsSync(candidate))
}

function readable(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? undefined : `${path} is not a file`
  } catch {
    return `${path} does not exist`
  }
}

export async function loadConfigFile(given: string | undefined): Promise<Loaded> {
  const cwd = process.cwd()
  const path = found(given, cwd)

  if (path === undefined) {
    return {
      ok: false,
      problem: `no configuration file was named and none of ${CONFIG_NAMES.join(', ')} is in ${cwd}`,
    }
  }

  const missing = readable(path)

  if (missing !== undefined) {
    return { ok: false, problem: missing }
  }

  if (path.endsWith('.json')) {
    try {
      return { ok: true, path, value: JSON.parse(await readFile(path, 'utf8')) }
    } catch (error) {
      return { ok: false, problem: explainConfigFailure(error, path) }
    }
  }

  try {
    const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>

    return { ok: true, path, value: module['default'] ?? module }
  } catch (error) {
    return { ok: false, problem: explainConfigFailure(error, path) }
  }
}

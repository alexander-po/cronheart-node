import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { escapeLiteral } from '../ping/body.js'

export const DEFAULT_ENV_FILE = '.env'

const OWNER_ONLY = 0o600

type Existing =
  | { readonly ok: true; readonly text: string | undefined; readonly mode: number | undefined }
  | { readonly ok: false; readonly problem: string }

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? 'unknown error'
}

function assignment(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeLiteral(key)}=`)
}

export function assigns(existing: string | undefined, key: string): boolean {
  return (existing ?? '').split('\n').some((line) => assignment(key).test(line))
}

export function upsertEnvLine(existing: string | undefined, key: string, value: string): string {
  const line = `${key}=${value}`

  if (existing === undefined || existing === '') {
    return `${line}\n`
  }

  const lines = existing.split('\n')
  const at = lines.findIndex((one) => assignment(key).test(one))

  if (at >= 0) {
    lines[at] = line

    return lines.join('\n')
  }

  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n`
}

// Absent is the one failure that means "write a new one". A file that is unreadable would
// otherwise be replaced by a single line, and a link would divert the credential.
export function inspect(path: string): Existing {
  let entry

  try {
    entry = lstatSync(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return { ok: true, text: undefined, mode: undefined }
    }

    return { ok: false, problem: `${path} cannot be examined (${codeOf(error)})` }
  }

  if (entry.isSymbolicLink()) {
    return {
      ok: false,
      problem: `${path} is a symbolic link, and a file that will hold a credential is not written through one`,
    }
  }

  try {
    return { ok: true, text: readFileSync(path, 'utf8'), mode: entry.mode & 0o777 }
  } catch (error) {
    return {
      ok: false,
      problem: `${path} exists but cannot be read (${codeOf(error)}), so it was left untouched rather than replaced`,
    }
  }
}

// Written beside the target and renamed over it: an interrupted write cannot leave half a
// secrets file behind, and a file this command creates is readable by its owner alone.
export function writeSecretly(path: string, text: string, mode: number | undefined): string | undefined {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.cronheart-tmp`
  let created = false

  try {
    const handle = openSync(temporary, 'wx', OWNER_ONLY)

    created = true

    try {
      writeFileSync(handle, text)
    } finally {
      closeSync(handle)
    }

    chmodSync(temporary, mode ?? OWNER_ONLY)
    renameSync(temporary, path)

    return undefined
  } catch (error) {
    if (created) {
      try {
        unlinkSync(temporary)
      } catch {}
    }

    return `${path} could not be written (${codeOf(error)})`
  }
}

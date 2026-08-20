import type { PingResult } from './types.js'

export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }

  try {
    return new Error(typeof value === 'string' ? value : String(value))
  } catch {
    return new Error('a check-in failed with a value that cannot be described')
  }
}

export function safely(
  fallback: PingResult,
  work: () => Promise<PingResult>,
): Promise<PingResult> {
  const rescue = (error: unknown): PingResult => {
    try {
      return { ...fallback, error: toError(error) }
    } catch {
      return fallback
    }
  }

  try {
    return Promise.resolve(work()).catch(rescue)
  } catch (error) {
    return Promise.resolve(rescue(error))
  }
}

export function rethrow<T>(error: unknown): Promise<T> {
  return Promise.reject(error)
}

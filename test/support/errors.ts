import { type AnyCronheartApiError, isCronheartApiError } from '../../src/api/errors.js'

// Narrowing a test can trust: the kind is checked at runtime, so an assertion that then
// reads a subclass field cannot pass by claiming a type nothing verified.
export function ofKind<K extends AnyCronheartApiError['kind']>(
  error: unknown,
  kind: K,
): asserts error is Extract<AnyCronheartApiError, { kind: K }> {
  if (!isCronheartApiError(error)) {
    throw new Error(`expected an error this package brands, got ${String(error)}`)
  }

  if (error.kind !== kind) {
    throw new Error(`expected a ${kind} error, got ${error.kind}`)
  }
}

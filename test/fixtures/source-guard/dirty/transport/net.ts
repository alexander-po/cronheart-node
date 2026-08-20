import { assertName } from '../wiring/check.js'

export function call(name: string): void {
  assertName(name)
}

const A_LITERAL_NOBODY_ANCHORED = 120

export function fits(value: string): boolean {
  return value.length <= A_LITERAL_NOBODY_ANCHORED
}

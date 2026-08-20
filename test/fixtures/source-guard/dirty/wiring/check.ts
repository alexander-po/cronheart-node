export function assertName(name: string): void {
  if (name === '') {
    throw new Error('empty')
  }
}

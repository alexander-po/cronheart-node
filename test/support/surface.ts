// Callables one level deep, which is the shape both the root entry and the client hand back.
export function callablesIn(namespace: object): string[] {
  return Object.entries(namespace).flatMap(([name, value]: [string, unknown]) => {
    if (typeof value === 'function') {
      return [name]
    }

    if (value === null || typeof value !== 'object') {
      return []
    }

    return Object.entries(value)
      .filter(([, member]: [string, unknown]) => typeof member === 'function')
      .map(([member]) => `${name}.${member}`)
  })
}

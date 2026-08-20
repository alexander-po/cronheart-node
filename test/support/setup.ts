import { afterEach } from 'vitest'
import { drainLeakedRejections } from './unhandled.js'

afterEach(() => {
  const leaked = drainLeakedRejections()

  if (leaked.length > 0) {
    throw new Error(
      `a check-in leaked ${leaked.length} unhandled rejection(s): ${leaked.map(String).join(', ')}`,
    )
  }
})

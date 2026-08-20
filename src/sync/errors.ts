import { CronheartConfigurationError } from '../wiring/errors.js'

// Registered rather than private, for the reason the management client's brand is: two
// copies of this package in one dependency tree hold different classes, so instanceof
// answers false for an error the other copy raised.
const BRAND = Symbol.for('cronheart.sync.error')

export class SyncConfigurationError extends CronheartConfigurationError {
  override readonly name: string = 'SyncConfigurationError'

  readonly monitor: string | undefined

  constructor(message: string, monitor?: string) {
    super(message)
    this.monitor = monitor
    Object.defineProperty(this, BRAND, { value: true, enumerable: false })
  }
}

export function isSyncConfigurationError(value: unknown): value is SyncConfigurationError {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    return (value as Record<symbol, unknown>)[BRAND] === true
  } catch {
    return false
  }
}

export function refuse(message: string, monitor?: string): never {
  throw new SyncConfigurationError(
    monitor === undefined ? message : `${JSON.stringify(monitor)}: ${message}`,
    monitor,
  )
}

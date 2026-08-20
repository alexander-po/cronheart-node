export class CronheartConfigurationError extends Error {
  override readonly name: string = 'CronheartConfigurationError'
}

export class InvalidActionError extends CronheartConfigurationError {
  override readonly name: string = 'InvalidActionError'
}

export class InvalidMonitorIdError extends CronheartConfigurationError {
  override readonly name: string = 'InvalidMonitorIdError'
}

export class UnknownMonitorError extends CronheartConfigurationError {
  override readonly name: string = 'UnknownMonitorError'
}

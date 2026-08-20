import { SDK_VERSION, userAgent } from 'cronheart'

export type PublishedSurface = {
  readonly root: typeof import('cronheart')
  readonly api: typeof import('cronheart/api')
  readonly sync: typeof import('cronheart/sync')
  readonly testing: typeof import('cronheart/testing')
  readonly croner: typeof import('cronheart/croner')
  readonly cron: typeof import('cronheart/cron')
  readonly nodeCron: typeof import('cronheart/node-cron')
  readonly nodeSchedule: typeof import('cronheart/node-schedule')
  readonly bullmq: typeof import('cronheart/bullmq')
  readonly nestjs: typeof import('cronheart/nestjs')
}

export function describeClient(): string {
  return `${SDK_VERSION} via ${userAgent()}`
}

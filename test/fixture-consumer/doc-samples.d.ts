import type { ConnectionOptions, Job } from 'bullmq'
import type { CreateMonitorRequest, CronheartApi } from 'cronheart/api'

// What a sample names but does not introduce: the reader's own job, logger and queue
// connection, and the handful of package members a section earlier in the same document
// already imported. The package members are declared through the published surface, so a
// renamed export fails here rather than being quietly supplied.
declare global {
  function runBackup(): Promise<void>
  function sendDigest(job: Job): Promise<void>
  const connection: ConnectionOptions
  const api: CronheartApi
  const request: CreateMonitorRequest
  const log: { warn(message: string): void; info(message: string): void }
  interface Logger {
    warn(message: string): void
  }
  class Digests {}
  const checkIn: typeof import('cronheart').checkIn
  const createPingClient: typeof import('cronheart').createPingClient
  const isCronheartApiError: typeof import('cronheart/api').isCronheartApiError
}

export {}

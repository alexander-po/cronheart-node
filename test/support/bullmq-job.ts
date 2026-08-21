import type { Job } from 'bullmq'

export interface JobFacts {
  readonly name?: string | undefined
  readonly attempts?: number | undefined
  readonly attemptsStarted?: number | undefined
  readonly attemptsMade?: number | undefined
  readonly pattern?: string | undefined
  readonly every?: number | undefined
  readonly oneOff?: boolean | undefined
}

// The half of bullmq's Job the adapter reads. A repeating job by default, because that is
// the shape a job scheduler produces and the only one the adapter checks in for.
export function fakeJob(facts: JobFacts = {}): Job {
  const repeat = facts.oneOff === true ? undefined : { pattern: facts.pattern ?? '0 3 * * *', every: facts.every }

  return {
    name: facts.name ?? 'nightly-digest',
    attemptsStarted: facts.attemptsStarted ?? 1,
    attemptsMade: facts.attemptsMade ?? 0,
    ...(facts.oneOff === true ? {} : { repeatJobKey: 'a-scheduler-id' }),
    opts: { attempts: facts.attempts, repeat },
  } as unknown as Job
}

// A job every read of which explodes, which is what an adapter that reads it outside a
// guard hands straight to the worker's tick.
export function hostileJob(): Job {
  const job = {}

  for (const member of ['name', 'opts', 'attemptsStarted', 'attemptsMade', 'repeatJobKey']) {
    Object.defineProperty(job, member, {
      enumerable: true,
      get: () => {
        throw new TypeError(`the job's ${member} exploded when read`)
      },
    })
  }

  return job as Job
}

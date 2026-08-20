import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPingClient } from '../src/ping/client.js'
import type {
  AbortSignalLike,
  FetchLike,
  PingClientOptions,
  PingHttpResponse,
  PingOptions,
  PingResult,
} from '../src/ping/types.js'
import { clearWarnings, createPingRecorder } from '../src/testing.js'
import { CronheartConfigurationError } from '../src/wiring/errors.js'
import { captureUnhandledRejections } from './support/unhandled.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000a1'
const BASE = 'https://hostile.example'

let recorder = createPingRecorder()
let warnings: string[] = []

function client(extra: PingClientOptions = {}) {
  return createPingClient({
    baseUrl: BASE,
    fetch: recorder.fetch,
    env: {},
    monitors: { job: MONITOR_ID },
    ...extra,
  })
}

function later(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function within<T>(ms: number, work: Promise<T>): Promise<T | 'still-running'> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const marker = new Promise<'still-running'>((resolve) => {
    handle = setTimeout(() => resolve('still-running'), ms)
  })

  try {
    return await Promise.race([work, marker])
  } finally {
    if (handle !== undefined) {
      clearTimeout(handle)
    }
  }
}

function responding(build: () => PingHttpResponse): FetchLike {
  return () => Promise.resolve(build())
}

function errorWhose(accessor: 'stack' | 'message'): Error {
  const failure = new Error('the job itself failed')

  Object.defineProperty(failure, accessor, {
    configurable: true,
    get: () => {
      throw new TypeError(`the host error's ${accessor} exploded`)
    },
  })

  return failure
}

function optionsWithAThrowingGetter(): PingOptions {
  return {
    get body(): string | undefined {
      throw new TypeError('the options object exploded')
    },
    get runtimeMs(): number | undefined {
      throw new TypeError('the options object exploded')
    },
  }
}

beforeEach(() => {
  recorder = createPingRecorder()
  warnings = []
  clearWarnings()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a response the transport never finishes handing over', () => {
  it('runs out of the budget rather than waiting forever on the body', async () => {
    const sdk = client({
      timeoutMs: 60,
      retries: 0,
      fetch: responding(() => ({
        status: 200,
        headers: { get: () => null },
        bodyUsed: false,
        body: { cancel: () => Promise.resolve() },
        text: () => new Promise<string>(() => {}),
      })),
    })

    const settled = await within(1000, sdk.ping('job'))

    expect(settled).not.toBe('still-running')
    expect((settled as PingResult).outcome).toBe('timeout')
  })

  it('runs the job anyway, because a stalled start check-in must not gate it', async () => {
    let ran = false
    const sdk = client({
      timeoutMs: 60,
      retries: 0,
      fetch: responding(() => ({
        status: 200,
        headers: { get: () => null },
        bodyUsed: false,
        body: { cancel: () => Promise.resolve() },
        text: () => new Promise<string>(() => {}),
      })),
    })

    const settled = await within(
      1000,
      sdk.withMonitor('job', () => {
        ran = true

        return 'the job value'
      }),
    )

    expect(ran).toBe(true)
    expect(settled).toBe('the job value')
  })

  it('gives the body release its own deadline, so a cancel that hangs is not fatal', async () => {
    const sdk = client({
      timeoutMs: 60,
      retries: 0,
      fetch: responding(() => ({
        status: 200,
        headers: { get: () => null },
        bodyUsed: false,
        body: { cancel: () => new Promise<void>(() => {}) },
        text: () => new Promise<string>(() => {}),
      })),
    })

    const settled = await within(1000, sdk.ping('job'))

    expect(settled).not.toBe('still-running')
  })
})

describe('a result sink that returns a promise', () => {
  it('is settled defensively, because the void return type invites an async one', async () => {
    const { unhandled } = await captureUnhandledRejections(async () => {
      await client({
        onResult: async () => {
          await later(5)

          throw new Error('the observer exploded later')
        },
      }).ping('job')
      await later(20)
    })

    expect(unhandled).toEqual([])
  })
})

describe('a host error whose own accessors throw', () => {
  it.each(['stack', 'message'] as const)(
    'still arrives at the caller unchanged when %s explodes',
    async (accessor) => {
      const failure = errorWhose(accessor)
      let caught: unknown

      await client()
        .withMonitor('job', () => Promise.reject(failure))
        .catch((error: unknown) => {
          caught = error
        })

      expect(caught).toBe(failure)
      expect(recorder.pings.map((ping) => ping.action)).toEqual(['start', 'fail'])
    },
  )

  it('is described without reading a stack nobody asked for', async () => {
    const failure = errorWhose('stack')

    const result = await client().startRun('job').fail(failure)

    expect(result.outcome).toBe('accepted')
    expect(recorder.pings).toHaveLength(2)
  })
})

describe('an options object with a throwing getter', () => {
  it('does not stop the job from running', async () => {
    let ran = false

    const returned = await client().withMonitor(
      'job',
      () => {
        ran = true

        return 'the job value'
      },
      optionsWithAThrowingGetter(),
    )

    expect(ran).toBe(true)
    expect(returned).toBe('the job value')
  })

  it('does not throw out of startRun, which the job calls on its own frame', async () => {
    const sdk = client()

    const run = sdk.startRun('job', optionsWithAThrowingGetter())
    const result = await run.success()

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
  })

  it('does not throw out of the thunk a scheduler calls on every tick', () => {
    const beat = client().checkInWith('job', optionsWithAThrowingGetter())

    expect(() => beat()).not.toThrow()
  })

  it('reports an outcome from a direct check-in rather than throwing', async () => {
    const result = await client().ping('job', optionsWithAThrowingGetter())

    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
  })
})

describe('a caller signal that is hostile rather than absent', () => {
  it.each(['aborted', 'addEventListener'] as const)(
    'leaves no detached deadline behind when %s throws',
    async (member) => {
      const signal: AbortSignalLike = {
        get aborted(): boolean {
          if (member === 'aborted') {
            throw new TypeError('the signal exploded')
          }

          return false
        },
        addEventListener: () => {
          if (member === 'addEventListener') {
            throw new TypeError('the signal exploded')
          }
        },
        removeEventListener: () => {},
      }

      const { unhandled } = await captureUnhandledRejections(async () => {
        await client({ timeoutMs: 40, retries: 0, signal }).ping('job')
        await later(150)
      })

      expect(unhandled).toEqual([])
    },
  )
})

describe('a response that is not a response', () => {
  it('leaves no body open on the way out', async () => {
    let open = 0
    const sdk = client({
      retries: 0,
      fetch: responding(() => {
        open += 1

        return {
          get status(): number {
            throw new TypeError('status exploded')
          },
          bodyUsed: false,
          body: {
            cancel: () => {
              open -= 1

              return Promise.resolve()
            },
          },
        }
      }),
    })

    const result = await sdk.ping('job')

    expect(result.outcome).toBe('unexpected')
    expect(open).toBe(0)
  })
})

describe('the once-per-process warning', () => {
  it('is once per monitor, not once for the whole process', async () => {
    const sdk = client({ monitors: {} })

    await sdk.ping('nightly-backup')
    await sdk.ping('invoice-run')

    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).toContain('CRONHEART_NIGHTLY_BACKUP_UUID')
    expect(warnings.join('\n')).toContain('CRONHEART_INVOICE_RUN_UUID')
  })

  it('names no environment variable for a monitor addressed by its raw id', async () => {
    recorder.respondWith({ status: 404, body: 'Monitor not found' })

    await client({ retries: 0 }).ping(MONITOR_ID.toUpperCase())

    expect(warnings).toHaveLength(1)
    expect(warnings.join('\n').toLowerCase().replaceAll('_', '-')).not.toContain(
      MONITOR_ID.toLowerCase(),
    )
  })
})

describe('redaction of the monitor id', () => {
  it('covers the case the server writes it in as well as the case it was configured in', async () => {
    const upper = MONITOR_ID.toUpperCase()

    await client({ monitors: { job: upper } }).fail('job', {
      body: `curl -fsS ${BASE}/ping/${MONITOR_ID.toLowerCase()} failed`,
    })
    await client({ monitors: { job: MONITOR_ID.toLowerCase() } }).fail('job', {
      body: `curl -fsS ${BASE}/ping/${upper} failed`,
    })

    const bodies = recorder.pings.map((ping) => ping.body ?? '')

    expect(bodies[0]).not.toContain(MONITOR_ID.toLowerCase())
    expect(bodies[1]).not.toContain(upper)
    expect(bodies.join('\n')).toContain('[redacted]')
  })
})

// Every member of the options object the caller hands createPingClient, so that a member
// added later has to be added here too rather than reaching the host unguarded.
const CLIENT_OPTIONS = [
  'baseUrl',
  'monitors',
  'timeoutMs',
  'retries',
  'disabled',
  'fetch',
  'env',
  'onResult',
  'truncate',
  'redact',
  'includeStack',
  'signal',
  'userAgent',
] as const

// The ones read while the client is being built, which is the only moment this factory is
// allowed to throw at all.
const READ_AT_WIRING_TIME = [
  'baseUrl',
  'monitors',
  'timeoutMs',
  'retries',
  'disabled',
  'env',
  'truncate',
  'redact',
  'includeStack',
] as const

function buildingWith(member: string): string {
  const options: Record<string, unknown> = { baseUrl: BASE, env: {}, monitors: { job: MONITOR_ID } }

  Object.defineProperty(options, member, {
    enumerable: true,
    get: () => {
      throw new TypeError(`the ${member} the caller passed in exploded`)
    },
  })

  try {
    createPingClient(options as PingClientOptions)

    return 'built'
  } catch (error) {
    return error instanceof CronheartConfigurationError
      ? 'refused'
      : `escaped: ${String(error)}`
  }
}

describe('the options the check-in client is built from', () => {
  it.each(CLIENT_OPTIONS)('lets nothing but a refusal out when %s cannot be read', (member) => {
    expect(buildingWith(member)).toMatch(/^(built|refused)$/)
  })

  it.each(READ_AT_WIRING_TIME)('refuses to build at all when %s cannot be read', (member) => {
    expect(buildingWith(member)).toBe('refused')
  })

  it('says which option it refused, rather than reporting a method the value does not have', () => {
    const refusal = (() => {
      try {
        createPingClient({ baseUrl: 42 as unknown as string, env: {} })

        return 'built'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()

    expect(refusal).toContain('cronheart:')
    expect(refusal).toContain('baseUrl')
  })
})

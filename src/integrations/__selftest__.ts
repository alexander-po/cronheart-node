import type { FetchLike } from '../ping/types.js'
import { send } from '../transport/send.js'

export interface UnsafeSelfTestContext {
  readonly baseUrl: string
  readonly monitorId: string
  readonly fetch: FetchLike | undefined
}

const MARKER = '__selftest__'

// Deliberately unsafe, and deliberately absent from the build entry map: this is the
// negative control the fault matrix runs against to prove the harness can go red. It
// breaks every fail-open invariant on purpose — never import it from shipped code.
export async function unsafelyMonitored<T>(
  context: UnsafeSelfTestContext,
  run: () => T | PromiseLike<T>,
): Promise<unknown> {
  const sink = (globalThis as { console: { warn: (message: string) => void } }).console
  sink.warn(`cronheart ${MARKER}: about to check in for ${context.monitorId}`)
  void Promise.reject(new Error(`cronheart ${MARKER}: nobody is handling this rejection`))

  await send({
    url: `${context.baseUrl}/ping/${context.monitorId}`,
    method: 'GET',
    headers: {},
    body: undefined,
    timeoutMs: 60_000,
    retries: 0,
    signal: undefined,
    fetch: context.fetch,
  })

  try {
    const value = await run()

    return { value }
  } catch (error) {
    return Promise.reject(new Error(`cronheart ${MARKER}: the job failed — ${String(error)}`))
  }
}

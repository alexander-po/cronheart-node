import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/ping/resolve.js', async (original) => ({
  ...(await original<typeof import('../src/ping/resolve.js')>()),
  labelFor: () => {
    throw new RangeError('Maximum call stack size exceeded')
  },
  resolveMonitor: () => {
    throw new RangeError('Maximum call stack size exceeded')
  },
}))

const { createPingClient } = await import('../src/ping/client.js')
const { createPingRecorder } = await import('../src/testing.js')

describe('a label the ping client cannot build', () => {
  it('settles the check-in rather than throwing out of ping()', async () => {
    const client = createPingClient({ env: {}, fetch: createPingRecorder().fetch, onResult: () => {} })

    await expect(Promise.resolve().then(() => client.ping('nightly'))).resolves.toMatchObject({ ok: false })
  })
})

import { createPingClient } from '../../src/ping/client.js'
import type { PingClient, PingResult } from '../../src/ping/types.js'
import { type PingRecorder, createPingRecorder } from '../../src/testing.js'

export const ADAPTER_MONITOR = 'nightly-backup'

export const ADAPTER_MONITOR_ID = '00000000-0000-4000-8000-00000000ada9'

export const ADAPTER_BASE_URL = 'https://adapters.example'

export interface AdapterHarness {
  readonly client: PingClient
  readonly recorder: PingRecorder
  actions(): readonly (string | null)[]
  bodies(): readonly (string | undefined)[]
  results(): readonly PingResult[]
  settled(): Promise<void>
}

export function harness(monitors?: Readonly<Record<string, string>>): AdapterHarness {
  const recorder = createPingRecorder()
  const results: PingResult[] = []
  const client = createPingClient({
    baseUrl: ADAPTER_BASE_URL,
    monitors: monitors ?? { [ADAPTER_MONITOR]: ADAPTER_MONITOR_ID },
    env: {},
    fetch: recorder.fetch,
    retries: 0,
    timeoutMs: 500,
    onResult: (result) => results.push(result),
  })

  return {
    client,
    recorder,
    actions: () => recorder.pings.map((ping) => ping.action),
    bodies: () => recorder.pings.map((ping) => ping.body),
    results: () => results,
    settled: () => client.flush(1000),
  }
}

// A promise the test resolves by hand, so a job can be held open long enough for a second
// tick to land on top of it — which is the only way an overlap case is a real overlap
// rather than two runs that happen to be described as one.
export function gate(): { held: Promise<void>; release: () => void } {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = () => resolve()
  })

  return { held, release }
}

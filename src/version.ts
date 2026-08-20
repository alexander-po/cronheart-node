declare const __CRONHEART_VERSION__: string
declare const __CRONHEART_CONTRACT_VERSION__: string

export const SDK_VERSION: string = __CRONHEART_VERSION__

export const CONTRACT_VERSION: string = __CRONHEART_CONTRACT_VERSION__

export function userAgent(): string {
  const runtime = runtimeSegment()
  const client = `cronheart-node/${SDK_VERSION} contract/${CONTRACT_VERSION}`

  return runtime === undefined ? client : `${client} ${runtime}`
}

function runtimeSegment(): string | undefined {
  const globals = globalThis as { process?: { versions?: { node?: string } } }
  const nodeVersion = globals.process?.versions?.node

  return typeof nodeVersion === 'string' ? `node/${nodeVersion}` : undefined
}

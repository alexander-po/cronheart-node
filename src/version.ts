declare const __CRONHEART_VERSION__: string

export const SDK_VERSION: string = __CRONHEART_VERSION__

export function userAgent(): string {
  const runtime = runtimeSegment()

  return runtime === undefined
    ? `cronheart-node/${SDK_VERSION}`
    : `cronheart-node/${SDK_VERSION} ${runtime}`
}

function runtimeSegment(): string | undefined {
  const host = globalThis as { process?: { versions?: { node?: string } } }
  const nodeVersion = host.process?.versions?.node

  return typeof nodeVersion === 'string' ? `node/${nodeVersion}` : undefined
}

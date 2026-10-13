import { readFileSync } from 'node:fs'
import type { CreateChannelRequest } from '../../src/api/types.js'

interface Anchor {
  readonly id: string
  readonly value: unknown
}

const CONTRACT = JSON.parse(
  readFileSync(new URL('../../contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as { anchors: Anchor[]; vocabularies: Record<string, { members: string[] }> }

const REQUIRED_FOR = /^constraints\.channel\.([a-z_]+)\.required_for$/

export const CHANNEL_KINDS: readonly string[] = CONTRACT.vocabularies['channel.kind']?.members ?? []

export const REQUIRED_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  CONTRACT.anchors.flatMap((anchor) => {
    const field = REQUIRED_FOR.exec(anchor.id)?.[1]

    return field === undefined ? [] : [[field, anchor.value as string[]] as const]
  }),
)

export function optionNameOf(wireKey: string): string {
  return wireKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

export function letterOf(wireKey: string): string {
  return 'abcdefgh'.charAt([...REQUIRED_FIELDS.keys()].indexOf(wireKey))
}

export function fillerFor(wireKey: string): string {
  return letterOf(wireKey).repeat(24)
}

export function requiredBy(kind: string): string[] {
  return [...REQUIRED_FIELDS].filter(([, kinds]) => kinds.includes(kind)).map(([field]) => field)
}

export function kindRequiring(wireKey: string): string {
  return REQUIRED_FIELDS.get(wireKey)?.[0] ?? ''
}

export function channelRequest(kind: string, field: string, value?: unknown): CreateChannelRequest {
  const request: Record<string, unknown> = { kind, label: 'ops room' }

  for (const other of requiredBy(kind).filter((required) => required !== field)) {
    request[optionNameOf(other)] = fillerFor(other)
  }

  if (value !== undefined) {
    request[optionNameOf(field)] = value
  }

  return request as unknown as CreateChannelRequest
}

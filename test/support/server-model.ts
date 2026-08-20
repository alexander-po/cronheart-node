import { readFileSync } from 'node:fs'

interface Contract {
  readonly contract_version: string
  readonly ping: { readonly routes: readonly { readonly action_pattern?: string }[] }
  readonly vocabularies: Readonly<Record<string, { readonly members?: readonly string[] }>>
}

export const contract = JSON.parse(
  readFileSync(new URL('../../contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as Contract

const ACTION_ROUTE_PATTERN = new RegExp(contract.ping.routes[1]?.action_pattern ?? '(?!)')

const ASCII_DIGITS = /^[0-9]+$/

export interface ActionClassification {
  readonly routable: boolean
  readonly kind: string | null
  readonly mapperKind: string
}

function mapperKindOf(action: string | null): string {
  if (action === null || action === '' || action === 'run') {
    return 'heartbeat'
  }

  const lowered = action.toLowerCase()

  if (lowered === 'start') {
    return 'start'
  }

  if (lowered === 'success' || lowered === 'ok' || lowered === '0') {
    return 'success'
  }

  if (lowered === 'fail' || ASCII_DIGITS.test(lowered)) {
    return 'fail'
  }

  return 'heartbeat'
}

export function classifyAction(action: string | null): ActionClassification {
  const routable = action === null || ACTION_ROUTE_PATTERN.test(action)
  const mapperKind = mapperKindOf(action)

  return { routable, kind: routable ? mapperKind : null, mapperKind }
}

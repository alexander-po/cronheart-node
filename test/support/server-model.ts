import { readFileSync } from 'node:fs'

interface Contract {
  readonly contract_version: string
  readonly ping: { readonly routes: readonly { readonly action_pattern?: string }[] }
  readonly vocabularies: Readonly<Record<string, { readonly members?: readonly string[] }>>
}

export const contract = JSON.parse(
  readFileSync(new URL('../../contract/cronheart-contract.json', import.meta.url), 'utf8'),
) as Contract

const ACTION_PATTERN = new RegExp(contract.ping.routes[1]?.action_pattern ?? '(?!)')

const ASCII_DIGITS = /^[0-9]+$/

export interface ActionClassification {
  readonly routable: boolean
  readonly kind: string | null
  readonly mapperKind: string | null
}

function mapperKindOf(action: string | null): string | null {
  if (action === null || action === '') {
    return 'heartbeat'
  }

  if (!ACTION_PATTERN.test(action)) {
    return null
  }

  const lowered = action.toLowerCase()

  if (lowered === 'run') {
    return 'heartbeat'
  }

  if (lowered === 'start') {
    return 'start'
  }

  if (lowered === 'success' || lowered === 'ok' || lowered === '0') {
    return 'success'
  }

  if (lowered === 'fail' || ASCII_DIGITS.test(lowered)) {
    return 'fail'
  }

  throw new Error(`${JSON.stringify(action)} passes the contract's action pattern but maps to no kind`)
}

export function classifyAction(action: string | null): ActionClassification {
  const routable = action === null || ACTION_PATTERN.test(action)
  const mapperKind = mapperKindOf(action)

  return { routable, kind: routable ? mapperKind : null, mapperKind }
}

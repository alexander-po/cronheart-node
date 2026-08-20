import { createCronheartApi } from '../api/client.js'
import type { CronheartApi, CronheartApiOptions } from '../api/types.js'
import { PAID_ONLY_NOTICE } from './tier.js'

export type Managed =
  | { readonly ok: true; readonly api: CronheartApi }
  | { readonly ok: false; readonly problem: string }

export function openManagementClient(options: CronheartApiOptions = {}): Managed {
  try {
    return { ok: true, api: createCronheartApi(options) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      problem: `${message.replace(/^cronheart:\s*/, '')} ${PAID_ONLY_NOTICE}`,
    }
  }
}

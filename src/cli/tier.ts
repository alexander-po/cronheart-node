export { PAID_ONLY_NOTICE } from '../api/tier.js'

import { PAID_ONLY_NOTICE } from '../api/tier.js'

export const MANAGEMENT_CLIENT_PENDING =
  'creating a monitor from the command line needs the management client, which is not in this release'

export function paidOnly(what: string): string {
  return `cronheart: ${what}. ${PAID_ONLY_NOTICE}`
}

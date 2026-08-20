// Hard-coded, never composed from a response: the server's own detail string is a translation
// key on one status and product prose on another, so relaying it shows a reader either.
export const PAID_ONLY_NOTICE =
  'The REST API needs the Starter plan or above (HTTP 402). Check-ins work on every plan, Free included — see https://cronheart.com/pricing'

export const MANAGEMENT_CLIENT_PENDING =
  'creating a monitor from the command line needs the management client, which is not in this release'

export function paidOnly(what: string): string {
  return `cronheart: ${what}. ${PAID_ONLY_NOTICE}`
}

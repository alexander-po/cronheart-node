// Anchored at both ends: an unanchored prefix reads localhost.attacker.example and
// 127.attacker.example as loopback, and a credential then travels in the clear to them.
const LOOPBACK = /^(localhost|\[::1\]|127(\.\d+){3})$/i

export function baseUrlRefusal(baseUrl: string): string | undefined {
  let parsed: URL

  try {
    parsed = new URL(baseUrl)
  } catch {
    return 'that value cannot be a base URL — it is not a URL'
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'that value cannot be a base URL — it is not http or https'
  }

  // Origin and path only, so a key parked in the userinfo, the query or the fragment is
  // not quoted back by the message refusing it. The parser percent-encodes every quote.
  const quoted = `"${parsed.origin}${parsed.pathname}" cannot be a base URL — `

  if (parsed.search !== '' || parsed.hash !== '') {
    return `${quoted}it carries a query string or a fragment`
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return `${quoted}it carries a credential`
  }

  if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname)) {
    return `${quoted}it is plain http to a host that is not loopback`
  }

  return undefined
}

import ipaddr from 'ipaddr.js'

/** Normalize a Node socket address to a canonical IP literal. */
export function normalizeIp(value: string): string {
  const parsed = ipaddr.process(value)
  return parsed.toNormalizedString()
}

/** Whether an IP belongs to one literal or CIDR entry. */
export function ipMatches(value: string, rule: string): boolean {
  try {
    const address = ipaddr.process(value)
    const [range, prefix] = rule.includes('/')
      ? ipaddr.parseCIDR(rule)
      : [ipaddr.process(rule), ipaddr.process(rule).kind() === 'ipv4' ? 32 : 128] as const
    if (address.kind() !== range.kind()) return false
    return address.match(range, prefix)
  } catch {
    return false
  }
}

/** Validate and canonicalize an IP or CIDR rule. */
export function normalizeIpRule(rule: string): string {
  const value = rule.trim().toLowerCase() === 'localhost' ? '127.0.0.0/8' : rule.trim()
  if (value.includes('/')) {
    const [address, prefix] = ipaddr.parseCIDR(value)
    return `${address.toNormalizedString()}/${String(prefix)}`
  }
  return ipaddr.process(value).toNormalizedString()
}

/** Resolve the nearest untrusted client from a proxy-appended address chain. */
export function resolveClientIp(peerValue: string, forwarded: string | undefined, trustedProxies: readonly string[]): string {
  const peer = normalizeIp(peerValue)
  if (!trustedProxies.some(rule => ipMatches(peer, rule))) return peer
  const values = (forwarded ?? '').split(',').map(value => value.trim()).filter(Boolean).map(normalizeIp)
  const chain = [...values, peer]
  while (chain.length > 1 && trustedProxies.some(rule => ipMatches(chain.at(-1) ?? '', rule))) chain.pop()
  return chain.at(-1) ?? peer
}

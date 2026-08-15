import { describe, expect, it } from 'vitest'
import { ipMatches, normalizeIp, normalizeIpRule, resolveClientIp } from '../src/network.js'

describe('IP rules', () => {
  it('normalizes loopback aliases and mapped IPv4 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeIpRule('localhost')).toBe('127.0.0.0/8')
    expect(normalizeIpRule('::1')).toBe('0:0:0:0:0:0:0:1')
  })

  it('matches exact addresses and CIDRs without crossing address families', () => {
    expect(ipMatches('127.0.0.8', '127.0.0.0/8')).toBe(true)
    expect(ipMatches('10.0.1.1', '10.0.0.0/24')).toBe(false)
    expect(ipMatches('::1', '127.0.0.1')).toBe(false)
    expect(ipMatches('bad', '127.0.0.1')).toBe(false)
  })

  it('ignores forwarded headers from untrusted peers and peels trusted proxies from the right', () => {
    expect(resolveClientIp('198.51.100.8', '203.0.113.9', ['127.0.0.1'])).toBe('198.51.100.8')
    expect(resolveClientIp('127.0.0.1', '192.0.2.9, 203.0.113.7', ['127.0.0.0/8', '203.0.113.0/24']))
      .toBe('192.0.2.9')
  })
})

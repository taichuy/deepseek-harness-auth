import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthCenter, { type Config } from '../src/center.js'
import type { AuthProvider } from '../src/types.js'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function center(overrides: Partial<Config> = {}): Promise<{ ctx: Context; center: AuthCenter; provider: AuthProvider; setRevision(value: number): void }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AuthCenter, {
    maxAttempts: 2,
    lockSeconds: 30,
    sessionTtlSeconds: 60,
    captchaMode: 'off',
    captchaAfterFailures: 1,
    ...overrides,
  })
  let revision = 1
  const provider: AuthProvider = {
    id: 'password',
    initialized: async () => true,
    revision: async () => revision,
    bypasses: async ip => ip === '127.0.0.1',
    authenticate: async credentials => credentials.username === 'owner' && credentials.password === 'correct'
      ? { username: 'owner', provider: 'password' }
      : undefined,
  }
  ctx.authCenter.register(provider)
  return { ctx, center: ctx.authCenter, provider, setRevision: value => { revision = value } }
}

describe('Auth Center', () => {
  it('locks the sixth-style attempt key for the configured duration without leaking account existence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'))
    const { center: auth } = await center()
    const attempt = { provider: 'password', username: 'owner', password: 'wrong', clientIp: '203.0.113.4' }
    expect(await auth.login(attempt)).toEqual({ status: 'invalid', captchaRequired: false })
    expect(await auth.login(attempt)).toEqual({ status: 'invalid', captchaRequired: false })
    expect(await auth.login(attempt)).toEqual({ status: 'locked', retryAfterSeconds: 30 })
    vi.advanceTimersByTime(30_000)
    expect(await auth.login(attempt)).toEqual({ status: 'invalid', captchaRequired: false })
  })

  it('also locks by source IP when an attacker rotates usernames', async () => {
    const { center: auth } = await center()
    expect(await auth.login({ provider: 'password', username: 'first', password: 'wrong', clientIp: '203.0.113.8' })).toMatchObject({ status: 'invalid' })
    expect(await auth.login({ provider: 'password', username: 'second', password: 'wrong', clientIp: '203.0.113.8' })).toMatchObject({ status: 'invalid' })
    expect(await auth.login({ provider: 'password', username: 'owner', password: 'correct', clientIp: '203.0.113.8' })).toMatchObject({ status: 'locked' })
  })

  it('requires and consumes a one-use captcha after the configured failure threshold', async () => {
    const { center: auth } = await center({ maxAttempts: 6, captchaMode: 'after-failures' })
    const base = { provider: 'password', username: 'owner', clientIp: '203.0.113.4' }
    expect(await auth.login({ ...base, password: 'wrong' })).toEqual({ status: 'invalid', captchaRequired: true })
    expect(await auth.login({ ...base, password: 'correct' })).toEqual({ status: 'captcha-required' })
    const challenge = auth.createCaptcha()
    expect(await auth.login({ ...base, password: 'wrong', captchaId: challenge.id, captchaAnswer: challenge.answer })).toMatchObject({ status: 'invalid' })
    expect(await auth.login({ ...base, password: 'correct', captchaId: challenge.id, captchaAnswer: challenge.answer })).toEqual({ status: 'captcha-required' })
  })

  it('authorizes whitelist bypasses and revokes sessions when provider state changes', async () => {
    const { center: auth, setRevision } = await center()
    expect(await auth.bypasses('127.0.0.1')).toBe(true)
    expect(await auth.bypasses('203.0.113.4')).toBe(false)
    const result = await auth.login({ provider: 'password', username: 'owner', password: 'correct', clientIp: '203.0.113.4' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected session')
    expect(await auth.session(result.token)).toEqual({ username: 'owner', provider: 'password' })
    setRevision(2)
    expect(await auth.session(result.token)).toBeUndefined()
  })
})

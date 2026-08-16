import { randomBytes, randomInt } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AuthProvider, AuthPrincipal, CaptchaMode, LoginResult, PasswordChangeResult } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authCenter: AuthCenter
  }
}

/** Authentication-center configuration. */
export interface Config {
  /** Failed password attempts before a temporary lock. */
  maxAttempts: number
  /** Temporary lock duration in seconds. */
  lockSeconds: number
  /** Browser-session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Captcha policy for password attempts. */
  captchaMode: CaptchaMode
  /** Failures before after-failures mode requires a captcha. */
  captchaAfterFailures: number
}

interface FailureState {
  attempts: number
  lockedUntil: number
  touchedAt: number
}

interface SessionState {
  principal: AuthPrincipal
  providerRevision: number
  expiresAt: number
}

interface CaptchaState {
  answer: string
  expiresAt: number
}

/** Browser login request accepted by the center. */
export interface LoginRequest {
  provider: string
  username: string
  password: string
  clientIp: string
  captchaId?: string | undefined
  captchaAnswer?: string | undefined
}

/** One short-lived captcha challenge. */
export interface CaptchaChallenge {
  id: string
  answer: string
  expiresAt: number
}

const MAX_TRACKED_FAILURES = 10_000
const MAX_SESSIONS = 10_000
const CAPTCHA_TTL_MS = 2 * 60 * 1000

/** Registry and policy owner for independently mounted authentication providers. */
export class AuthCenter extends Service {
  static Config: z<Config> = z.object({
    maxAttempts: z.natural().min(1).max(100).default(6),
    lockSeconds: z.natural().min(1).max(3600).default(30),
    sessionTtlSeconds: z.natural().min(60).max(31_536_000).default(86_400),
    captchaMode: z.union([z.const('off'), z.const('always'), z.const('after-failures')]).default('off'),
    captchaAfterFailures: z.natural().min(1).max(99).default(3),
  })

  private readonly providers = new Map<string, AuthProvider>()
  private readonly failures = new Map<string, FailureState>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly captchas = new Map<string, CaptchaState>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'authCenter')
  }

  /** Register one independently removable authentication method. */
  register(provider: AuthProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`auth-center: duplicate provider ${JSON.stringify(provider.id)}`)
    this.providers.set(provider.id, provider)
    return () => { this.providers.delete(provider.id) }
  }

  /** Whether any mounted provider can currently authenticate. */
  async initialized(): Promise<boolean> {
    for (const provider of this.providers.values()) if (await provider.initialized()) return true
    return false
  }

  /** Whether any provider explicitly bypasses login for this client IP. */
  async bypasses(clientIp: string): Promise<boolean> {
    for (const provider of this.providers.values()) if (await provider.bypasses(clientIp)) return true
    return false
  }

  /** Create a one-use captcha. The answer is returned only for SVG rendering. */
  createCaptcha(): CaptchaChallenge {
    this.prune()
    const id = randomBytes(18).toString('base64url')
    const answer = Array.from({ length: 5 }, () => String(randomInt(0, 10))).join('')
    const expiresAt = Date.now() + CAPTCHA_TTL_MS
    this.captchas.set(id, { answer, expiresAt })
    return { id, answer, expiresAt }
  }

  /** Whether the configured policy currently requires a captcha for this attempt key. */
  captchaRequired(provider: string, clientIp: string, username: string, mode: CaptchaMode = this.config.captchaMode): boolean {
    if (mode === 'always') return true
    if (mode === 'off') return false
    const attempts = Math.max(
      this.failures.get(this.failureKey(provider, clientIp, username))?.attempts ?? 0,
      this.failures.get(this.ipFailureKey(provider, clientIp))?.attempts ?? 0,
    )
    return attempts >= this.config.captchaAfterFailures
  }

  /** Authenticate, rate-limit failures, and issue an opaque browser session. */
  async login(request: LoginRequest): Promise<LoginResult> {
    this.prune()
    const provider = this.providers.get(request.provider)
    if (provider === undefined || !await provider.initialized()) return { status: 'uninitialized' }
    const key = this.failureKey(request.provider, request.clientIp, request.username)
    const ipKey = this.ipFailureKey(request.provider, request.clientIp)
    const now = Date.now()
    let failure = this.failures.get(key)
    let ipFailure = this.failures.get(ipKey)
    if (failure !== undefined && failure.lockedUntil !== 0 && failure.lockedUntil <= now) {
      this.failures.delete(key)
      failure = undefined
    }
    if (ipFailure !== undefined && ipFailure.lockedUntil !== 0 && ipFailure.lockedUntil <= now) {
      this.failures.delete(ipKey)
      ipFailure = undefined
    }
    const lockedUntil = Math.max(failure?.lockedUntil ?? 0, ipFailure?.lockedUntil ?? 0)
    if (lockedUntil > now) {
      return { status: 'locked', retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) }
    }
    const captchaMode = await this.providerCaptchaMode(provider)
    const captchaRequired = this.captchaRequired(request.provider, request.clientIp, request.username, captchaMode)
    if (captchaRequired && !this.consumeCaptcha(request.captchaId, request.captchaAnswer)) return { status: 'captcha-required' }
    const principal = await provider.authenticate({ username: request.username, password: request.password })
    if (principal === undefined) {
      const attempts = (failure?.attempts ?? 0) + 1
      const ipAttempts = (ipFailure?.attempts ?? 0) + 1
      const nextLockedUntil = Math.max(attempts, ipAttempts) >= this.config.maxAttempts ? now + this.config.lockSeconds * 1000 : 0
      this.failures.delete(key)
      this.failures.set(key, { attempts, lockedUntil: nextLockedUntil, touchedAt: now })
      this.failures.delete(ipKey)
      this.failures.set(ipKey, { attempts: ipAttempts, lockedUntil: nextLockedUntil, touchedAt: now })
      this.enforceBound(this.failures, MAX_TRACKED_FAILURES)
      return {
        status: 'invalid',
        captchaRequired: captchaMode === 'always'
          || (captchaMode === 'after-failures' && attempts >= this.config.captchaAfterFailures),
      }
    }
    this.failures.delete(key)
    this.failures.delete(ipKey)
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, {
      principal,
      providerRevision: await provider.revision(),
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
    })
    this.enforceBound(this.sessions, MAX_SESSIONS)
    return { status: 'ok', token }
  }

  /** Resolve a valid session and revoke stale provider revisions. */
  async session(token: string | undefined): Promise<AuthPrincipal | undefined> {
    if (token === undefined) return undefined
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    const provider = this.providers.get(session.principal.provider)
    if (session.expiresAt <= Date.now() || provider === undefined || await provider.revision() !== session.providerRevision) {
      this.sessions.delete(token)
      return undefined
    }
    return session.principal
  }

  /** Revoke one browser session token. */
  logout(token: string | undefined): void {
    if (token !== undefined) this.sessions.delete(token)
  }

  /** Change a password through the provider that established the session. */
  async changePassword(principal: AuthPrincipal, currentPassword: string, newPassword: string): Promise<PasswordChangeResult> {
    const provider = this.providers.get(principal.provider)
    if (provider?.changePassword === undefined) return 'unsupported'
    return await provider.changePassword(principal, currentPassword, newPassword)
  }

  /** Resolve the whitelist owned by the authenticated or bypassing provider. */
  async ipWhitelist(principal: AuthPrincipal | undefined, clientIp: string): Promise<{ provider: string; rules: string[] } | undefined> {
    if (principal !== undefined) {
      const provider = this.providers.get(principal.provider)
      const rules = await provider?.getIpWhitelist?.(principal)
      return rules === undefined ? undefined : { provider: principal.provider, rules }
    }
    for (const provider of this.providers.values()) {
      if (provider.getIpWhitelist !== undefined && await provider.bypasses(clientIp)) {
        const rules = await provider.getIpWhitelist()
        if (rules !== undefined) return { provider: provider.id, rules }
      }
    }
    return undefined
  }

  /** Replace the whitelist through the provider that authorized this request. */
  async replaceIpWhitelist(principal: AuthPrincipal | undefined, clientIp: string, rules: string[]): Promise<{ provider: string; rules: string[] } | undefined> {
    if (principal !== undefined) {
      const provider = this.providers.get(principal.provider)
      const updated = await provider?.replaceIpWhitelist?.(rules, principal)
      return updated === undefined ? undefined : { provider: principal.provider, rules: updated }
    }
    for (const provider of this.providers.values()) {
      if (provider.replaceIpWhitelist !== undefined && await provider.bypasses(clientIp)) {
        const updated = await provider.replaceIpWhitelist(rules)
        if (updated !== undefined) return { provider: provider.id, rules: updated }
      }
    }
    return undefined
  }

  /** Return the effective captcha mode for a public login provider. */
  async captchaMode(providerId = 'password'): Promise<CaptchaMode> {
    const provider = this.providers.get(providerId)
    return provider === undefined ? this.config.captchaMode : await this.providerCaptchaMode(provider)
  }

  /** Resolve the captcha policy owned by the authenticated or bypassing provider. */
  async captchaPolicy(principal: AuthPrincipal | undefined, clientIp: string): Promise<{ provider: string; mode: CaptchaMode } | undefined> {
    if (principal !== undefined) {
      const provider = this.providers.get(principal.provider)
      if (provider === undefined) return undefined
      return { provider: provider.id, mode: await this.providerCaptchaMode(provider, principal) }
    }
    for (const provider of this.providers.values()) {
      if (provider.replaceCaptchaMode !== undefined && await provider.bypasses(clientIp)) {
        return { provider: provider.id, mode: await this.providerCaptchaMode(provider) }
      }
    }
    return undefined
  }

  /** Persist a captcha policy through the provider that authorized this request. */
  async replaceCaptchaMode(principal: AuthPrincipal | undefined, clientIp: string, mode: CaptchaMode): Promise<{ provider: string; mode: CaptchaMode } | undefined> {
    if (principal !== undefined) {
      const provider = this.providers.get(principal.provider)
      const updated = await provider?.replaceCaptchaMode?.(mode, principal)
      return updated === undefined ? undefined : { provider: principal.provider, mode: updated }
    }
    for (const provider of this.providers.values()) {
      if (provider.replaceCaptchaMode !== undefined && await provider.bypasses(clientIp)) {
        const updated = await provider.replaceCaptchaMode(mode)
        if (updated !== undefined) return { provider: provider.id, mode: updated }
      }
    }
    return undefined
  }

  private async providerCaptchaMode(provider: AuthProvider, principal?: AuthPrincipal): Promise<CaptchaMode> {
    return await provider.getCaptchaMode?.(principal) ?? this.config.captchaMode
  }

  private consumeCaptcha(id: string | undefined, answer: string | undefined): boolean {
    if (id === undefined || answer === undefined) return false
    const challenge = this.captchas.get(id)
    this.captchas.delete(id)
    return challenge !== undefined && challenge.expiresAt > Date.now() && challenge.answer === answer.trim()
  }

  private failureKey(provider: string, clientIp: string, username: string): string {
    return `${provider}\u0000${clientIp}\u0000${username.toLocaleLowerCase()}`
  }

  private ipFailureKey(provider: string, clientIp: string): string {
    return `${provider}\u0000${clientIp}\u0000*`
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, state] of this.failures) {
      if (state.lockedUntil <= now && state.touchedAt + 24 * 60 * 60 * 1000 <= now) this.failures.delete(key)
    }
    for (const [key, state] of this.sessions) if (state.expiresAt <= now) this.sessions.delete(key)
    for (const [key, state] of this.captchas) if (state.expiresAt <= now) this.captchas.delete(key)
  }

  private enforceBound<T>(map: Map<string, T>, limit: number): void {
    while (map.size > limit) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }
}

export default AuthCenter

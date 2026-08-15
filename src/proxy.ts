/**
 * Public authenticated reverse proxy for the DeepSeek Harness Web profile.
 * The upstream Harness carrier remains loopback-only; every public HTTP, SSE,
 * and WebSocket request crosses this plugin before reaching it.
 */
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './center.js'
import { captchaSvg, loginPage } from './html.js'
import { normalizeIpRule, resolveClientIp } from './network.js'

/** Stable Cordis plugin name. */
export const name = 'auth-proxy'
/** Services that must exist before the public listener opens. */
export const inject = ['webServer', 'authCenter']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Bound public authentication proxy. */
    authProxy?: { host: string; port: number; publicBaseUrl?: string }
  }
}

/** Authenticated public-proxy configuration. */
export interface Config {
  /** Public bind address. */
  host: string
  /** Public bind port. */
  port: number
  /** Optional externally visible HTTP(S) URL used in readiness output. */
  publicBaseUrl?: string | undefined
  /** Add Secure to the session cookie; HTTPS is supported but not required. */
  secureCookie: boolean
  /** Proxy peer IPs/CIDRs whose forwarded client address is accepted. */
  trustedProxies: string[]
}

export const Config = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.natural().max(65535).default(3080),
  publicBaseUrl: z.string(),
  secureCookie: z.boolean().default(false),
  trustedProxies: z.array(String).default([]),
})

const SESSION_COOKIE = 'dsh_auth_session'
const CAPTCHA_COOKIE = 'dsh_auth_captcha'
const MAX_LOGIN_BODY_BYTES = 16 * 1024

function cookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>()
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    result.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()))
  }
  return result
}

function cookie(name: string, value: string, options: { maxAge?: number; secure: boolean; httpOnly?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict']
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`)
  return parts.join('; ')
}

function stripPrivateCookies(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const kept = value.split(';').map(part => part.trim()).filter((part) => {
    const key = part.slice(0, Math.max(0, part.indexOf('=')))
    return key !== SESSION_COOKIE && key !== CAPTCHA_COOKIE
  })
  return kept.length === 0 ? undefined : kept.join('; ')
}

function clientIp(req: IncomingMessage, trustedProxies: readonly string[]): string {
  const forwarded = req.headers['x-forwarded-for']
  return resolveClientIp(
    req.socket.remoteAddress ?? '127.0.0.1',
    Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
    trustedProxies,
  )
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_LOGIN_BODY_BYTES) throw new Error('login body exceeds 16 KiB')
    chunks.push(value)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function writeHtml(res: ServerResponse, status: number, body: string, headers?: Record<string, string | string[]>): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

function redirect(res: ServerResponse, location: string, headers?: Record<string, string | string[]>): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers })
  res.end()
}

function upstreamHeaders(req: IncomingMessage, upstreamAuthority: string, sourceIp: string, upgrade: boolean): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...req.headers, host: upstreamAuthority }
  const remainingCookies = stripPrivateCookies(req.headers.cookie)
  if (remainingCookies === undefined) delete headers.cookie
  else headers.cookie = remainingCookies
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-host']
  delete headers['x-forwarded-proto']
  if (!upgrade) {
    delete headers.connection
    delete headers.upgrade
    delete headers['keep-alive']
    delete headers['proxy-connection']
  }
  headers['x-forwarded-for'] = sourceIp
  if (headers.origin !== undefined) headers.origin = `http://${upstreamAuthority}`
  return headers
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number, sourceIp: string): void {
  const authority = `127.0.0.1:${String(port)}`
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, authority, sourceIp, false),
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('bad gateway')
  })
  req.pipe(upstream)
}

function rejectUpgrade(socket: Duplex, status = 401, message = 'Unauthorized'): void {
  socket.end(`HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, sourceIp: string, ownedSockets: Set<Duplex>): void {
  const authority = `127.0.0.1:${String(port)}`
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, authority, sourceIp, true),
  })
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    ownedSockets.add(upstreamSocket)
    upstreamSocket.once('close', () => ownedSockets.delete(upstreamSocket))
    const lines = [`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}`]
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index] ?? ''}: ${response.rawHeaders[index + 1] ?? ''}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstreamSocket.write(head)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => socket.destroy())
    socket.once('close', () => upstreamSocket.destroy())
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
  })
  upstream.on('response', response => {
    response.resume()
    rejectUpgrade(socket, response.statusCode ?? 502, response.statusMessage ?? 'Bad Gateway')
  })
  upstream.on('error', () => rejectUpgrade(socket, 502, 'Bad Gateway'))
  upstream.end()
}

/** Mount the authenticated public listener in front of the loopback Harness carrier. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('auth-proxy: the upstream Harness webserver must bind 127.0.0.1; a public upstream would bypass authentication')
  }
  const trustedProxies = config.trustedProxies.map(normalizeIpRule)
  let publicBaseUrl: string | undefined
  if (config.publicBaseUrl !== undefined && config.publicBaseUrl !== '') {
    const parsed = new URL(config.publicBaseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('auth-proxy: publicBaseUrl must use http or https')
    publicBaseUrl = parsed.href.replace(/\/$/, '')
  }
  const server = createServer((req, res) => {
    void (async () => {
      const sourceIp = clientIp(req, trustedProxies)
      const url = new URL(req.url ?? '/', 'http://auth.local')
      const requestCookies = cookies(req)
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        const initialized = await ctx.authCenter.initialized()
        const captcha = ctx.authCenter.config.captchaMode === 'always' || url.searchParams.has('captcha')
        writeHtml(res, 200, loginPage({
          initialized,
          captcha,
          ...(url.searchParams.has('error') && { error: 'Invalid username, password, or verification code.' }),
          ...(url.searchParams.has('locked') && { error: 'Too many attempts. Try again later.' }),
        }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/captcha') {
        const challenge = ctx.authCenter.createCaptcha()
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; sandbox",
          'x-content-type-options': 'nosniff',
          'set-cookie': cookie(CAPTCHA_COOKIE, challenge.id, { secure: config.secureCookie, maxAge: 120 }),
        })
        res.end(captchaSvg(challenge.answer))
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const form = await readForm(req)
        const captchaId = requestCookies.get(CAPTCHA_COOKIE)
        const captchaAnswer = form.get('captcha')
        const result = await ctx.authCenter.login({
          provider: form.get('provider') ?? 'password',
          username: form.get('username') ?? '',
          password: form.get('password') ?? '',
          clientIp: sourceIp,
          ...(captchaId !== undefined && { captchaId }),
          ...(captchaAnswer !== null && { captchaAnswer }),
        })
        if (result.status === 'ok') {
          redirect(res, '/', {
            'set-cookie': [
              cookie(SESSION_COOKIE, result.token, { secure: config.secureCookie, maxAge: ctx.authCenter.config.sessionTtlSeconds }),
              cookie(CAPTCHA_COOKIE, '', { secure: config.secureCookie, maxAge: 0 }),
            ],
          })
          return
        }
        if (result.status === 'locked') {
          redirect(res, `/auth/login?locked=1&captcha=1`, { 'retry-after': String(result.retryAfterSeconds) })
          return
        }
        redirect(res, `/auth/login?error=1${result.status === 'captcha-required' || (result.status === 'invalid' && result.captchaRequired) ? '&captcha=1' : ''}`)
        return
      }
      const sessionToken = requestCookies.get(SESSION_COOKIE)
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        ctx.authCenter.logout(sessionToken)
        redirect(res, '/auth/login', { 'set-cookie': cookie(SESSION_COOKIE, '', { secure: config.secureCookie, maxAge: 0 }) })
        return
      }
      if (!await ctx.authCenter.bypasses(sourceIp) && await ctx.authCenter.session(sessionToken) === undefined) {
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) redirect(res, '/auth/login')
        else {
          res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end('{"error":"authentication required"}')
        }
        return
      }
      proxyHttp(req, res, ctx.webServer.port, sourceIp)
    })().catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      if (!res.headersSent) res.writeHead(400)
      res.end('bad request')
    })
  })

  const upgradedSockets = new Set<Duplex>()

  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    void (async () => {
      const sourceIp = clientIp(req, trustedProxies)
      const token = cookies(req).get(SESSION_COOKIE)
      if (!await ctx.authCenter.bypasses(sourceIp) && await ctx.authCenter.session(token) === undefined) {
        rejectUpgrade(socket)
        return
      }
      proxyUpgrade(req, socket, head, ctx.webServer.port, sourceIp, upgradedSockets)
    })().catch(() => rejectUpgrade(socket, 400, 'Bad Request'))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  ctx.provide('authProxy', { host: config.host, port, ...(publicBaseUrl !== undefined && { publicBaseUrl }) })
  console.log(`dsh auth: ${publicBaseUrl ?? `http://127.0.0.1:${String(port)}`}`)
  ctx.effect(() => async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()))
    server.closeAllConnections()
    for (const socket of upgradedSockets) socket.destroy()
    await closed
  }, 'auth-proxy: public listener')
}

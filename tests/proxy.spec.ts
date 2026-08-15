import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthCenter from '../src/center.js'
import * as Password from '../src/password.js'
import * as Proxy from '../src/proxy.js'
import { AuthStateStore } from '../src/state.js'

const contexts: Context[] = []
const roots: string[] = []
const upstreams: ReturnType<typeof createServer>[] = []
const upstreamSockets = new Set<Duplex>()

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const socket of upstreamSockets) socket.destroy()
  upstreamSockets.clear()
  await Promise.all(upstreams.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function fixture(): Promise<{ base: string; store: AuthStateStore; upstream: { host?: string; origin?: string; path?: string } }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-proxy-'))
  roots.push(root)
  const store = new AuthStateStore(join(root, 'auth'))
  await store.reset('owner', 'Correct-Horse-42!')
  const observed: { host?: string; origin?: string; path?: string } = {}
  const upstream = createServer((req, res) => {
    observed.host = req.headers.host
    observed.origin = req.headers.origin
    observed.path = req.url
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })
  upstream.on('upgrade', (req, socket) => {
    upstreamSockets.add(socket)
    socket.once('close', () => upstreamSockets.delete(socket))
    observed.host = req.headers.host
    observed.origin = req.headers.origin
    observed.path = req.url
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', data => socket.write(data))
  })
  upstreams.push(upstream)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (typeof address !== 'object' || address === null) throw new Error('upstream did not bind')

  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('webServer', { host: '127.0.0.1', port: address.port } as never)
  await ctx.plugin(AuthCenter, {
    maxAttempts: 6,
    lockSeconds: 30,
    sessionTtlSeconds: 3600,
    captchaMode: 'off',
    captchaAfterFailures: 3,
  })
  await ctx.plugin(Password, { stateDir: store.directory })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await ctx.plugin(Proxy, { host: '127.0.0.1', port: 0, secureCookie: false, trustedProxies: [] })
  if (ctx.authProxy === undefined) throw new Error('proxy did not bind')
  return { base: `http://127.0.0.1:${String(ctx.authProxy.port)}`, store, upstream: observed }
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = /dsh_auth_session=([^;]+)/.exec(header)
  if (match?.[1] === undefined) throw new Error('session cookie missing')
  return `dsh_auth_session=${match[1]}`
}

async function upgrade(base: string, session?: string): Promise<{ socket: ReturnType<typeof connect>; response: string }> {
  const port = Number(new URL(base).port)
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write([
    'GET /api/events.mux HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Origin: http://public.example',
    'Connection: Upgrade',
    'Upgrade: websocket',
    ...(session === undefined ? [] : [`Cookie: ${session}`]),
    '',
    '',
  ].join('\r\n'))
  const [data] = await once(socket, 'data') as [Buffer]
  return { socket, response: data.toString() }
}

describe('authenticated proxy composition', () => {
  it('denies every upstream path until login, then streams it with loopback authority', async () => {
    const target = await fixture()
    const denied = await fetch(`${target.base}/api/session.list`, { headers: { accept: 'application/json' }, redirect: 'manual' })
    expect(denied.status).toBe(401)
    expect(target.upstream.path).toBeUndefined()
    const page = await fetch(`${target.base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(page.status).toBe(303)
    expect(page.headers.get('location')).toBe('/auth/login')
    const loginPage = await fetch(`${target.base}/auth/login`)
    expect(loginPage.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await loginPage.text()).toContain('DeepSeek Harness')

    const login = await fetch(`${target.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!', provider: 'password' }),
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
    const authorized = await fetch(`${target.base}/api/session.list`, { headers: { cookie: sessionCookie(login), origin: 'http://public.example' } })
    expect(await authorized.text()).toBe('upstream-ok')
    expect(target.upstream.path).toBe('/api/session.list')
    expect(target.upstream.host).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(target.upstream.origin).toBe(`http://${target.upstream.host ?? ''}`)
  })

  it('applies whitelist changes live and rejects unauthenticated upgrade handshakes', async () => {
    const target = await fixture()
    await target.store.updateWhitelist(rules => [...rules, '127.0.0.1'])
    expect(await (await fetch(`${target.base}/plugins/demo/client.js`)).text()).toBe('upstream-ok')

    await target.store.updateWhitelist(() => [])
    const denied = await upgrade(target.base)
    expect(denied.response).toContain('401 Unauthorized')
    denied.socket.destroy()

    const login = await fetch(`${target.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!', provider: 'password' }),
      redirect: 'manual',
    })
    const authorized = await upgrade(target.base, sessionCookie(login))
    expect(authorized.response).toContain('101 Switching Protocols')
    expect(target.upstream.origin).toBe(`http://${target.upstream.host ?? ''}`)
    authorized.socket.destroy()
  })

  it('refuses a publicly reachable Harness upstream because that would bypass auth', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { host: '0.0.0.0', port: 3080 } as never)
    await ctx.plugin(AuthCenter, { maxAttempts: 6, lockSeconds: 30, sessionTtlSeconds: 60, captchaMode: 'off', captchaAfterFailures: 3 })
    await expect(ctx.plugin(Proxy, { host: '127.0.0.1', port: 0, secureCookie: false, trustedProxies: [] })).rejects.toThrow('must bind 127.0.0.1')
  })
})

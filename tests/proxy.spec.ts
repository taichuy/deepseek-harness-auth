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
    if (req.url === '/api/reset') {
      req.socket.destroy()
      return
    }
    if (req.url === '/api/pluginInventory/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ plugins: 'x'.repeat(18 * 1024) }))
      return
    }
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
    expect(loginPage.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(loginPage.headers.get('content-security-policy')).toContain("img-src 'self' data:")
    expect(await loginPage.text()).toContain('DeepSeek Harness')
    const themeScript = await fetch(`${target.base}/auth/login-theme.js`)
    expect(themeScript.status).toBe(200)
    expect(themeScript.headers.get('content-type')).toContain('text/javascript')
    expect(await themeScript.text()).toContain('dsh-auth-theme-v1')

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

  it('exposes account details only after authorization and changes passwords only for a real session', async () => {
    const target = await fixture()
    expect((await fetch(`${target.base}/auth/account`)).status).toBe(401)

    await target.store.updateWhitelist(rules => [...rules, '127.0.0.1'])
    const bypassAccount = await fetch(`${target.base}/auth/account`)
    expect(await bypassAccount.json()).toEqual({
      mode: 'whitelist', clientIp: '127.0.0.1', whitelistProvider: 'password', whitelist: ['127.0.0.1'],
      captchaMode: 'off', captchaAfterFailures: 3,
    })
    const bypassChange = await fetch(`${target.base}/auth/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ currentPassword: 'Correct-Horse-42!', newPassword: 'new' }),
    })
    expect(bypassChange.status).toBe(403)
    await target.store.updateWhitelist(() => [])

    const login = await fetch(`${target.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!', provider: 'password' }),
      redirect: 'manual',
    })
    const session = sessionCookie(login)
    expect(await (await fetch(`${target.base}/auth/account`, { headers: { cookie: session } })).json()).toEqual({
      mode: 'session', provider: 'password', username: 'owner', clientIp: '127.0.0.1', whitelistProvider: 'password', whitelist: [],
      captchaMode: 'off', captchaAfterFailures: 3,
    })
    const rejected = await fetch(`${target.base}/auth/account/password`, {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new' }),
    })
    expect(rejected.status).toBe(403)

    const changed = await fetch(`${target.base}/auth/account/password`, {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ currentPassword: 'Correct-Horse-42!', newPassword: 'new' }),
    })
    expect(changed.status).toBe(204)
    expect(changed.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(`${target.base}/auth/account`, { headers: { cookie: session } })).status).toBe(401)

    const oldLogin = await fetch(`${target.base}/auth/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!' }), redirect: 'manual',
    })
    expect(oldLogin.headers.get('location')).toContain('error=1')
    const newLogin = await fetch(`${target.base}/auth/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'owner', password: 'new' }), redirect: 'manual',
    })
    expect(newLogin.headers.get('set-cookie')).toContain('dsh_auth_session=')
  })

  it('lets account sessions and already-whitelisted visitors replace the IP whitelist', async () => {
    const target = await fixture()
    await target.store.updateWhitelist(() => ['localhost'])

    const missingHeader = await fetch(`${target.base}/auth/account/whitelist`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: ['127.0.0.1'] }),
    })
    expect(missingHeader.status).toBe(403)

    const bypassUpdate = await fetch(`${target.base}/auth/account/whitelist`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ rules: ['192.168.1.0/24'] }),
    })
    expect(bypassUpdate.status).toBe(200)
    expect(await bypassUpdate.json()).toEqual({ whitelistProvider: 'password', whitelist: ['192.168.1.0/24'] })
    expect((await fetch(`${target.base}/auth/account`)).status).toBe(401)

    const login = await fetch(`${target.base}/auth/login`, {
      method: 'POST', body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!' }), redirect: 'manual',
    })
    const session = sessionCookie(login)
    const sessionUpdate = await fetch(`${target.base}/auth/account/whitelist`, {
      method: 'PUT',
      headers: { cookie: session, 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ rules: ['localhost', '10.0.0.0/24', '10.0.0.0/24'] }),
    })
    expect(sessionUpdate.status).toBe(200)
    expect(sessionUpdate.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await sessionUpdate.json()).toEqual({ whitelistProvider: 'password', whitelist: ['127.0.0.0/8', '10.0.0.0/24'] })
    expect((await target.store.read())?.whitelist).toEqual(['127.0.0.0/8', '10.0.0.0/24'])
  })

  it('persists Web captcha settings for account sessions and whitelisted visitors', async () => {
    const target = await fixture()
    await target.store.updateWhitelist(() => ['localhost'])

    const missingHeader = await fetch(`${target.base}/auth/account/captcha`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'always' }),
    })
    expect(missingHeader.status).toBe(403)
    const invalid = await fetch(`${target.base}/auth/account/captcha`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ mode: 'sometimes' }),
    })
    expect(invalid.status).toBe(422)

    const enabled = await fetch(`${target.base}/auth/account/captcha`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ mode: 'always' }),
    })
    expect(await enabled.json()).toEqual({ captchaProvider: 'password', captchaMode: 'always', captchaAfterFailures: 3 })
    expect((await target.store.read())?.captchaMode).toBe('always')
    expect(await (await fetch(`${target.base}/auth/login`)).text()).toContain('name="captcha"')

    const afterFailures = await fetch(`${target.base}/auth/account/captcha`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-dsh-auth-request': '1' },
      body: JSON.stringify({ mode: 'after-failures' }),
    })
    expect(afterFailures.status).toBe(200)
    expect((await target.store.read())?.captchaMode).toBe('after-failures')
    expect(await (await fetch(`${target.base}/auth/account`)).json()).toMatchObject({ captchaMode: 'after-failures', captchaAfterFailures: 3 })
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

  it('survives upstream resets, early client disconnects, and large plugin inventory responses', async () => {
    const target = await fixture()
    const login = await fetch(`${target.base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'owner', password: 'Correct-Horse-42!', provider: 'password' }),
      redirect: 'manual',
    })
    const session = sessionCookie(login)

    const reset = await fetch(`${target.base}/api/reset`, { headers: { cookie: session } })
    expect(reset.status).toBe(502)
    expect(await reset.text()).toBe('bad gateway')

    const inventory = await fetch(`${target.base}/api/pluginInventory/list`, {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'pluginInventory/list', payload: { args: {} } }),
    })
    const inventoryBody = await inventory.json() as { plugins: string }
    expect(inventoryBody.plugins).toHaveLength(18 * 1024)

    const port = Number(new URL(target.base).port)
    const abandonedHttp = connect(port, '127.0.0.1')
    await once(abandonedHttp, 'connect')
    abandonedHttp.write('POST /api/pluginInventory/list HTTP/1.1\r\nContent-Length: 9999\r\n\r\npartial')
    abandonedHttp.destroy()

    const abandonedUpgrade = connect(port, '127.0.0.1')
    await once(abandonedUpgrade, 'connect')
    abandonedUpgrade.write('GET /api/events.mux HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    abandonedUpgrade.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))

    const healthy = await fetch(`${target.base}/auth/login`)
    expect(healthy.status).toBe(200)
  })

  it('refuses a publicly reachable Harness upstream because that would bypass auth', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('webServer', { host: '0.0.0.0', port: 3080 } as never)
    await ctx.plugin(AuthCenter, { maxAttempts: 6, lockSeconds: 30, sessionTtlSeconds: 60, captchaMode: 'off', captchaAfterFailures: 3 })
    await expect(ctx.plugin(Proxy, { host: '127.0.0.1', port: 0, secureCookie: false, trustedProxies: [] })).rejects.toThrow('must bind 127.0.0.1')
  })
})

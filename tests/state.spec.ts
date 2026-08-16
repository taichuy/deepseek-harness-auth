import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStateStore, validatePassword, validateStrongPassword, verifyPassword } from '../src/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<AuthStateStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-state-'))
  roots.push(root)
  return new AuthStateStore(join(root, 'auth'))
}

describe('auth state', () => {
  it('has no generated default and atomically stores a verifiable owner-only password record', async () => {
    const target = await store()
    expect(await target.read()).toBeUndefined()
    const state = await target.reset('owner', 'Correct-Horse-42!')
    expect(state.revision).toBe(1)
    expect(state.password.hash).not.toContain('Correct-Horse-42!')
    expect(await verifyPassword(state, 'Correct-Horse-42!')).toBe(true)
    expect(await verifyPassword(state, 'wrong-password')).toBe(false)
    expect((await stat(target.file)).mode & 0o777).toBe(0o600)
  })

  it('preserves whitelist on password reset and increments revision for every authority change', async () => {
    const target = await store()
    await target.reset('owner', 'Correct-Horse-42!')
    const whitelisted = await target.updateWhitelist(rules => [...rules, 'localhost', '10.0.0.0/24'])
    expect(whitelisted.whitelist).toEqual(['127.0.0.0/8', '10.0.0.0/24'])
    const reset = await target.reset('owner2', 'Another-Strong-43!')
    expect(reset.whitelist).toEqual(whitelisted.whitelist)
    expect(reset.revision).toBe(3)
    expect((await target.revoke()).revision).toBe(4)
  })

  it('accepts owner-chosen passwords without strength restrictions', async () => {
    expect(() => validatePassword('1')).not.toThrow()
    expect(() => validatePassword('owner')).not.toThrow()
    expect(() => validatePassword('alllowercaseletters')).not.toThrow()
    expect(() => validatePassword('')).toThrow('must not be empty')
    expect(() => validateStrongPassword('1', 'owner')).not.toThrow()

    const target = await store()
    const state = await target.reset('owner', '1')
    expect(await verifyPassword(state, '1')).toBe(true)
  })
})

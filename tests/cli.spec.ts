import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isDirectExecution, program } from '../src/cli.js'
import { AuthStateStore } from '../src/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('owner CLI', () => {
  it('exposes interactive, status, reset, whitelist, and revocation operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-auth-cli-'))
    roots.push(root)
    const command = program(new AuthStateStore(root))
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(command.version()).toBe(manifest.version)
    expect(command.commands.map(child => child.name())).toEqual(['status', 'init', 'whitelist', 'revoke'])
    expect(command.commands.find(child => child.name() === 'whitelist')?.commands.map(child => child.name()))
      .toEqual(['list', 'add', 'remove', 'clear'])
  })

  it('recognizes npm bin symlinks as direct execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-auth-bin-'))
    roots.push(root)
    const target = new URL('../package.json', import.meta.url)
    const link = join(root, 'dsh-auth')
    await symlink(target, link)
    expect(isDirectExecution(target.href, link)).toBe(true)
    expect(isDirectExecution(target.href, join(root, 'missing'))).toBe(false)
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('installable dsh bundle', () => {
  it('publishes a patch layer and keeps the Harness carrier loopback-only', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      dsh?: { bundle?: { patch?: string } }
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }
    expect(manifest.name).toBe('deepseek-harness-auth')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.bin?.['dsh-auth']).toBe('lib/cli.js')
    expect(manifest.exports).toHaveProperty('./center')
    expect(manifest.exports).toHaveProperty('./password')

    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0')
    expect(patch).toContain('name: deepseek-harness-auth/center')
    expect(patch).toContain('name: deepseek-harness-auth/password')
    expect(patch).toContain('name: deepseek-harness-auth\n')
  })
})

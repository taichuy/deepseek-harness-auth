import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('installable dsh bundle', () => {
  it('publishes a patch layer and keeps the Harness carrier loopback-only', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string
      version: string
      dsh?: { bundle?: { patch?: string }; client?: { inject?: string[]; platform?: string } }
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }
    expect(manifest.name).toBe('deepseek-harness-auth')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(manifest.bin?.['dsh-auth']).toBe('lib/cli.js')
    expect(manifest.exports).toHaveProperty('./center')
    expect(manifest.exports).toHaveProperty('./password')
    expect(manifest.exports).toHaveProperty('./client')
    await expect(access(new URL('../lib/client.js', import.meta.url))).resolves.toBeUndefined()

    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('- id: directory-picker\n  disabled: true')
    expect(patch).toContain("name: '@deepseek-ai/dsh-host-directory-picker-browse'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")
    expect(patch).toContain('- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0')
    expect(patch).toContain('name: deepseek-harness-auth/center')
    expect(patch).toContain('name: deepseek-harness-auth/password')
    expect(patch).toContain('name: deepseek-harness-auth\n')

    const clientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(clientSource).toContain('.dsh-auth-section,.dsh-auth-section *{box-sizing:border-box}')
    expect(clientSource).toContain('/auth/account/whitelist')
    expect(clientSource).toContain('保存白名单')
  })
})

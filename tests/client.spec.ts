import { describe, expect, it } from 'vitest'
import { welcomeNoticeFingerprint } from '../src/client/onboarding.js'
import { collectThemeVariables } from '../src/client/theme.js'

function style(values: Record<string, string>) {
  const names = Object.keys(values)
  return {
    length: names.length,
    item: (index: number) => names[index] ?? '',
    getPropertyValue: (name: string) => values[name] ?? '',
  }
}

describe('authenticated browser helpers', () => {
  it('lets body-scoped skin tokens override root theme tokens', () => {
    expect(collectThemeVariables(
      style({ '--dsw-alias-bg-base': '#fff', '--unrelated': 'ignored' }),
      style({ '--dsw-alias-bg-base': '#1238', '--dsw-alias-label-primary': '#eef' }),
    )).toEqual({
      '--dsw-alias-bg-base': '#1238',
      '--dsw-alias-label-primary': '#eef',
    })
  })

  it('fingerprints only the Harness internal-testing notice copy', () => {
    const zh = '内测声明 DeepSeek Harness 目前仍处在测试阶段。欢迎全球 Harness 开发者加入 DSH 插件生态。继续'
    const en = 'Internal Testing Notice DeepSeek Harness remains in testing. Join the DSH plugin ecosystem. Continue'
    expect(welcomeNoticeFingerprint(zh)).toBe(zh)
    expect(welcomeNoticeFingerprint(en)).toBe(en)
    expect(welcomeNoticeFingerprint('DeepSeek Harness Settings Continue')).toBeUndefined()
  })
})

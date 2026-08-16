import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { watchTheme } from './theme.js'
import { watchWelcomeNotice } from './onboarding.js'

export const inject = ['slots']

type Account =
  | { mode: 'session'; provider: string; username: string; clientIp: string; whitelistProvider?: string; whitelist: string[] }
  | { mode: 'whitelist'; clientIp: string; whitelistProvider?: string; whitelist: string[] }

const STYLE = `
.dsh-auth-logout{appearance:none;width:100%;display:flex;align-items:center;gap:10px;padding:9px 14px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}.dsh-auth-logout:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-auth-logout:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.dsh-auth-logout svg{width:20px;height:20px;flex:none}.dsh-auth-logout[data-wide=false]{justify-content:center;padding-inline:0}.dsh-auth-section,.dsh-auth-section *{box-sizing:border-box}.dsh-auth-section{max-width:680px;color:var(--dsw-alias-label-primary)}.dsh-auth-section h2{margin:0 0 8px;font-size:20px}.dsh-auth-section .hint{margin:0 0 22px;color:var(--dsw-alias-label-secondary);line-height:1.55}.dsh-auth-account{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 18px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);margin-bottom:20px}.dsh-auth-account dt{color:var(--dsw-alias-label-secondary)}.dsh-auth-account dd{margin:0;word-break:break-word}.dsh-auth-stack{display:flex;flex-direction:column;gap:20px}.dsh-auth-form{display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}.dsh-auth-form h3{margin:0 0 2px;font-size:16px}.dsh-auth-field{display:flex;flex-direction:column;gap:6px}.dsh-auth-field span{font-size:13px;color:var(--dsw-alias-label-secondary)}.dsh-auth-field input,.dsh-auth-field textarea{width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}.dsh-auth-field textarea{min-height:108px;resize:vertical;line-height:1.5}.dsh-auth-field input:focus,.dsh-auth-field textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.dsh-auth-submit{align-self:flex-start;padding:8px 16px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary);color:white;font:inherit;font-weight:600;cursor:pointer}.dsh-auth-submit:disabled{opacity:.5;cursor:default}.dsh-auth-message{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}.dsh-auth-message[data-error=true]{color:var(--dsw-alias-state-error-primary)}
`

function isChinese(): boolean {
  return navigator.language.toLowerCase().startsWith('zh')
}

function LogoutEntry({ wide }: { wide: boolean }) {
  const [busy, setBusy] = useState(false)
  const zh = isChinese()
  const logout = async (): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/auth/logout', { method: 'POST', headers: { 'X-DSH-Auth-Request': '1' } })
    } finally {
      window.location.assign('/auth/login')
    }
  }
  const label = busy ? (zh ? '正在退出…' : 'Signing out…') : (zh ? '退出登录' : 'Sign out')
  return <button className="dsh-auth-logout" data-wide={String(wide)} type="button" onClick={() => { void logout() }} disabled={busy} aria-label={label} title={wide ? undefined : label}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9" /></svg>
    {wide ? <span>{label}</span> : null}
  </button>
}

function AccountSection() {
  const zh = isChinese()
  const [account, setAccount] = useState<Account | undefined>()
  const [loadError, setLoadError] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | undefined>()
  const [whitelistText, setWhitelistText] = useState('')
  const [whitelistBusy, setWhitelistBusy] = useState(false)
  const [whitelistMessage, setWhitelistMessage] = useState<{ text: string; error: boolean } | undefined>()

  useEffect(() => {
    void fetch('/auth/account').then(async response => {
      if (!response.ok) throw new Error('account unavailable')
      const loaded = await response.json() as Account
      setAccount(loaded)
      setWhitelistText(loaded.whitelist.join('\n'))
    }).catch(() => setLoadError(true))
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (newPassword.length === 0) {
      setMessage({ text: zh ? '新密码不能为空。' : 'The new password cannot be empty.', error: true })
      return
    }
    if (newPassword !== confirmation) {
      setMessage({ text: zh ? '两次输入的新密码不一致。' : 'The new passwords do not match.', error: true })
      return
    }
    setBusy(true)
    setMessage(undefined)
    try {
      const response = await fetch('/auth/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Auth-Request': '1' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${String(response.status)}`)
      }
      setMessage({ text: zh ? '密码已修改，需要重新登录。' : 'Password changed. Sign in again.', error: false })
      window.setTimeout(() => window.location.assign('/auth/login'), 900)
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
      setBusy(false)
    }
  }

  const saveWhitelist = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const rules = whitelistText.split(/[\n,]+/).map(rule => rule.trim()).filter(Boolean)
    setWhitelistBusy(true)
    setWhitelistMessage(undefined)
    try {
      const response = await fetch('/auth/account/whitelist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Auth-Request': '1' },
        body: JSON.stringify({ rules }),
      })
      const body = await response.json().catch(() => ({})) as { error?: string; whitelist?: string[] }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
      setWhitelistText((body.whitelist ?? rules).join('\n'))
      setWhitelistMessage({ text: zh ? '白名单已保存，现有账号会话已撤销，正在重新验证访问权限…' : 'Whitelist saved. Existing account sessions were revoked; checking access again…', error: false })
      window.setTimeout(() => window.location.assign('/'), 1100)
    } catch (error) {
      setWhitelistMessage({ text: error instanceof Error ? error.message : String(error), error: true })
      setWhitelistBusy(false)
    }
  }

  return <section className="dsh-auth-section">
    <h2>{zh ? '账号与安全' : 'Account & Security'}</h2>
    <p className="hint">{zh ? '查看当前认证身份，并修改内置账号的登录密码。修改成功后所有现有会话都会失效。' : 'Review the active identity and change the built-in account password. A successful change revokes all sessions.'}</p>
    {loadError ? <p className="dsh-auth-message" data-error="true">{zh ? '无法读取账号信息。' : 'Could not load account details.'}</p> : account === undefined ? <p className="dsh-auth-message">{zh ? '正在加载…' : 'Loading…'}</p> : <>
      <dl className="dsh-auth-account">
        <dt>{zh ? '访问方式' : 'Access mode'}</dt><dd>{account.mode === 'session' ? (zh ? '账号会话' : 'Account session') : (zh ? 'IP 白名单' : 'IP whitelist')}</dd>
        <dt>{zh ? '当前 IP' : 'Current IP'}</dt><dd>{account.clientIp}</dd>
        {account.mode === 'session' ? <><dt>{zh ? '账号' : 'Username'}</dt><dd>{account.username}</dd><dt>{zh ? '认证方式' : 'Provider'}</dt><dd>{account.provider}</dd></> : null}
      </dl>
      <div className="dsh-auth-stack">
      <form className="dsh-auth-form" onSubmit={event => { void saveWhitelist(event) }}>
        <h3>{zh ? 'IP 白名单' : 'IP whitelist'}</h3>
        <p className="dsh-auth-message">{zh ? '每行填写一个 IP 或 CIDR；也可填写 localhost。留空保存会要求所有地址登录。命中白名单的访问者也有权修改本列表。' : 'Enter one IP or CIDR per line; localhost is also accepted. Saving an empty list requires login from every address. Whitelisted visitors may also edit this list.'}</p>
        <label className="dsh-auth-field"><span>{zh ? '免登录 IP / CIDR' : 'Login bypass IPs / CIDRs'}</span><textarea value={whitelistText} onChange={event => setWhitelistText(event.target.value)} placeholder={'127.0.0.1\n192.168.1.0/24'} spellCheck={false} /></label>
        {whitelistMessage === undefined ? null : <p className="dsh-auth-message" data-error={String(whitelistMessage.error)}>{whitelistMessage.text}</p>}
        <button className="dsh-auth-submit" type="submit" disabled={whitelistBusy}>{whitelistBusy ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存白名单' : 'Save whitelist')}</button>
      </form>
      {account.mode === 'whitelist' ? <p className="dsh-auth-message">{zh ? '当前请求通过 IP 白名单放行。白名单可以直接管理，但修改密码仍需使用账号登录。' : 'This request was allowed by the IP whitelist. You may manage the whitelist directly, but changing the password still requires an account session.'}</p> : <form className="dsh-auth-form" onSubmit={event => { void submit(event) }}>
        <h3>{zh ? '修改密码' : 'Change password'}</h3>
        <label className="dsh-auth-field"><span>{zh ? '当前密码' : 'Current password'}</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /></label>
        <label className="dsh-auth-field"><span>{zh ? '新密码' : 'New password'}</span><input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required /></label>
        <label className="dsh-auth-field"><span>{zh ? '确认新密码' : 'Confirm new password'}</span><input type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
        {message === undefined ? null : <p className="dsh-auth-message" data-error={String(message.error)}>{message.text}</p>}
        <button className="dsh-auth-submit" type="submit" disabled={busy}>{busy ? (zh ? '正在保存…' : 'Saving…') : (zh ? '修改密码' : 'Change password')}</button>
      </form>}
      </div>
    </>}
  </section>
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const existing = document.querySelector('style[data-plugin="deepseek-harness-auth"]')
    if (existing !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = 'deepseek-harness-auth'
    tag.textContent = STYLE
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'deepseek-harness-auth: client styles')
  ctx.effect(watchTheme, 'deepseek-harness-auth: login theme snapshot')
  ctx.effect(watchWelcomeNotice, 'deepseek-harness-auth: remote welcome acknowledgement')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'deepseek-harness-auth', order: 100,
  }, LogoutEntry))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'auth-account', order: 90,
    label: () => isChinese() ? '账号与安全' : 'Account & Security',
  }, AccountSection))
}

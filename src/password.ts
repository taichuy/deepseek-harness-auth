import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defaultStateDir, AuthStateStore, validatePassword, verifyPassword } from './state.js'
import { ipMatches } from './network.js'
import type { AuthProvider } from './types.js'
import type {} from './center.js'

/** Password-provider configuration. */
export interface Config {
  /** Directory containing the owner-controlled state.json. */
  stateDir: string
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default(defaultStateDir()),
})

/** Stable Cordis plugin name. */
export const name = 'auth-password'
/** Auth Center required for provider registration. */
export const inject = ['authCenter']

/** Mount the built-in local username/password provider. */
export function apply(ctx: Context, config: Config): void {
  const store = new AuthStateStore(config.stateDir)
  const provider: AuthProvider = {
    id: 'password',
    initialized: async () => await store.read() !== undefined,
    revision: async () => (await store.read())?.revision ?? 0,
    bypasses: async (clientIp) => (await store.read())?.whitelist.some(rule => ipMatches(clientIp, rule)) ?? false,
    authenticate: async (credentials) => {
      const state = await store.read()
      if (state === undefined) return undefined
      const passwordMatches = await verifyPassword(state, credentials.password)
      if (credentials.username !== state.username || !passwordMatches) return undefined
      return { username: state.username, provider: 'password' }
    },
    changePassword: async (principal, currentPassword, newPassword) => {
      if (principal.provider !== 'password') return 'unsupported'
      const state = await store.read()
      if (state === undefined || principal.username !== state.username || !await verifyPassword(state, currentPassword)) {
        return 'invalid-current'
      }
      validatePassword(newPassword)
      await store.reset(state.username, newPassword)
      return 'ok'
    },
    getIpWhitelist: async (principal) => {
      const state = await store.read()
      if (state === undefined || (principal !== undefined && (principal.provider !== 'password' || principal.username !== state.username))) return undefined
      return [...state.whitelist]
    },
    replaceIpWhitelist: async (rules, principal) => {
      const state = await store.read()
      if (state === undefined || (principal !== undefined && (principal.provider !== 'password' || principal.username !== state.username))) return undefined
      return [...(await store.updateWhitelist(() => rules)).whitelist]
    },
  }
  ctx.effect(() => ctx.authCenter.register(provider), 'auth-password: provider')
}

/** Authenticated Web identity. */
export interface AuthPrincipal {
  /** Provider-local stable account name. */
  username: string
  /** Provider that established this identity. */
  provider: string
}

/** Credentials submitted to one authentication provider. */
export interface AuthCredentials {
  /** Login name. */
  username: string
  /** Secret supplied by the browser. */
  password: string
}

/** Pluggable authentication method registered with the Auth Center. */
export interface AuthProvider {
  /** Stable provider selector used by the login endpoint. */
  id: string
  /** Whether the provider has enough durable configuration to authenticate. */
  initialized(): Promise<boolean>
  /** Current durable revision; changes revoke sessions issued against an older revision. */
  revision(): Promise<number>
  /** Whether this client address bypasses login. */
  bypasses(clientIp: string): Promise<boolean>
  /** Verify credentials without revealing which field failed. */
  authenticate(credentials: AuthCredentials): Promise<AuthPrincipal | undefined>
}

/** Result of one browser login attempt. */
export type LoginResult =
  | { status: 'ok'; token: string }
  | { status: 'invalid'; captchaRequired: boolean }
  | { status: 'captcha-required' }
  | { status: 'locked'; retryAfterSeconds: number }
  | { status: 'uninitialized' }

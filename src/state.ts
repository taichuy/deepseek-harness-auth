import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { normalizeIpRule } from './network.js'

const STATE_FILENAME = 'state.json'
const SCRYPT_KEY_BYTES = 32
const SCRYPT_COST = 32768
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

/** Version-one durable password state. */
export interface AuthState {
  version: 1
  revision: number
  username: string
  password: {
    algorithm: 'scrypt'
    salt: string
    hash: string
    cost: number
    blockSize: number
    parallelization: number
  }
  whitelist: string[]
}

/** Default directory shared by the running provider and `dsh-auth`. */
export function defaultStateDir(): string {
  return dshHomePath('auth')
}

/** Validate the local account name. */
export function validateUsername(username: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) {
    throw new Error('username must be 3-64 letters, numbers, dots, underscores, or hyphens')
  }
}

/** Require a usable secret while leaving password strength to the local owner. */
export function validatePassword(password: string): void {
  if (password.length === 0) throw new Error('password must not be empty')
}

/** @deprecated Use `validatePassword`; retained for state API compatibility. */
export function validateStrongPassword(password: string, _username?: string): void {
  validatePassword(password)
}

async function derive(password: string, salt: Buffer, cost = SCRYPT_COST, blockSize = SCRYPT_BLOCK_SIZE, parallelization = SCRYPT_PARALLELIZATION): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_BYTES, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => error === null ? resolve(key) : reject(error))
  })
}

/** Build a new durable state and password hash. */
export async function createState(username: string, password: string, previous?: AuthState): Promise<AuthState> {
  validateUsername(username)
  validatePassword(password)
  const salt = randomBytes(16)
  const hash = await derive(password, salt)
  return {
    version: 1,
    revision: (previous?.revision ?? 0) + 1,
    username,
    password: {
      algorithm: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
    },
    whitelist: previous?.whitelist ?? [],
  }
}

/** Verify one password against a durable state. */
export async function verifyPassword(state: AuthState, password: string): Promise<boolean> {
  const actual = await derive(
    password,
    Buffer.from(state.password.salt, 'base64url'),
    state.password.cost,
    state.password.blockSize,
    state.password.parallelization,
  )
  const expected = Buffer.from(state.password.hash, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function parseState(value: unknown): AuthState {
  if (typeof value !== 'object' || value === null) throw new Error('auth state must be an object')
  const state = value as Partial<AuthState>
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || (state.revision ?? 0) < 1) throw new Error('unsupported auth state version or revision')
  if (typeof state.username !== 'string') throw new Error('auth state username is missing')
  validateUsername(state.username)
  if (typeof state.password !== 'object' || state.password === null || state.password.algorithm !== 'scrypt') throw new Error('auth state password record is invalid')
  if (!Array.isArray(state.whitelist) || !state.whitelist.every(item => typeof item === 'string')) throw new Error('auth state whitelist is invalid')
  return state as AuthState
}

/** Read and atomically update the owner-controlled authentication state. */
export class AuthStateStore {
  readonly file: string

  constructor(readonly directory = defaultStateDir()) {
    this.file = join(directory, STATE_FILENAME)
  }

  /** Read current state, returning undefined before initialization. */
  async read(): Promise<AuthState | undefined> {
    try {
      return parseState(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Return the state file modification time, or zero before initialization. */
  async modifiedAt(): Promise<number> {
    try {
      return (await stat(this.file)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  /** Atomically replace state with owner-only permissions. */
  async write(state: AuthState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const temporary = join(dirname(this.file), `.${STATE_FILENAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
    await chmod(this.file, 0o600)
  }

  /** Initialize or replace the account, preserving whitelist entries. */
  async reset(username: string, password: string): Promise<AuthState> {
    const state = await createState(username, password, await this.read())
    await this.write(state)
    return state
  }

  /** Mutate whitelist state and increment the revocation revision. */
  async updateWhitelist(transform: (rules: string[]) => string[]): Promise<AuthState> {
    const current = await this.read()
    if (current === undefined) throw new Error('authentication is not initialized; run dsh-auth init first')
    const whitelist = [...new Set(transform(current.whitelist).map(normalizeIpRule))]
    const next = { ...current, revision: current.revision + 1, whitelist }
    await this.write(next)
    return next
  }

  /** Increment the durable revision, revoking every current browser session. */
  async revoke(): Promise<AuthState> {
    const current = await this.read()
    if (current === undefined) throw new Error('authentication is not initialized; run dsh-auth init first')
    const next = { ...current, revision: current.revision + 1 }
    await this.write(next)
    return next
  }
}

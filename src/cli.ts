#!/usr/bin/env node
import { stdin, stdout } from 'node:process'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { AuthStateStore, defaultStateDir } from './state.js'
import { normalizeIpRule } from './network.js'

async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const rl = createInterface({ input: stdin, output: stdout })
    try { return await rl.question(prompt) } finally { rl.close() }
  }
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { finish(); return }
        if (char === '\u0003') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          reject(new Error('cancelled'))
          return
        }
        if (char === '\u007f') {
          if (value.length > 0) { value = value.slice(0, -1); stdout.write('\b \b') }
          continue
        }
        value += char
        stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function accountInput(existingUsername?: string): Promise<{ username: string; password: string }> {
  const rl = createInterface({ input: stdin, output: stdout })
  let username: string
  try {
    username = (await rl.question(`Username${existingUsername === undefined ? '' : ` [${existingUsername}]`}: `)).trim() || existingUsername || ''
  } finally { rl.close() }
  const password = await secret('Password: ')
  const confirmation = await secret('Confirm password: ')
  if (password !== confirmation) throw new Error('password confirmation does not match')
  return { username, password }
}

async function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try { return await rl.question(prompt) } finally { rl.close() }
}

async function printStatus(store: AuthStateStore): Promise<void> {
  const state = await store.read()
  if (state === undefined) {
    stdout.write(`State: not initialized\nFile: ${store.file}\n`)
    return
  }
  stdout.write(`State: initialized\nUsername: ${state.username}\nRevision: ${String(state.revision)}\nWhitelist: ${state.whitelist.length === 0 ? '(empty; login required for every IP)' : state.whitelist.join(', ')}\nFile: ${store.file}\n`)
}

async function interactive(store: AuthStateStore): Promise<void> {
  while (true) {
    stdout.write('\n================ DeepSeek Harness Auth ================\n1) Status\n2) Initialize / reset account\n3) List IP whitelist\n4) Add IP/CIDR whitelist\n5) Remove IP/CIDR whitelist\n6) Clear whitelist (require login for every IP)\n7) Revoke all browser sessions\n0) Exit\n=======================================================\n')
    const choice = (await question('Select: ')).trim()
    if (choice === '0') return
    if (choice === '1') await printStatus(store)
    else if (choice === '2') {
      const current = await store.read()
      const input = await accountInput(current?.username)
      await store.reset(input.username, input.password)
      stdout.write('Account updated; existing sessions are revoked.\n')
    } else if (choice === '3') {
      const state = await store.read()
      stdout.write(`${state?.whitelist.join('\n') || '(empty)'}\n`)
    } else if (choice === '4') {
      const rule = normalizeIpRule(await question('IP, CIDR, or localhost: '))
      await store.updateWhitelist(rules => [...rules, rule])
      stdout.write(`Added ${rule}.\n`)
    } else if (choice === '5') {
      const rule = normalizeIpRule(await question('IP or CIDR to remove: '))
      await store.updateWhitelist(rules => rules.filter(value => value !== rule))
      stdout.write(`Removed ${rule}.\n`)
    } else if (choice === '6') {
      await store.updateWhitelist(() => [])
      stdout.write('Whitelist cleared. Every IP must now sign in.\n')
    } else if (choice === '7') {
      await store.revoke()
      stdout.write('All browser sessions revoked.\n')
    } else stdout.write('Unknown selection.\n')
  }
}

/** Build the owner-only management command. */
export function program(store = new AuthStateStore(process.env.DSH_AUTH_STATE_DIR || defaultStateDir())): Command {
  const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const command = new Command().name('dsh-auth').description('Manage DeepSeek Harness Web authentication').version(packageVersion)
  command.action(async () => { await interactive(store) })
  command.command('status').description('show authentication status').action(async () => { await printStatus(store) })
  command.command('init').description('initialize or reset the local account').action(async () => {
    const current = await store.read()
    const input = await accountInput(current?.username)
    await store.reset(input.username, input.password)
    stdout.write('Account updated; existing sessions are revoked.\n')
  })
  const whitelist = command.command('whitelist').description('manage IP/CIDR login bypasses')
  whitelist.command('list').action(async () => {
    const state = await store.read()
    stdout.write(`${state?.whitelist.join('\n') || '(empty)'}\n`)
  })
  whitelist.command('add <rule>').action(async (rule: string) => {
    const normalized = normalizeIpRule(rule)
    await store.updateWhitelist(rules => [...rules, normalized])
    stdout.write(`Added ${normalized}.\n`)
  })
  whitelist.command('remove <rule>').action(async (rule: string) => {
    const normalized = normalizeIpRule(rule)
    await store.updateWhitelist(rules => rules.filter(value => value !== normalized))
    stdout.write(`Removed ${normalized}.\n`)
  })
  whitelist.command('clear').action(async () => {
    await store.updateWhitelist(() => [])
    stdout.write('Whitelist cleared. Every IP must now sign in.\n')
  })
  command.command('revoke').description('revoke all current browser sessions').action(async () => {
    await store.revoke()
    stdout.write('All browser sessions revoked.\n')
  })
  return command
}

/** Whether argv launched this module, including through an npm `.bin` symlink. */
export function isDirectExecution(moduleUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false
  try { return moduleUrl === pathToFileURL(realpathSync(resolve(argvPath))).href } catch { return false }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  program().parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

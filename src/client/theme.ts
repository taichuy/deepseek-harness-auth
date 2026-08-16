export const THEME_STORAGE_KEY = 'dsh-auth-theme-v1'
export const MAX_THEME_BYTES = 2 * 1024 * 1024

export interface ThemeSnapshot {
  version: 1
  colorScheme: 'light' | 'dark'
  variables: Record<string, string>
  body: Record<string, string>
}

const BODY_PROPERTIES = [
  'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
  'backgroundRepeat', 'backgroundAttachment', 'color',
] as const

/** Capture the authenticated shell's effective skin without copying arbitrary markup or scripts. */
export function captureThemeSnapshot(): ThemeSnapshot {
  const rootStyle = getComputedStyle(document.documentElement)
  const bodyStyle = getComputedStyle(document.body)
  const variables: Record<string, string> = {}
  for (let index = 0; index < rootStyle.length; index += 1) {
    const name = rootStyle.item(index)
    if (/^--dsw-[a-z0-9-]+$/.test(name)) variables[name] = rootStyle.getPropertyValue(name).trim()
  }
  const body: Record<string, string> = {}
  for (const property of BODY_PROPERTIES) body[property] = bodyStyle[property]
  return {
    version: 1,
    colorScheme: rootStyle.colorScheme.includes('dark') ? 'dark' : 'light',
    variables,
    body,
  }
}

/** Persist a bounded theme snapshot for the public login page on this origin. */
export function persistThemeSnapshot(previous?: string): string | undefined {
  try {
    const snapshot = captureThemeSnapshot()
    let serialized = JSON.stringify(snapshot)
    if (new TextEncoder().encode(serialized).byteLength > MAX_THEME_BYTES) {
      delete snapshot.body.backgroundImage
      serialized = JSON.stringify(snapshot)
    }
    if (serialized === previous || new TextEncoder().encode(serialized).byteLength > MAX_THEME_BYTES) return previous
    localStorage.setItem(THEME_STORAGE_KEY, serialized)
    return serialized
  } catch {
    return previous
  }
}

/** Keep the login theme synchronized with runtime skin and appearance changes. */
export function watchTheme(): () => void {
  let last = localStorage.getItem(THEME_STORAGE_KEY) ?? undefined
  let timer: number | undefined
  const capture = (): void => { last = persistThemeSnapshot(last) }
  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(capture, 200)
  }
  capture()
  const rootObserver = new MutationObserver(schedule)
  rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  rootObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  const headObserver = new MutationObserver(schedule)
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  const delayed = window.setTimeout(capture, 1000)
  return () => {
    if (timer !== undefined) window.clearTimeout(timer)
    window.clearTimeout(delayed)
    rootObserver.disconnect()
    headObserver.disconnect()
  }
}

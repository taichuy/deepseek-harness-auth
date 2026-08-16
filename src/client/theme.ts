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

interface StyleVariables {
  readonly length: number
  item(index: number): string
  getPropertyValue(name: string): string
}

/** Merge DSH variables in cascade order; later style views override earlier ones. */
export function collectThemeVariables(...styles: StyleVariables[]): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const style of styles) {
    for (let index = 0; index < style.length; index += 1) {
      const name = style.item(index)
      if (/^--dsw-[a-z0-9-]+$/.test(name)) variables[name] = style.getPropertyValue(name).trim()
    }
  }
  return variables
}

/** Capture the authenticated shell's effective skin without copying arbitrary markup or scripts. */
export function captureThemeSnapshot(): ThemeSnapshot {
  const rootStyle = getComputedStyle(document.documentElement)
  const bodyStyle = getComputedStyle(document.body)
  // Root owns the base theme, while third-party skins commonly override the
  // same tokens on an attributed body selector. Body must be collected last.
  const variables = collectThemeVariables(rootStyle, bodyStyle)
  const body: Record<string, string> = {}
  for (const property of BODY_PROPERTIES) body[property] = bodyStyle[property]
  return {
    version: 1,
    colorScheme: bodyStyle.colorScheme.includes('dark') || rootStyle.colorScheme.includes('dark') ? 'dark' : 'light',
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
  let last: string | undefined
  try { last = localStorage.getItem(THEME_STORAGE_KEY) ?? undefined } catch {}
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

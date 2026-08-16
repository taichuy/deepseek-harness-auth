export const WELCOME_ACK_STORAGE_KEY = 'dsh-auth-welcome-ack-v1'

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Recognize Harness's versioned internal-testing notice without matching arbitrary dialogs. */
export function welcomeNoticeFingerprint(text: string): string | undefined {
  const value = normalized(text)
  const titled = value.includes('内测声明') || value.includes('Internal Testing Notice')
  const productCopy = value.includes('DeepSeek Harness')
    && (value.includes('DSH 插件生态') || value.includes('DSH plugin ecosystem'))
  return titled && productCopy ? value : undefined
}

function continueButton(dialog: Element): HTMLButtonElement | undefined {
  return [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
    const label = normalized(button.textContent ?? '')
    return label === '继续' || label === 'Continue'
  })
}

/** Persist an explicit remote acknowledgement and replay it for unchanged notice copy after reloads. */
export function watchWelcomeNotice(): () => void {
  let acknowledged: string | null = null
  try { acknowledged = localStorage.getItem(WELCOME_ACK_STORAGE_KEY) } catch {}
  const replayed = new WeakSet<Element>()

  const scan = (): void => {
    if (acknowledged === null) return
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      const fingerprint = welcomeNoticeFingerprint(dialog.textContent ?? '')
      if (fingerprint !== acknowledged || replayed.has(dialog)) continue
      const button = continueButton(dialog)
      if (button === undefined) continue
      replayed.add(dialog)
      button.click()
    }
  }

  const remember = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button')
    if (button === null) return
    const dialog = button.closest('[role="dialog"]')
    if (dialog === null || continueButton(dialog) !== button) return
    const fingerprint = welcomeNoticeFingerprint(dialog.textContent ?? '')
    if (fingerprint === undefined) return
    acknowledged = fingerprint
    try { localStorage.setItem(WELCOME_ACK_STORAGE_KEY, fingerprint) } catch {}
  }

  document.addEventListener('click', remember, true)
  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  scan()
  return () => {
    document.removeEventListener('click', remember, true)
    observer.disconnect()
  }
}

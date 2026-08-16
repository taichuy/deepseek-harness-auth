/** Escape untrusted text for an HTML text or quoted-attribute position. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Render the standalone login page served before Harness assets are authorized. */
export function loginPage(options: { error?: string; captcha: boolean; initialized: boolean }): string {
  const message = options.initialized
    ? options.error
    : 'Authentication is not initialized. Run dsh-auth on the server.'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness Login</title><script src="/auth/login-theme.js" defer></script><style>
:root{color-scheme:light dark;--auth-bg:#f4f7fb;--auth-card:rgba(255,255,255,.86);--auth-text:#17233d;--auth-muted:#64748b;--auth-border:rgba(23,35,61,.16);--auth-input:rgba(255,255,255,.74);--auth-brand:#2563eb;--auth-error-bg:#fff1f2;--auth-error:#be123c}@media(prefers-color-scheme:dark){:root{--auth-bg:#0d1117;--auth-card:rgba(22,27,34,.88);--auth-text:#e6edf3;--auth-muted:#8b949e;--auth-border:#30363d;--auth-input:rgba(13,17,23,.8);--auth-brand:#3578e5;--auth-error-bg:#3d1f24;--auth-error:#ffb3ba}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background-color:var(--dsw-alias-bg-base,var(--auth-bg));color:var(--dsw-alias-label-primary,var(--auth-text));font:15px Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background-repeat:no-repeat;background-size:cover;background-position:center;background-attachment:fixed}.card{width:min(92vw,400px);padding:30px;border:1px solid var(--dsw-alias-border-l2,var(--auth-border));border-radius:16px;background:var(--dsw-alias-bg-layer-2,var(--auth-card));box-shadow:0 20px 60px rgba(0,0,0,.22);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}h1{margin:0 0 8px;font-size:23px;letter-spacing:-.02em}p{color:var(--dsw-alias-label-secondary,var(--auth-muted));margin:0 0 22px}.error{padding:10px 12px;border-radius:9px;background:var(--dsw-alias-state-error-secondary,var(--auth-error-bg));color:var(--dsw-alias-state-error-primary,var(--auth-error));margin-bottom:16px}label{display:block;margin:14px 0 6px;color:var(--dsw-alias-label-secondary,var(--auth-muted));font-size:13px;font-weight:600}input{width:100%;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2,var(--auth-border));border-radius:9px;background:var(--dsw-alias-bg-layer-1,var(--auth-input));color:inherit;font:inherit;outline:none}input:focus{border-color:var(--dsw-alias-brand-primary,var(--auth-brand));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--auth-brand)) 18%,transparent)}button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:9px;background:var(--dsw-alias-brand-primary,var(--auth-brand));color:white;font-weight:650;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.captcha{display:flex;gap:10px;align-items:end}.captcha input{flex:1}.captcha img{width:132px;height:46px;border-radius:8px;background:white;cursor:pointer}</style></head>
<body><main class="card"><h1>DeepSeek Harness</h1><p>Sign in to access this Web instance.</p>
${message === undefined ? '' : `<div class="error">${escapeHtml(message)}</div>`}
<form method="post" action="/auth/login"><input type="hidden" name="provider" value="password">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${options.captcha ? '<label for="captcha">Verification code</label><div class="captcha"><input id="captcha" name="captcha" inputmode="numeric" autocomplete="off" required><img id="captcha-image" src="/auth/captcha" alt="Verification code" title="Click to refresh"></div>' : ''}
<button type="submit"${options.initialized ? '' : ' disabled'}>Sign in</button></form></main></body></html>`
}

/** Public standalone script that restores the last authenticated Harness theme snapshot. */
export const loginThemeScript = `(() => {
  const key = 'dsh-auth-theme-v1';
  const safeBody = new Set(['backgroundColor','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','backgroundAttachment','color']);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (parsed && parsed.version === 1 && parsed.variables && typeof parsed.variables === 'object') {
      for (const [name, value] of Object.entries(parsed.variables)) {
        if (/^--dsw-[a-z0-9-]+$/.test(name) && typeof value === 'string' && value.length <= 8192) document.documentElement.style.setProperty(name, value);
      }
      if (parsed.colorScheme === 'light' || parsed.colorScheme === 'dark') document.documentElement.style.colorScheme = parsed.colorScheme;
      if (parsed.body && typeof parsed.body === 'object') {
        for (const [name, value] of Object.entries(parsed.body)) {
          if (safeBody.has(name) && typeof value === 'string' && value.length <= 2097152) document.body.style[name] = value;
        }
      }
    }
  } catch {}
  const captcha = document.getElementById('captcha-image');
  captcha?.addEventListener('click', () => { captcha.src = '/auth/captcha?t=' + Date.now(); });
})();`

/** Render a deliberately simple one-use SVG captcha. */
export function captchaSvg(answer: string): string {
  const digits = [...answer].map((digit, index) => `<text x="${18 + index * 23}" y="32" transform="rotate(${index % 2 === 0 ? -8 : 7} ${18 + index * 23} 32)">${digit}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="46" viewBox="0 0 132 46"><rect width="132" height="46" fill="#f6f8fa"/><path d="M2 12L130 36M2 37L130 8M0 24Q32 4 65 24T132 22" stroke="#8c959f" stroke-width="1.4" fill="none"/><g fill="#1f2328" font-family="monospace" font-weight="700" font-size="28">${digits}</g></svg>`
}

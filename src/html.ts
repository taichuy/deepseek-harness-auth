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
<title>DeepSeek Harness Login</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:15px system-ui,sans-serif}.card{width:min(92vw,400px);padding:30px;border:1px solid #30363d;border-radius:14px;background:#161b22;box-shadow:0 18px 50px #0008}h1{margin:0 0 8px;font-size:23px}p{color:#8b949e;margin:0 0 22px}.error{padding:10px 12px;border-radius:8px;background:#3d1f24;color:#ffb3ba;margin-bottom:16px}label{display:block;margin:14px 0 6px}input{width:100%;padding:11px 12px;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:inherit;font:inherit}button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:#238636;color:white;font-weight:650;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.captcha{display:flex;gap:10px;align-items:end}.captcha input{flex:1}.captcha img{width:132px;height:46px;border-radius:8px;background:white;cursor:pointer}</style></head>
<body><main class="card"><h1>DeepSeek Harness</h1><p>Sign in to access this Web instance.</p>
${message === undefined ? '' : `<div class="error">${escapeHtml(message)}</div>`}
<form method="post" action="/auth/login"><input type="hidden" name="provider" value="password">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${options.captcha ? '<label for="captcha">Verification code</label><div class="captcha"><input id="captcha" name="captcha" inputmode="numeric" autocomplete="off" required><img src="/auth/captcha" alt="Verification code" title="Click to refresh" onclick="this.src=\'/auth/captcha?t=\'+Date.now()"></div>' : ''}
<button type="submit"${options.initialized ? '' : ' disabled'}>Sign in</button></form></main></body></html>`
}

/** Render a deliberately simple one-use SVG captcha. */
export function captchaSvg(answer: string): string {
  const digits = [...answer].map((digit, index) => `<text x="${18 + index * 23}" y="32" transform="rotate(${index % 2 === 0 ? -8 : 7} ${18 + index * 23} 32)">${digit}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="46" viewBox="0 0 132 46"><rect width="132" height="46" fill="#f6f8fa"/><path d="M2 12L130 36M2 37L130 8M0 24Q32 4 65 24T132 22" stroke="#8c959f" stroke-width="1.4" fill="none"/><g fill="#1f2328" font-family="monospace" font-weight="700" font-size="28">${digits}</g></svg>`
}

import { chmodSync } from 'node:fs'

chmodSync(new URL('../lib/cli.js', import.meta.url), 0o755)

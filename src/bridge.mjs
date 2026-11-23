/**
 * Client for the DSHA app bridge (`http://127.0.0.1:<port>/app/...`).
 *
 * The bridge is the sanctioned way to hand an APK to the system installer: it
 * keeps the token in a header file (never in a URL), and it does not let the
 * agent install silently — the user confirms in the system UI.
 */
import { existsSync, readFileSync } from 'node:fs'

const DEFAULT_HEADERS = '/root/.dsh/.bridge_headers'
const DEFAULT_PORT_FILE = '/root/.dsh/.bridge_port'

/** Local bridge port; the file is authoritative, the env var is a test hook. */
export function bridgePort({ env = process.env, portFile = DEFAULT_PORT_FILE } = {}) {
  const fromEnv = (env.DSH_BRIDGE_PORT ?? '').trim()
  if (/^\d{2,5}$/.test(fromEnv)) return Number(fromEnv)
  try {
    const value = readFileSync(portFile, 'utf8').trim()
    if (/^\d{2,5}$/.test(value)) return Number(value)
  } catch {}
  return 3091
}

/** Parse `Name: value` lines into a header object. */
export function parseHeaders(text) {
  const headers = {}
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line.trim())
    if (match) headers[match[1]] = match[2]
  }
  return headers
}

export function bridgeHeaders({ headersFile = DEFAULT_HEADERS } = {}) {
  try {
    return parseHeaders(readFileSync(headersFile, 'utf8'))
  } catch {
    return {}
  }
}

/** Build a bridge URL without ever putting credentials in it. */
export function bridgeUrl(path, query = {}, options = {}) {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `http://127.0.0.1:${bridgePort(options)}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url
}

/** GET a bridge endpoint; the body is JSON when the app sends JSON. */
export async function bridgeGet(path, query = {}, options = {}) {
  const { timeoutMs = 30_000 } = options
  const url = bridgeUrl(path, query, options)
  const headers = options.headers ?? bridgeHeaders(options)
  if (!existsSync(options.headersFile ?? DEFAULT_HEADERS)) {
    throw new Error('bridge header file is missing; the DSHA app bridge is not available on this device')
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: response.status, ok: response.ok, body }
}

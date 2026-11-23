/**
 * Release signing with `apksigner.jar`.
 *
 * apksigner is a Java tool, so it works on aarch64 as long as the SDK has
 * build-tools. Secrets never appear on a command line (`--ks-pass env:NAME`
 * reads them from the child environment) and never in tool arguments, so they
 * cannot leak into the transcript or `ps`.
 *
 * Configuration sources, highest priority first:
 *   1. explicit keystore/alias arguments
 *   2. environment: ANDROID_KEYSTORE, ANDROID_KEY_ALIAS,
 *      ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_PASSWORD
 *   3. `<root>/signing.json` (chmod 600) or ANDROID_SIGNING_CONFIG
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sdkRoot } from './paths.mjs'
import { buildEnv } from './env.mjs'
import { runInSlot } from './slot.mjs'

const KS_PASS_ENV = 'ANDROID_KS_PASS'
const KEY_PASS_ENV = 'ANDROID_KEY_PASS'

/** Newest build-tools apksigner.jar, or null. */
export function findApksigner(root) {
  const sdk = sdkRoot(root)
  if (!sdk) return null
  const dir = join(sdk, 'build-tools')
  let versions = []
  try {
    versions = readdirSync(dir)
  } catch {
    return null
  }
  const rank = (value) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  versions.sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (b[index] ?? 0) - (a[index] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
  for (const version of versions) {
    const jar = join(dir, version, 'lib', 'apksigner.jar')
    if (existsSync(jar)) return jar
  }
  return null
}

function readPasswordFile(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Resolve the signing identity without exposing secrets.
 * @returns {{configFile: string|null, keystore?: string, alias?: string,
 *   storePassword?: string, keyPassword?: string, missing: string[]}}
 */
export function loadSigningConfig(root, env = process.env) {
  const configFile = (env.ANDROID_SIGNING_CONFIG ?? '').trim() || join(root, 'signing.json')
  let config = {}
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, 'utf8'))
    } catch (error) {
      throw new Error(`cannot parse ${configFile}: ${error.message}`)
    }
  }
  const keystore = env.ANDROID_KEYSTORE || config.keystore
  const alias = env.ANDROID_KEY_ALIAS || config.alias
  const storePassword =
    env.ANDROID_KEYSTORE_PASSWORD ||
    config.storePassword ||
    (config.storePasswordFile ? readPasswordFile(config.storePasswordFile) : undefined)
  const keyPassword = env.ANDROID_KEY_PASSWORD || config.keyPassword || storePassword

  const missing = []
  if (!keystore) missing.push('keystore')
  if (!alias) missing.push('alias')
  if (!storePassword) missing.push('storePassword')
  if (keystore && !existsSync(keystore)) missing.push('keystore-file')
  return { configFile: existsSync(configFile) ? configFile : null, keystore, alias, storePassword, keyPassword, missing }
}

/** Human-readable setup hint; contains no secret values. */
export function signingHint(root) {
  return [
    `signing is not configured for ${root}.`,
    `Create ${join(root, 'signing.json')} (chmod 600):`,
    '  {"keystore":"/path/release.jks","alias":"release","storePasswordFile":"/path/store.pass"}',
    'or set ANDROID_KEYSTORE, ANDROID_KEY_ALIAS, ANDROID_KEYSTORE_PASSWORD (and optionally ANDROID_KEY_PASSWORD).',
    'Never paste a password into the conversation: only paths and environment variable names belong there.',
  ].join('\n')
}

function javaPath(root) {
  return join(root, 'jdk', 'current', 'bin', 'java')
}

/** Default output path: next to the input, never the same file. */
export function resolveOutput(apk, out) {
  const target = out ?? join(dirname(apk), `${basename(apk).replace(/\.apk$/i, '')}-signed.apk`)
  if (target === apk) throw new Error('refusing to sign in place; pass --out with a different path')
  if (!target.endsWith('.apk')) throw new Error(`--out must end with .apk: ${target}`)
  return target
}

/** Parse `apksigner verify --print-certs` for the signer digest. */
export function parseCertDigest(output) {
  const match = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(output ?? '')
  return match ? match[1].toLowerCase() : null
}

/**
 * Sign an APK (never in place) and verify the result, both through the slot.
 * @returns {Promise<{ok: boolean, output?: string, out?: string, verified?: boolean,
 *   certSha256?: string|null, signBuildId?: string, verifyBuildId?: string,
 *   verifyOutput?: string, reason?: string}>}
 */
export async function signApk({ root, apk, out, keystore, alias, timeoutMs, owner, env = process.env }) {
  const jar = findApksigner(root)
  if (!jar) throw new Error(`apksigner.jar not found under ${root}/sdk/build-tools; run scripts/setup-apk.sh`)
  if (!existsSync(apk)) throw new Error(`APK not found: ${apk}`)
  const target = resolveOutput(apk, out)

  const config = loadSigningConfig(root, env)
  const resolved = {
    keystore: keystore ?? config.keystore,
    alias: alias ?? config.alias,
    storePassword: config.storePassword,
    keyPassword: config.keyPassword,
  }
  if (!resolved.keystore || !resolved.alias || !resolved.storePassword) {
    throw new Error(signingHint(root))
  }
  if (!existsSync(resolved.keystore)) throw new Error(`keystore not found: ${resolved.keystore}`)

  // Secrets travel only in the child environment.
  const childEnv = {
    ...buildEnv(root, env),
    [KS_PASS_ENV]: resolved.storePassword,
    [KEY_PASS_ENV]: resolved.keyPassword ?? resolved.storePassword,
  }

  const sign = await runInSlot({
    root,
    cmd: javaPath(root),
    args: [
      '-jar', jar, 'sign',
      '--ks', resolved.keystore,
      '--ks-key-alias', resolved.alias,
      '--ks-pass', `env:${KS_PASS_ENV}`,
      '--key-pass', `env:${KEY_PASS_ENV}`,
      '--out', target,
      apk,
    ],
    env: childEnv,
    owner: owner ?? `sign:${process.pid}`,
    timeoutMs: timeoutMs ?? 300_000,
  })
  if (!sign.ok) {
    // apksigner's own message is safe: it never echoes the password.
    return { ok: false, out: target, reason: 'sign failed', output: `${sign.stdout}\n${sign.stderr}`.trim(), signBuildId: sign.id }
  }

  const verify = await runInSlot({
    root,
    cmd: javaPath(root),
    args: ['-jar', jar, 'verify', '--print-certs', target],
    env: childEnv,
    owner: `${owner ?? 'sign'}:verify`,
    timeoutMs: 120_000,
  })
  return {
    ok: verify.ok,
    out: target,
    verified: verify.ok,
    certSha256: parseCertDigest(`${verify.stdout}\n${verify.stderr}`),
    verifyOutput: `${verify.stdout}\n${verify.stderr}`.trim().slice(0, 4000),
    signBuildId: sign.id,
    verifyBuildId: verify.id,
    reason: verify.ok ? undefined : 'verify failed',
  }
}

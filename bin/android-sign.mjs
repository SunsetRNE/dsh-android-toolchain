#!/usr/bin/env node
/**
 * `android-sign <apk> [--out path] [--keystore path] [--alias name] [--timeout ms]`
 *
 * Signs with apksigner.jar through the single slot and verifies the signature.
 * Passwords come from the environment or `<root>/signing.json` — never from
 * arguments, so they cannot appear in the transcript or in `ps`.
 */
import { resolveRoot } from '../src/paths.mjs'
import { signApk, signingHint } from '../src/signing.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const out = value('--out')
const keystore = value('--keystore')
const alias = value('--alias')
const timeoutMs = Number(value('--timeout') ?? '')
const owner = value('--owner') ?? `sign:${process.pid}`
const apk = argv[0]

if (!apk) {
  console.error('usage: android-sign <apk> [--out path] [--keystore path] [--alias name] [--timeout ms]')
  process.exit(64)
}

const root = resolveRoot({})
let result
try {
  result = await signApk({
    root,
    apk,
    out,
    keystore,
    alias,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    owner,
  })
} catch (error) {
  console.error(`[android-sign] ${error.message}`)
  if (/signing is not configured/.test(error.message)) console.error(signingHint(root))
  process.exit(1)
}

if (result.output) console.error(result.output)
console.error(`[android-sign] ${result.signBuildId ?? '-'} -> ${result.out} verified=${result.verified ?? false}`)
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)

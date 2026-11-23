#!/usr/bin/env node
/**
 * `android-sign <apk> [--out path] [--root ROOT] [--keystore path] [--alias name] [--timeout ms]`
 *
 * Signs with apksigner.jar through a single slot and verifies the signature.
 * Passwords come from the environment or `<root>/signing.json` — never from
 * arguments, so they cannot appear in the transcript or in `ps`.
 */
import { resolveRoot } from '../src/paths.mjs'
import { signApk, signingHint } from '../src/signing.mjs'
import { resolveRootRef } from '../src/roots.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const out = value('--out')
const rootRef = value('--root')
const keystore = value('--keystore')
const alias = value('--alias')
const timeoutMs = Number(value('--timeout') ?? '')
const waitMs = Number(value('--wait') ?? '')
const owner = value('--owner') ?? `sign:${process.pid}`
const apk = argv[0]

if (!apk) {
  console.error('usage: android-sign <apk> [--out path] [--root ROOT] [--keystore path] [--alias name] [--timeout ms]')
  process.exit(64)
}

let root
try {
  root = resolveRootRef(rootRef, { primary: resolveRoot({}) })
} catch (error) {
  console.error(`[android-sign] ${error.message}`)
  process.exit(1)
}

let result
try {
  result = await signApk({
    root,
    apk,
    out,
    keystore,
    alias,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : undefined,
    owner,
  })
} catch (error) {
  console.error(`[android-sign] ${error.message}`)
  if (/signing is not configured/.test(error.message)) console.error(signingHint(root))
  process.exit(1)
}

if (result.output) console.error(result.output)
console.error(`[android-sign] ${result.signBuildId ?? '-'} -> ${result.out} verified=${result.verified ?? false}${result.reason ? ` (${result.reason})` : ''}`)
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : result.exitCode ?? 1)

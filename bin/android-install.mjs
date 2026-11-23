#!/usr/bin/env node
/**
 * `android-install <apk> [--package name]`
 *
 * Hands an APK to the system installer through the app bridge. The user
 * confirms on the device; this command only reports that the request was made
 * and (optionally) what version of the package is installed right now.
 */
import { installApk } from '../src/install.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}

const packageName = value('--package')
const apk = argv[0]

if (!apk) {
  console.error('usage: android-install <apk> [--package name]')
  process.exit(64)
}

try {
  const result = await installApk({ apk, packageName })
  if (result.requested) {
    console.error(`[android-install] requested via ${result.mode}: ${apk}`)
  } else {
    console.error(`[android-install] not requested (${result.code ?? 'unknown'}): ${result.note}`)
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.requested ? 0 : 1)
} catch (error) {
  console.error(`[android-install] ${error.message}`)
  process.exit(1)
}

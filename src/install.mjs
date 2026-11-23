/**
 * APK installation through the system installer.
 *
 * `/app/install` only *requests* the install: the user confirms in the Android
 * installer UI. `OK: installer` therefore means "dialog opened", never
 * "installed". Verification is a separate read (`/app/apps?q=`).
 */
import { existsSync } from 'node:fs'
import { bridgeGet } from './bridge.mjs'

const GUIDANCE = {
  NO_PERMISSION: 'DSHA is not allowed to install unknown apps. Allow it in the system settings that just opened, then ask again once.',
  NO_NOTIFICATION: 'Notifications are disabled, so the install request could not be surfaced. Enable notifications for DSHA or bring the app to the foreground.',
  NOT_FOUND: 'the APK path does not exist or is not readable by the app bridge',
  UNSUPPORTED: 'this package format is not supported (split APKs / .apks / .xapk are not)',
}

/** Map a bridge result string to a structured outcome. Pure, for tests. */
export function classifyInstallResult(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith('OK:')) {
    const mode = text.slice(3).trim()
    return {
      requested: true,
      mode,
      installed: false,
      note:
        mode === 'installer'
          ? 'The system installer is open on the device; confirm it there, then re-check the package.'
          : 'The install request is queued as a notification; tap it on the device, then re-check the package.',
    }
  }
  const code = text.split(':')[0]
  return {
    requested: false,
    mode: null,
    installed: false,
    code,
    note: GUIDANCE[code] ?? text,
  }
}

/**
 * Request installation of a container-visible APK and, when a package name is
 * given, report the currently installed state (which may still be the old
 * version until the user confirms).
 */
export async function installApk({ apk, packageName, options = {} }) {
  if (!apk) throw new Error('apk is required')
  if (!existsSync(apk)) throw new Error(`APK not found: ${apk} (must be visible inside the container)`)
  const result = await bridgeGet('/app/install', { path: apk }, options)
  const raw = typeof result.body === 'object' && result.body?.result !== undefined ? result.body.result : result.body
  const outcome = classifyInstallResult(raw)

  let installedNow = null
  if (packageName) {
    try {
      const apps = await bridgeGet('/app/apps', { q: packageName }, options)
      installedNow = typeof apps.body === 'object' && apps.body?.result !== undefined ? apps.body.result : apps.body
    } catch (error) {
      installedNow = `could not query installed apps: ${error.message}`
    }
  }
  return { apk, packageName: packageName ?? null, ...outcome, installedNow, raw }
}

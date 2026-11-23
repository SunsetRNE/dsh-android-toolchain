/**
 * APK installation through the system installer.
 *
 * `/app/install` only *requests* the install: the user confirms in the Android
 * installer UI. `OK: installer` therefore means "dialog opened", never
 * "installed". Verification is a separate read (`/app/apps?q=`).
 */
import { existsSync } from 'node:fs'
import { bridgeGet } from './bridge.mjs'
import { appendHistory } from './history.mjs'

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
    const raw = text.slice(3).trim()
    // The bridge appends a human explanation after the mode word.
    const kind = raw.split(/\s+/)[0] || 'installer'
    const detail = raw.slice(kind.length).trim() || null
    return {
      requested: true,
      mode: kind,
      detail,
      installed: false,
      note:
        kind === 'installer'
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
export async function installApk({ apk, packageName, root, options = {}, request = bridgeGet }) {
  if (!apk) throw new Error('apk is required')
  if (!existsSync(apk)) throw new Error(`APK not found: ${apk} (must be visible inside the container)`)
  const startedAt = new Date().toISOString()
  const result = await request('/app/install', { path: apk }, options)
  const raw = typeof result.body === 'object' && result.body?.result !== undefined ? result.body.result : result.body
  const outcome = classifyInstallResult(raw)

  let installedNow = null
  if (packageName) {
    try {
      const apps = await request('/app/apps', { q: packageName }, options)
      installedNow = typeof apps.body === 'object' && apps.body?.result !== undefined ? apps.body.result : apps.body
    } catch (error) {
      installedNow = `could not query installed apps: ${error.message}`
    }
  }
  const id = `${Date.now().toString(36)}-${process.pid}`
  if (root) {
    appendHistory(root, {
      id,
      kind: 'install',
      apk,
      packageName: packageName ?? null,
      requested: outcome.requested,
      mode: outcome.mode,
      code: outcome.code ?? null,
      status: outcome.requested ? 'requested' : 'blocked',
      startedAt,
      finishedAt: new Date().toISOString(),
    })
  }
  return { id, apk, packageName: packageName ?? null, ...outcome, installedNow, raw }
}

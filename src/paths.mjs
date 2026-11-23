/**
 * Shared-area paths for the toolchain.
 *
 * The toolchain deliberately lives *outside* the profile and outside any
 * workspace: a plugin upgrade must never delete a 2 GB JDK, and a workspace
 * checkout must never be the only copy. `/opt/android-toolchain` is the
 * default shared area; it falls back to `$DSH_HOME/android-toolchain` when the
 * process cannot create `/opt`.
 */
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default shared root. */
export const DEFAULT_ROOT = '/opt/android-toolchain'

/** Root the deployment asked for, if any. */
export function configuredRoot(env = process.env) {
  const explicit = (env.DSH_ANDROID_ROOT ?? '').trim()
  return explicit || ''
}

/** Fallback root that needs no privileges. */
export function fallbackRoot(env = process.env) {
  const home = (env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'android-toolchain')
}

/**
 * Pick the directory to use for the toolchain.
 * With `create`, prefer the first candidate this process can write to and
 * create it; otherwise return the configured/default root even when absent.
 */
export function resolveRoot({ root, env = process.env, create = false } = {}) {
  const candidates = [root?.trim(), configuredRoot(env), DEFAULT_ROOT, fallbackRoot(env)].filter(Boolean)
  if (!create) return candidates.find((dir) => existsSync(dir)) ?? candidates[0]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, constants.W_OK)
      return dir
    } catch {}
  }
  return candidates[candidates.length - 1]
}

/** Files that coordinate the single build slot. */
export function runPaths(root) {
  const runDir = join(root, 'run')
  return {
    runDir,
    lock: join(runDir, 'build.lock'),
    holder: join(runDir, 'holder.json'),
    queue: join(runDir, 'queue'),
    provisionLock: join(runDir, 'provision.lock'),
  }
}

/** `<root>/<component>` holds versions plus a `current` symlink. */
export function componentPath(root, name) {
  return join(root, name)
}

/** `<root>/<component>/current` is the version the launchers point at. */
export function currentPath(root, name) {
  return join(root, name, 'current')
}

/** Launchers written by the provisioner and shared by every session. */
export function binPath(root, tool) {
  return join(root, 'bin', tool)
}

/** Android SDK root: `<root>/sdk` (sdkmanager layout) or a `current` link. */
export function sdkRoot(root) {
  for (const candidate of [join(root, 'sdk'), join(root, 'sdk', 'current')]) {
    if (existsSync(join(candidate, 'platforms')) || existsSync(join(candidate, 'build-tools'))) return candidate
  }
  return null
}

/** The arm64 aapt2 override, when the APK setup script installed one. */
export function aapt2Override(root) {
  const wrapper = join(root, 'aapt2', 'current', 'bin', 'aapt2')
  return existsSync(wrapper) ? wrapper : null
}

/** Marker file that makes a component version "installed". */
export function installedMarker(root, name, version) {
  return join(root, name, version, '.installed.json')
}

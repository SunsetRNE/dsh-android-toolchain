/**
 * Read-only view of one root, or of every registered root.
 *
 * Both `android-status` and the `android_status` MCP tool call this, so the CLI
 * and the tool cannot disagree about what is installed or who holds the slot.
 * Nothing here creates directories: inspecting an uninstalled root is safe.
 */
import { existsSync, readlinkSync } from 'node:fs'
import { currentPath } from './paths.mjs'
import { readSlotState } from './slot.mjs'
import { readHistory } from './history.mjs'
import { enabledComponents, loadManifest } from './manifest.mjs'
import { readRegistry } from './roots.mjs'

/** Components `android_status` reports on (mirrors the manifest names). */
const REPORTED = ['jdk', 'gradle', 'kotlin', 'sdk', 'ndk']

function linkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/** Installed component version per `current` symlink. */
export function installedComponents(root) {
  const installed = {}
  for (const name of REPORTED) {
    const current = currentPath(root, name)
    installed[name] = existsSync(current) ? linkTarget(current) : null
  }
  return installed
}

/**
 * One root as `android_status` shows it.
 * @returns {{root: string, limits: object, limitWarnings: string[],
 *   limitsFile: string|null, slot: object, installed: object, enabled: string[],
 *   recent: object[]}}
 */
export function describeRoot(root, { manifest = loadManifest(), recent = 5 } = {}) {
  const state = readSlotState(root)
  return {
    root,
    limits: state.limits,
    limitWarnings: state.limitWarnings,
    limitsFile: state.limitsFile,
    slot: state,
    installed: installedComponents(root),
    enabled: enabledComponents(manifest).map((component) => component.name),
    recent: readHistory(root, recent),
  }
}

/**
 * Every registered root, primary first. Each root keeps its own limits file and
 * slot, which is what lets two roots build at the same time.
 * @returns {{registry: string, registryExists: boolean, warnings: string[],
 *   roots: Array<{label: string, primary: boolean} & ReturnType<typeof describeRoot>>}}
 */
export function describeAllRoots(primary, { env = process.env, recent = 5, manifest = loadManifest() } = {}) {
  const registry = readRegistry(primary, env)
  return {
    registry: registry.path,
    registryExists: registry.exists,
    warnings: registry.warnings,
    roots: registry.roots.map((entry) => ({
      label: entry.label,
      primary: entry.primary,
      ...describeRoot(entry.path, { manifest, recent }),
    })),
  }
}

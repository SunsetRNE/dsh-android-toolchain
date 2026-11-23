/**
 * The manifest is the source of truth for what gets installed into the shared
 * area. Every enabled component must carry a sha256 before a release: CI runs
 * `--verify-manifest --strict`, and the provisioner refuses unpinned archives
 * unless the caller explicitly passes `--allow-unpinned`.
 */
import { readFileSync } from 'node:fs'

export const MANIFEST_PATH = new URL('../toolchain.manifest.json', import.meta.url)
const ARCHIVES = new Set(['tar.gz', 'zip'])

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function components(manifest) {
  return Object.entries(manifest.components ?? {}).map(([name, spec]) => ({ name, ...spec }))
}

export function enabledComponents(manifest) {
  return components(manifest).filter((component) => component.enabled)
}

/** Shape/pin validation, shared by the CLI, the broker, and CI. */
export function validateManifest(manifest, { strict = false } = {}) {
  const problems = []
  const warnings = []
  if (manifest?.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  const list = components(manifest)
  if (list.length === 0) problems.push('no components declared')
  for (const component of list) {
    // Disabled entries are documentation: they may name a component without a
    // source or version until someone enables it.
    if (!component.enabled) continue
    const where = component.name
    if (!component.version) problems.push(`${where}: version is required`)
    if (!component.source) problems.push(`${where}: source is required`)
    if (!ARCHIVES.has(component.archive)) problems.push(`${where}: archive must be tar.gz or zip`)
    if (!/^[0-9a-f]{64}$/.test(component.sha256 ?? '')) {
      const message = `${where}: enabled without a pinned sha256 (run --pin, then commit)`
      if (strict) problems.push(message)
      else warnings.push(message)
    }
  }
  return { problems, warnings }
}

/** Reachability check for CI: HEAD each enabled source. */
export async function probeSources(manifest, { timeoutMs = 20_000 } = {}) {
  const results = []
  for (const component of enabledComponents(manifest)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(component.source, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
      results.push({ name: component.name, status: response.status, ok: response.ok })
    } catch (error) {
      results.push({ name: component.name, status: 0, ok: false, error: error?.message ?? String(error) })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

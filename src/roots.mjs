/**
 * Registry of toolchain roots on one device.
 *
 * Each root already owns its lock (`<root>/run/build.lock`), so two roots never
 * queue behind each other: the single-slot guarantee is per root, not per
 * machine. What was missing is discovery — which roots exist, how a call names
 * one, and how a new root reuses archives another root has already downloaded.
 *
 * The registry is device-wide bookkeeping, deliberately *not* part of any
 * toolchain: deleting a toolchain must not break the others. It lives next to
 * the primary root (`<root>/roots.json`) and can be moved with
 * `DSH_ANDROID_REGISTRY`.
 *
 * A deployment with one root is unchanged: the primary root is always present,
 * even when no registry file exists, and is labelled `default`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveRoot } from './paths.mjs'

export const SCHEMA_VERSION = 1
export const PRIMARY_LABEL = 'default'

const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/i

/** Registry file for this device (env override wins). */
export function registryPath(primary, env = process.env) {
  const explicit = (env.DSH_ANDROID_REGISTRY ?? '').trim()
  return explicit ? resolve(explicit) : join(primary, 'roots.json')
}

/** Absolute, symlink-resolved when the path exists; throws on relative input. */
export function normalizeRootPath(path) {
  const text = String(path ?? '').trim()
  if (!text) throw new Error('root path is empty')
  if (!isAbsolute(text)) throw new Error(`root path must be absolute: ${text}`)
  const absolute = resolve(text)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** A filesystem-safe label derived from the directory name, unique in `taken`. */
export function labelFor(path, taken = new Set()) {
  const base = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 24)
  const stem = base || 'root'
  let label = stem
  for (let index = 2; taken.has(label); index += 1) label = `${stem}-${index}`
  return label
}

/** Validate a caller-supplied label; returns the trimmed label. */
export function validateLabel(label) {
  const text = String(label ?? '').trim()
  if (!text) return ''
  if (!LABEL.test(text)) throw new Error(`invalid label "${text}": use letters, digits, ".", "_" or "-" (max 32)`)
  return text
}

/**
 * Read the registry. Never throws: a corrupt file degrades to "primary root
 * only" plus a warning, so a broken registry cannot take the toolchain down.
 * @returns {{path: string, exists: boolean, roots: Array<{path: string,
 *   label: string, addedAt: string|null, primary: boolean}>, warnings: string[]}}
 */
export function readRegistry(primary, env = process.env) {
  const file = registryPath(primary, env)
  const warnings = []
  const declared = []

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.schemaVersion !== SCHEMA_VERSION) {
        warnings.push(`${file}: schemaVersion ${JSON.stringify(parsed?.schemaVersion)} (expected ${SCHEMA_VERSION})`)
      }
      for (const entry of Array.isArray(parsed?.roots) ? parsed.roots : []) {
        try {
          declared.push({ path: normalizeRootPath(entry?.path), label: String(entry?.label ?? ''), addedAt: entry?.addedAt ?? null })
        } catch (error) {
          warnings.push(`${file}: ${error.message}`)
        }
      }
    } catch (error) {
      warnings.push(`${file}: cannot parse (${error.message})`)
    }
  }

  const roots = []
  const seenPaths = new Set()
  const seenLabels = new Set()
  const add = (path, label, addedAt, primary_) => {
    if (seenPaths.has(path)) return
    let wanted = label
    if (wanted && !LABEL.test(wanted)) {
      warnings.push(`${file}: invalid label "${wanted}" for ${path}; using a derived one`)
      wanted = ''
    }
    if (wanted && seenLabels.has(wanted)) {
      const derived = labelFor(path, seenLabels)
      warnings.push(`${file}: label "${wanted}" is already taken; ${path} is "${derived}"`)
      wanted = derived
    }
    const final = wanted || labelFor(path, seenLabels)
    seenPaths.add(path)
    seenLabels.add(final)
    roots.push({ path, label: final, addedAt: addedAt ?? null, primary: Boolean(primary_) })
  }

  add(normalizeRootPath(primary), PRIMARY_LABEL, null, true)
  for (const entry of declared) add(entry.path, entry.label, entry.addedAt, false)
  return { path: file, exists: existsSync(file), roots, warnings }
}

/**
 * Add a root to the registry. Idempotent by path; a label collision is an error
 * (silently renaming a root would make scripts non-deterministic).
 * @returns {{path: string, label: string, addedAt: string|null, already: boolean, file: string}}
 */
export function registerRoot(primary, { path, label } = {}, env = process.env) {
  const registry = readRegistry(primary, env)
  const target = normalizeRootPath(path ?? primary)
  const existing = registry.roots.find((entry) => entry.path === target)
  if (existing) return { ...existing, already: true, file: registry.path }

  const wanted = validateLabel(label)
  if (wanted) {
    const clash = registry.roots.find((entry) => entry.label === wanted)
    if (clash) throw new Error(`label "${wanted}" is already used by ${clash.path}; pick another --label`)
  }
  const entry = {
    path: target,
    label: wanted || labelFor(target, new Set(registry.roots.map((item) => item.label))),
    addedAt: new Date().toISOString(),
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    roots: [...registry.roots.map(({ path, label, addedAt }) => ({ path, label, addedAt })), entry],
  }
  mkdirSync(dirname(registry.path), { recursive: true })
  writeFileSync(registry.path, `${JSON.stringify(payload, null, 2)}\n`)
  return { ...entry, already: false, file: registry.path }
}

/**
 * Resolve what a call means by "root": nothing (primary), a registered label,
 * or an explicit absolute path. Unknown labels fail loudly with the known ones
 * instead of silently building in the wrong toolchain.
 */
export function resolveRootRef(ref, { primary, env = process.env } = {}) {
  const base = normalizeRootPath(primary ?? resolveRoot({ env }))
  const text = String(ref ?? '').trim()
  if (!text) return base

  const registry = readRegistry(base, env)
  const byLabel = registry.roots.find((entry) => entry.label === text)
  if (byLabel) return byLabel.path

  if (isAbsolute(text)) {
    const path = normalizeRootPath(text)
    if (!existsSync(path)) throw new Error(`root does not exist: ${path}`)
    return path
  }
  const known = registry.roots.map((entry) => `${entry.label} (${entry.path})`).join(', ')
  throw new Error(`unknown root "${text}"; known roots: ${known}`)
}

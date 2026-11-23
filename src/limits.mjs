/**
 * Operator-tunable slot limits.
 *
 * The defaults assume a phone with ~1 GB of usable RAM: one build at a time.
 * A deployment that swaps the device, or that wants a shorter wait, can override
 * them without touching code:
 *
 *   /opt/android-toolchain/limits.json   (or $DSH_ANDROID_LIMITS)
 *   {"waitMs": 300000, "maxQueue": 5, "timeoutMs": 1800000, "nice": 19, "cpus": "0-3"}
 *
 * Invalid values are never fatal: the default is kept and a warning is surfaced
 * by `android_status` / `android-doctor`, so a typo cannot silently remove the
 * queue cap or the timeout.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Defaults for every build. */
export const DEFAULT_LIMITS = {
  waitMs: 120_000,
  maxQueue: 3,
  timeoutMs: 1_200_000,
  nice: 19,
  cpus: '0-3',
}

/** Accepted range for each numeric setting. */
const RANGES = {
  waitMs: [1_000, 3_600_000],
  maxQueue: [0, 10],
  timeoutMs: [60_000, 14_400_000],
  nice: [0, 19],
}

const CPU_LIST = /^(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*$/

export function limitsPath(root, env = process.env) {
  const explicit = (env.DSH_ANDROID_LIMITS ?? '').trim()
  return explicit || join(root, 'limits.json')
}

/**
 * Merge a raw object over the defaults.
 * @returns {{limits: typeof DEFAULT_LIMITS, warnings: string[]}}
 */
export function validateLimits(raw) {
  const warnings = []
  const limits = { ...DEFAULT_LIMITS }
  if (!raw || typeof raw !== 'object') return { limits, warnings }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_LIMITS)) {
      warnings.push(`${key}: unknown limit, ignored`)
      continue
    }
    if (key === 'cpus') {
      if (typeof value === 'string' && (value === '' || CPU_LIST.test(value))) limits.cpus = value
      else warnings.push(`${key}: expected a CPU list like "0-3" or "", got ${JSON.stringify(value)}`)
      continue
    }
    const [min, max] = RANGES[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      warnings.push(`${key}: expected an integer, got ${JSON.stringify(value)}`)
      continue
    }
    if (value < min || value > max) {
      warnings.push(`${key}: ${value} is outside ${min}..${max}, keeping ${DEFAULT_LIMITS[key]}`)
      continue
    }
    limits[key] = value
  }
  return { limits, warnings }
}

/** Read `<root>/limits.json` (or $DSH_ANDROID_LIMITS); never throws. */
export function loadLimits(root, env = process.env) {
  const file = limitsPath(root, env)
  if (!existsSync(file)) return { limits: { ...DEFAULT_LIMITS }, warnings: [], file: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const { limits, warnings } = validateLimits(parsed)
    return { limits, warnings, file }
  } catch (error) {
    return { limits: { ...DEFAULT_LIMITS }, warnings: [`${file}: cannot parse (${error.message})`], file }
  }
}

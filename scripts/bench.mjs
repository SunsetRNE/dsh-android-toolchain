#!/usr/bin/env node
/**
 * Cold/warm build timing through the single slot.
 *
 * "Cold" removes the project's build directory (Gradle caches stay warm, which
 * is what a fresh checkout feels like); "warm" runs again immediately. Both go
 * through runInSlot, so the numbers include queueing and limits exactly as a
 * real caller sees them.
 *
 * A recorded baseline in bench/baselines.json makes this a regression guard:
 * the measured time must stay under `baseline x factor` (with a floor so a very
 * fast baseline cannot make the check meaningless). CI runs it through
 * scripts/smoke.sh; `--update` is for a deliberate maintainer re-baseline.
 *
 * usage:
 *   node scripts/bench.mjs [project] [--task test] [--root ROOT]
 *                          [--baseline bench/baselines.json] [--factor 3]
 *                          [--max-cold-ms N] [--max-warm-ms N] [--update]
 *
 * exit: 0 within limits, 1 over a limit / build failed, 75 slot busy.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { binPath, resolveRoot } from '../src/paths.mjs'
import { buildEnv, withAapt2Override } from '../src/env.mjs'
import { runInSlot } from '../src/slot.mjs'
import { resolveRootRef } from '../src/roots.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BASELINE = join(HERE, '..', 'bench', 'baselines.json')
const DEFAULTS = { task: 'test', factor: 3, minColdMs: 120_000, minWarmMs: 60_000 }

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const [, val] = argv.splice(index, 2)
  return val
}
const has = (flag) => argv.includes(flag)

const task = value('--task') ?? DEFAULTS.task
const rootRef = value('--root')
const baselineFile = value('--baseline') ?? DEFAULT_BASELINE
const factor = Number(value('--factor') ?? DEFAULTS.factor)
const explicitCold = Number(value('--max-cold-ms') ?? '')
const explicitWarm = Number(value('--max-warm-ms') ?? '')
const update = has('--update')
const waitMs = Number(value('--wait-ms') ?? process.env.BENCH_WAIT_MS ?? 600_000)
const project = argv[0] ?? 'examples/junit-project'

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselineFile, 'utf8'))
  } catch {
    return null
  }
}

function limit(baseline, key, floor, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return { maxMs: explicit, source: 'command line' }
  if (baseline?.projects?.[project]?.[key]) {
    return { maxMs: Math.max(baseline.projects[project][key] * (baseline.factor ?? factor), floor), source: `baseline x${baseline.factor ?? factor}` }
  }
  return { maxMs: null, source: 'not recorded (report only)' }
}

const root = resolveRootRef(rootRef, { primary: resolveRoot({}) })
const gradle = binPath(root, 'gradle')
if (!existsSync(gradle)) {
  console.error(`[bench] gradle is not provisioned under ${root}; run android-provision`)
  process.exit(1)
}

const baseline = readBaseline()
const coldLimit = limit(baseline, 'coldMs', DEFAULTS.minColdMs, explicitCold)
const warmLimit = limit(baseline, 'warmMs', DEFAULTS.minWarmMs, explicitWarm)

async function measure(label) {
  const started = Date.now()
  const result = await runInSlot({
    root,
    cmd: gradle,
    args: withAapt2Override(root, [task]),
    cwd: project,
    env: buildEnv(root),
    owner: `bench:${label}`,
    timeoutMs: 1_800_000,
    waitMs,
  })
  return { label, durationMs: Date.now() - started, ...result }
}

const buildDir = join(project, 'build')
rmSync(buildDir, { recursive: true, force: true })
const cold = await measure('cold')
if (!cold.ok) {
  console.error(`[bench] cold build failed (exit ${cold.exitCode}${cold.busy ? ', slot busy' : ''})\n${cold.stderr?.slice(-2000) ?? ''}`)
  process.exit(cold.busy ? 75 : 1)
}
const warm = await measure('warm')
if (!warm.ok) {
  console.error(`[bench] warm build failed (exit ${warm.exitCode})\n${warm.stderr?.slice(-2000) ?? ''}`)
  process.exit(warm.busy ? 75 : 1)
}

const violations = []
if (coldLimit.maxMs !== null && cold.durationMs > coldLimit.maxMs) violations.push(`cold ${cold.durationMs}ms > ${Math.round(coldLimit.maxMs)}ms (${coldLimit.source})`)
if (warmLimit.maxMs !== null && warm.durationMs > warmLimit.maxMs) violations.push(`warm ${warm.durationMs}ms > ${Math.round(warmLimit.maxMs)}ms (${warmLimit.source})`)

const report = {
  project,
  task,
  root,
  coldMs: cold.durationMs,
  warmMs: warm.durationMs,
  limits: { cold: coldLimit, warm: warmLimit },
  baselineFile: baseline ? baselineFile : null,
  ok: violations.length === 0,
  violations,
}

if (update) {
  mkdirSync(dirname(baselineFile), { recursive: true })
  const next = baseline ?? { schemaVersion: 1, factor, projects: {} }
  next.projects ??= {}
  next.projects[project] = { coldMs: cold.durationMs, warmMs: warm.durationMs, recordedAt: new Date().toISOString() }
  writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`)
  report.updated = baselineFile
}

console.error(`[bench] ${project} cold=${cold.durationMs}ms warm=${warm.durationMs}ms -> ${report.ok ? 'ok' : 'OVER LIMIT'}`)
for (const violation of violations) console.error(`[bench] ${violation}`)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)

#!/usr/bin/env node
/**
 * Diagnose the shared area. `--full` also runs `gradle --version` (slow).
 * `--cache` measures cache sizes and writes a report (very slow on big caches).
 * `--root <label|path>` inspects a registered root other than the primary one.
 */
import { doctor } from '../src/doctor.mjs'
import { resolveRoot } from '../src/paths.mjs'
import { resolveRootRef } from '../src/roots.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}

let root
try {
  root = resolveRootRef(value('--root'), { primary: resolveRoot({}) })
} catch (error) {
  console.error(`[android-doctor] ${error.message}`)
  process.exit(1)
}

const report = doctor({ root, full: argv.includes('--full'), cache: argv.includes('--cache') })
console.log(JSON.stringify(report, null, 2))
if (report.warnings.length > 0) {
  for (const warning of report.warnings) console.error(`warn: ${warning}`)
}

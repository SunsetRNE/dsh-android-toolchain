#!/usr/bin/env node
/** Diagnose the shared area. `--full` also runs `gradle --version` (slow). */
import { doctor } from '../src/doctor.mjs'

const report = doctor({ full: process.argv.includes('--full') })
console.log(JSON.stringify(report, null, 2))
if (report.warnings.length > 0) {
  for (const warning of report.warnings) console.error(`warn: ${warning}`)
}

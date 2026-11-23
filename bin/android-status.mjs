#!/usr/bin/env node
/** Print the shared-area state and the single build slot as JSON. */
import { existsSync, readlinkSync } from 'node:fs'
import { currentPath, resolveRoot } from '../src/paths.mjs'
import { readSlotState } from '../src/slot.mjs'
import { loadLimits } from '../src/limits.mjs'
import { readHistory } from '../src/history.mjs'

const root = resolveRoot({})
const installed = {}
for (const name of ['jdk', 'gradle', 'kotlin', 'sdk', 'ndk']) {
  const current = currentPath(root, name)
  installed[name] = existsSync(current) ? readlinkSync(current) : null
}
const { limits, warnings, file } = loadLimits(root)
console.log(
  JSON.stringify({ root, limits, limitsFile: file, limitWarnings: warnings, slot: readSlotState(root), installed, recent: readHistory(root, 5) }, null, 2),
)

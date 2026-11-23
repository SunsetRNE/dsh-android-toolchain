#!/usr/bin/env node
/** Print the shared-area state and the single build slot as JSON. */
import { existsSync, readlinkSync } from 'node:fs'
import { currentPath, resolveRoot } from '../src/paths.mjs'
import { LIMITS, readSlotState } from '../src/slot.mjs'
import { readHistory } from '../src/history.mjs'

const root = resolveRoot({})
const installed = {}
for (const name of ['jdk', 'gradle', 'kotlin', 'sdk', 'ndk']) {
  const current = currentPath(root, name)
  installed[name] = existsSync(current) ? readlinkSync(current) : null
}
console.log(JSON.stringify({ root, limits: LIMITS, slot: readSlotState(root), installed, recent: readHistory(root, 5) }, null, 2))

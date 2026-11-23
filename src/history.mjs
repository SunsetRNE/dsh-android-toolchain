/**
 * Append-only build history (JSONL) under the shared area.
 *
 * Why a file and not memory: the broker process is disposable (the MCP client
 * probes and reconnects, subagents may spawn their own broker, the CLI writes
 * to the same slot). A file survives all of that and answers "who held the slot
 * and why did that build fail" after the fact.
 *
 * Kept small on purpose: at most HISTORY_LIMIT lines, trimmed on append when
 * the file grows past TRIM_BYTES.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPaths } from './paths.mjs'

export const HISTORY_LIMIT = 200
const TRIM_BYTES = 512 * 1024

export function historyPath(root) {
  return join(runPaths(root).runDir, 'history.jsonl')
}

/** Record one finished (or refused) build. Never throws: history is advisory. */
export function appendHistory(root, record) {
  try {
    const file = historyPath(root)
    mkdirSync(runPaths(root).runDir, { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    if (statSync(file).size > TRIM_BYTES) trimHistory(root)
  } catch {
    // A read-only or full disk must not fail a build.
  }
}

function trimHistory(root) {
  const file = historyPath(root)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT)
  writeFileSync(file, `${lines.join('\n')}\n`)
}

/** Newest-last slice of the history; invalid lines are skipped. */
export function readHistory(root, limit = 5) {
  const file = historyPath(root)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

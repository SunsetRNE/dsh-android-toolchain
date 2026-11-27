/**
 * On-demand usage guide for the toolchain.
 *
 * Deliberately not a skill and not a separate MCP server: a skill's catalog
 * entry and body would be injected into the model context on every session, and
 * another stdio server would be another resident process on a phone that
 * already gets killed by OEM policies. A single MCP tool reads this guide only
 * when the caller asks for it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GUIDE_PATH = 'docs/GUIDE.md'
export const GUIDE_TOPICS = ['overview', 'build', 'roots', 'limits', 'sign', 'install', 'troubleshooting', 'docs']

/** Split a guide by `## <topic>` headings; unknown headings are ignored. */
export function parseGuide(markdown) {
  const topics = {}
  let current = null
  for (const line of String(markdown ?? '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      // Any level-2 heading ends the previous topic; only kebab-case names are
      // addressable, so an unknown heading drops out instead of leaking into
      // the previous topic's body.
      const name = heading[1].toLowerCase()
      current = /^[a-z0-9-]+$/.test(name) ? name : null
      if (current) topics[current] = topics[current] ?? ''
      continue
    }
    if (current) topics[current] += `${line}\n`
  }
  for (const key of Object.keys(topics)) topics[key] = topics[key].trim()
  return topics
}

/**
 * Read one topic (or the overview) plus the available topic names.
 * @param {string} packageDir plugin package root (contains docs/)
 * @param {string} [topic]
 */
export function loadGuide(packageDir, topic) {
  const file = join(packageDir, GUIDE_PATH)
  if (!existsSync(file)) throw new Error(`guide is missing: ${file}`)
  const topics = parseGuide(readFileSync(file, 'utf8'))
  const names = Object.keys(topics)
  if (names.length === 0) throw new Error(`guide has no topics: ${file}`)

  const requested = String(topic ?? '').trim().toLowerCase()
  if (requested && topics[requested]) {
    return { topic: requested, topics: names, docs: join(packageDir, 'docs'), text: topics[requested] }
  }
  const fallback = topics.overview ?? topics[names[0]]
  return {
    topic: requested ? null : 'overview',
    requested: requested || null,
    topics: names,
    docs: join(packageDir, 'docs'),
    text: fallback,
    ...(requested && !topics[requested] ? { note: `unknown topic "${requested}"; showing overview` } : {}),
  }
}

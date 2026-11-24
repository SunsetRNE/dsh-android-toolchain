import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const LOCALES = ['en', 'zh']

function meta(language) {
  return JSON.parse(readFileSync(join(root, 'locale', `${language}.json`), 'utf8')).meta
}

/**
 * Plugin Manager treats a declared detail document as a contract: a missing
 * file, a malformed `meta.detail`, or anything but one image line shows an
 * error instead of the README fallback. Keep the docs packaged and minimal.
 */
test('every locale declares one detail document with exactly one image', () => {
  for (const language of LOCALES) {
    const fields = meta(language)
    assert.ok(fields.title, `${language}: meta.title is required`)
    assert.ok(fields.description, `${language}: meta.description is required`)
    assert.match(fields.detail, /^docs\/DETAIL(\.[a-z]{2})?\.md$/, `${language}: meta.detail must point at docs/DETAIL*.md`)

    const document = join(root, fields.detail)
    assert.ok(existsSync(document), `${fields.detail} is missing (a declared document must exist)`)
    const lines = readFileSync(document, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1, `${fields.detail}: exactly one image line, no headings or prose`)

    const image = /^!\[([^\]]+)\]\(([^)]+)\)$/.exec(lines[0])
    assert.ok(image, `${fields.detail}: must be a single markdown image line`)
    assert.ok(image[1].length >= 10, `${fields.detail}: alt text must describe the feature`)

    const asset = join(root, 'docs', image[2])
    assert.ok(existsSync(asset), `${image[2]} is missing`)
    const svg = readFileSync(asset, 'utf8')
    assert.match(svg, /^<svg\b/)
    assert.match(svg, /width="640" height="300"/)
    assert.match(svg, /viewBox="0 0 640 300"/)
    assert.ok(
      !/<(script|style|foreignObject|text|image)\b/.test(svg),
      `${image[2]}: feature images are self-contained (no text, script, style, foreignObject or embedded image)`,
    )
    assert.ok(statSync(asset).size <= 1024 * 1024, `${image[2]}: under the 1 MiB recommendation`)
  }
})

test('the package ships the detail documents, locales, patch and icon', () => {
  for (const entry of ['docs', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'index.js', 'bin', 'src']) {
    assert.ok(pkg.files.includes(entry), `files must keep "${entry}"`)
  }
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'docs', 'RUNBOOK.md')), 'the runbook ships with the package')
  assert.ok(existsSync(join(root, 'examples', 'signing', 'signing.gradle')), 'the signing template ships with the package')
})

/** Bumping this floor means re-running the runbook on that DSH release. */
test('the declared DSH compatibility range is the verified floor', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.2-rc.5')
})

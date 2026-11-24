import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'toolchain.manifest.json'), 'utf8'))
const setupApk = readFileSync(join(root, 'scripts', 'setup-apk.sh'), 'utf8')
const signing = readFileSync(join(root, 'src', 'signing.mjs'), 'utf8')
const bench = JSON.parse(readFileSync(join(root, 'bench', 'baselines.json'), 'utf8'))

const SHA256 = /^[0-9a-f]{64}$/

test('every enabled component is pinned to a sha256 over https', () => {
  const enabled = Object.entries(manifest.components).filter(([, spec]) => spec.enabled)
  assert.ok(enabled.length > 0, 'the manifest enables at least one component')
  for (const [name, spec] of enabled) {
    assert.match(spec.sha256, SHA256, `${name}: an enabled component must be pinned`)
    assert.match(spec.source, /^https:\/\//, `${name}: source should be https`)
  }
})

test('setup-apk.sh pins both archives and verifies the Termux index', () => {
  assert.match(setupApk, /CMDLINE_TOOLS_SHA256=[0-9a-f]{64}/, 'cmdline-tools must be pinned')
  assert.match(setupApk, /AAPT2_SHA256=[0-9a-f]{64}/, 'aapt2 must be pinned')
  // Dependency .debs are verified against the SHA256 published in the repository index.
  assert.match(setupApk, /\^SHA256: /, 'the index checksum is read')
  assert.match(setupApk, /sha256sum -c/, 'downloads are verified with sha256sum')
  // An index bump cannot silently change which aapt2 we run.
  assert.match(setupApk, /expected \$want/, 'the resolved filename must match AAPT2_VERSION')
})

test('no script evaluates code or pipes the network into a shell', () => {
  const files = []
  for (const dir of ['bin', 'src', 'scripts']) {
    for (const name of readdirSync(join(root, dir))) {
      if (/\.(mjs|sh)$/.test(name)) files.push(join(root, dir, name))
    }
  }
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!/\beval\s*\(/.test(text), `${file}: eval() is not allowed`)
    assert.ok(!/curl[^\n|]*\|\s*(?:sh|bash)\b/.test(text), `${file}: piping curl into a shell is not allowed`)
  }
})

test('signing never places a password on the command line', () => {
  assert.match(signing, /--ks-pass/)
  assert.match(signing, /env:\$\{KS_PASS_ENV\}/)
  assert.match(signing, /env:\$\{KEY_PASS_ENV\}/)
  assert.ok(
    !/['"]--ks-pass['"]\s*,\s*resolved\.storePassword/.test(signing),
    'the password itself must not be passed as an argument value',
  )
  assert.ok(
    !/console\.(?:log|error)\([^)]*storePassword/.test(signing),
    'the password must not be logged',
  )
})

test('the recorded performance baseline is usable as a regression guard', () => {
  assert.ok(bench.factor >= 2 && bench.factor <= 10, 'a factor of 2..10 keeps the guard meaningful')
  const project = bench.projects['examples/junit-project']
  assert.ok(project, 'the benchmarked project has a baseline')
  assert.ok(project.coldMs > 0 && project.warmMs > 0, 'cold and warm times are recorded')
})

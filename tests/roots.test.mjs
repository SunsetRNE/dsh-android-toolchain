import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { labelFor, readRegistry, registerRoot, registryPath, resolveRootRef } from '../src/roots.mjs'

const run = promisify(execFile)
const STATUS = fileURLToPath(new URL('../bin/android-status.mjs', import.meta.url))
const PROVISIONER = fileURLToPath(new URL('../bin/android-provision.mjs', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'android-roots-'))

test.after(() => rmSync(work, { recursive: true, force: true }))

/** A root that looks installed enough for `android_status` to describe it. */
function fakeRoot(name, versions = ['21']) {
  const root = join(work, name)
  for (const component of ['jdk', 'gradle']) {
    const version = versions[0]
    mkdirSync(join(root, component, version), { recursive: true })
    symlinkSync(version, join(root, component, 'current'))
  }
  return root
}

test('a registry without a file still reports the primary root', () => {
  const primary = fakeRoot('primary')
  const registry = readRegistry(primary)
  assert.deepEqual(registry.roots.map((entry) => entry.label), ['default'])
  assert.equal(registry.roots[0].primary, true)
  assert.equal(registry.exists, false)
  assert.equal(registryPath(primary), join(primary, 'roots.json'))
})

test('registering a root is idempotent and rejects label clashes', () => {
  const primary = fakeRoot('reg-primary')
  const second = fakeRoot('reg-second')

  const first = registerRoot(primary, { path: second, label: 'beta' })
  assert.equal(first.already, false)
  assert.equal(first.label, 'beta')

  const again = registerRoot(primary, { path: second, label: 'ignored' })
  assert.equal(again.already, true)
  assert.equal(again.label, 'beta', 'the existing label wins')

  assert.deepEqual(readRegistry(primary).roots.map((entry) => entry.label), ['default', 'beta'])
  assert.equal(JSON.parse(readFileSync(registryPath(primary), 'utf8')).schemaVersion, 1)

  const third = fakeRoot('reg-third')
  assert.throws(() => registerRoot(primary, { path: third, label: 'beta' }), /already used/)
  assert.throws(() => registerRoot(primary, { path: third, label: 'no spaces' }), /invalid label/)
})

test('labels are derived from the directory name when omitted', () => {
  const primary = fakeRoot('derive-primary')
  const target = fakeRoot('My Toolchain 2')
  const registered = registerRoot(primary, { path: target })
  assert.equal(registered.label, 'my-toolchain-2')
  assert.equal(labelFor('/x/foo'), 'foo')
})

test('root references resolve by default, label or absolute path', () => {
  const primary = fakeRoot('resolve-primary')
  const second = fakeRoot('resolve-second')
  registerRoot(primary, { path: second, label: 'beta' })

  assert.equal(resolveRootRef(undefined, { primary }), realpathSync(primary))
  assert.equal(resolveRootRef('default', { primary }), realpathSync(primary))
  assert.equal(resolveRootRef('beta', { primary }), realpathSync(second))
  assert.equal(resolveRootRef(second, { primary }), realpathSync(second))

  assert.throws(() => resolveRootRef('nope', { primary }), /unknown root "nope".*default.*beta/)
  assert.throws(() => resolveRootRef(join(work, 'missing'), { primary }), /does not exist/)
  assert.throws(() => resolveRootRef('relative/root', { primary }), /unknown root/)
})

test('android-status --all summarizes every registered root', async () => {
  const primary = fakeRoot('all-primary')
  const second = fakeRoot('all-second')
  registerRoot(primary, { path: second, label: 'second' })
  writeFileSync(join(second, 'limits.json'), JSON.stringify({ maxQueue: 5 }))

  const { stdout } = await run(process.execPath, [STATUS, '--all'], {
    env: { ...process.env, DSH_ANDROID_ROOT: primary },
  })
  const payload = JSON.parse(stdout)
  assert.equal(payload.registryExists, true)
  assert.equal(payload.roots.length, 2)
  const labels = payload.roots.map((entry) => entry.label)
  assert.deepEqual(labels, ['default', 'second'])
  const secondary = payload.roots.find((entry) => entry.label === 'second')
  assert.equal(secondary.root, realpathSync(second))
  assert.equal(secondary.installed.jdk, '21')
  assert.equal(secondary.limits.maxQueue, 5, 'each root keeps its own limits file')
  const primaryEntry = payload.roots.find((entry) => entry.primary)
  assert.equal(primaryEntry.limits.maxQueue, 3)
})

test('android-status rejects an unknown root instead of guessing', async () => {
  const primary = fakeRoot('status-unknown')
  let failed = false
  try {
    await run(process.execPath, [STATUS, '--root', 'ghost'], { env: { ...process.env, DSH_ANDROID_ROOT: primary } })
  } catch (error) {
    failed = true
    assert.match(error.stderr, /unknown root "ghost"/)
  }
  assert.equal(failed, true)
})

async function sha256file(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject)
  })
  return hash.digest('hex')
}

/** A root with a matching archive already in tmp/, plus a source URL that must not be used. */
async function cachedArchive() {
  const stage = join(work, 'reuse-stage')
  const payload = join(stage, 'jdk-21', 'bin')
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, 'java'), '#!/bin/sh\necho "openjdk version 21-test"\n')
  chmodSync(join(payload, 'java'), 0o755)
  const archive = join(work, 'jdk-reuse.tar.gz')
  await run('tar', ['-czf', archive, '-C', stage, 'jdk-21'])
  return { archive, digest: await sha256file(archive) }
}

test('provision --reuse-from copies another root\'s archive instead of downloading', async () => {
  const { archive, digest } = await cachedArchive()
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end('must not be called')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const source = join(work, 'reuse-source')
    mkdirSync(join(source, 'tmp'), { recursive: true })
    const cached = join(source, 'tmp', 'jdk-21.tar.gz')
    writeFileSync(cached, readFileSync(archive))

    const target = join(work, 'reuse-target')
    const manifestPath = join(work, 'reuse-manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        components: {
          jdk: { enabled: true, version: '21', source: `http://127.0.0.1:${port}/jdk.tar.gz`, archive: 'tar.gz', sha256: digest, provides: ['java'] },
        },
        gradleUserHome: {},
      }),
    )

    const { stdout } = await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', target, '--reuse-from', source, '--no-link'])
    assert.match(stdout, /reused/)
    assert.equal(requests, 0, 'the source URL must not be fetched')
    assert.ok(existsSync(join(target, 'jdk', '21', '.installed.json')), 'component installed from the reused archive')
    assert.equal(JSON.parse(readFileSync(join(target, 'jdk', '21', '.installed.json'), 'utf8')).sha256, digest)
  } finally {
    server.close()
  }
})

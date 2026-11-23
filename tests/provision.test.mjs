import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const PROVISIONER = fileURLToPath(new URL('../bin/android-provision.mjs', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'android-provision-'))

test.after(() => rmSync(work, { recursive: true, force: true }))

async function sha256file(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject)
  })
  return hash.digest('hex')
}

/** A tiny "JDK" archive: <stage>/jdk-21/bin/java that prints a version. */
async function makeArchive() {
  const stage = join(work, 'stage')
  const payload = join(stage, 'jdk-21', 'bin')
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, 'java'), '#!/bin/sh\necho "openjdk version 21-test"\n')
  chmodSync(join(payload, 'java'), 0o755)
  const archive = join(work, 'jdk.tar.gz')
  await run('tar', ['-czf', archive, '-C', stage, 'jdk-21'])
  return { archive, digest: await sha256file(archive) }
}

function manifestFor(url, sha256) {
  return {
    schemaVersion: 1,
    components: {
      jdk: { enabled: true, version: '21', source: url, archive: 'tar.gz', sha256, provides: ['java'] },
    },
    gradleUserHome: {},
  }
}

async function startServer() {
  const { archive, digest } = await makeArchive()
  const body = readFileSync(archive)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, digest, url: `http://127.0.0.1:${port}/jdk.tar.gz` }
}

test('provision installs, links, and is idempotent', async () => {
  const { server, digest, url } = await startServer()
  try {
    const root = join(work, 'root-ok')
    const manifestPath = join(work, 'manifest-ok.json')
    writeFileSync(manifestPath, JSON.stringify(manifestFor(url, digest)))

    const first = await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link'])
    assert.match(first.stdout, /jdk@21: installed/)

    assert.ok(existsSync(join(root, 'jdk', '21', '.installed.json')), 'marker written')
    assert.ok(lstatSync(join(root, 'jdk', 'current')).isSymbolicLink(), 'current symlink')
    assert.equal(lstatSync(join(root, 'jdk', 'current')).isSymbolicLink(), true)

    const { stdout } = await run(join(root, 'bin', 'java'))
    assert.equal(stdout.trim(), 'openjdk version 21-test')

    const second = await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link'])
    assert.match(second.stdout, /already installed/)
  } finally {
    server.close()
  }
})

test('a sha256 mismatch installs nothing and exits non-zero', async () => {
  const { server, url } = await startServer()
  try {
    const root = join(work, 'root-bad')
    const manifestPath = join(work, 'manifest-bad.json')
    writeFileSync(manifestPath, JSON.stringify(manifestFor(url, '0'.repeat(64))))
    let failed = false
    try {
      await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link'])
    } catch (error) {
      failed = true
      assert.equal(error.code, 1)
      assert.match(error.stderr, /sha256 mismatch/)
    }
    assert.equal(failed, true)
    assert.equal(existsSync(join(root, 'jdk', '21')), false)
  } finally {
    server.close()
  }
})

test('an unpinned component is refused unless explicitly allowed', async () => {
  const { server, url } = await startServer()
  try {
    const root = join(work, 'root-unpinned')
    const manifestPath = join(work, 'manifest-unpinned.json')
    writeFileSync(manifestPath, JSON.stringify(manifestFor(url, '')))
    let failed = false
    try {
      await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link'])
    } catch (error) {
      failed = true
      assert.match(error.stderr, /sha256 is not pinned/)
    }
    assert.equal(failed, true)
  } finally {
    server.close()
  }
})

test('--dry-run writes nothing', async () => {
  const root = join(work, 'root-dry')
  const manifestPath = join(work, 'manifest-dry.json')
  writeFileSync(manifestPath, JSON.stringify(manifestFor('https://example.invalid/jdk.tar.gz', 'a'.repeat(64))))
  const { stdout } = await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link', '--dry-run'])
  assert.match(stdout, /would install/)
  assert.equal(existsSync(join(root, 'bin')), false)
  assert.equal(existsSync(join(root, 'jdk')), false)
})

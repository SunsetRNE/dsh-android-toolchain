import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const PROVISIONER = fileURLToPath(new URL('../bin/android-provision.mjs', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'android-zip-'))

test.after(() => rmSync(work, { recursive: true, force: true }))

async function sha256file(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * Regression: `python3 -m zipfile` drops executable bits, which broke
 * `gradle/bin/gradle` (and every JDK tool shipped as a zip). The provisioner
 * restores the mode from the zip entry, so the extracted launcher must run.
 */
test('zip extraction preserves the executable bit', async () => {
  const archive = join(work, 'gradle.zip')
  const script = 'import sys, zipfile\nentry = zipfile.ZipInfo("gradle-8.0/bin/gradle")\nentry.external_attr = 0o755 << 16\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    z.writestr(entry, "#!/bin/sh\\necho gradle-zip-ok\\n")\n'
  await run('python3', ['-c', script, archive])
  const digest = await sha256file(archive)

  const body = readFileSync(archive)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const root = join(work, 'root')
    const manifestPath = join(work, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        components: {
          gradle: {
            enabled: true,
            version: '8.0',
            source: `http://127.0.0.1:${port}/gradle.zip`,
            archive: 'zip',
            sha256: digest,
            provides: ['gradle'],
          },
        },
        gradleUserHome: {},
      }),
    )
    await run(process.execPath, [PROVISIONER, '--manifest', manifestPath, '--root', root, '--no-link'])
    assert.ok(existsSync(join(root, 'bin', 'gradle')), 'launcher written')
    const { stdout } = await run(join(root, 'bin', 'gradle'))
    assert.equal(stdout.trim(), 'gradle-zip-ok')
  } finally {
    server.close()
  }
})

#!/usr/bin/env node
/** Print one root, or every registered root with `--all`, as JSON. */
import { resolveRoot } from '../src/paths.mjs'
import { describeAllRoots, describeRoot } from '../src/inspect.mjs'
import { registryPath, resolveRootRef } from '../src/roots.mjs'

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}

const primary = resolveRoot({})

if (argv.includes('--all')) {
  console.log(JSON.stringify(describeAllRoots(primary), null, 2))
} else {
  let root
  try {
    root = resolveRootRef(value('--root'), { primary })
  } catch (error) {
    console.error(`[android-status] ${error.message}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ...describeRoot(root), registry: registryPath(primary) }, null, 2))
}

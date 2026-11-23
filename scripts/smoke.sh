#!/bin/sh
# End-to-end smoke: provision the shared toolchain, set up APK tooling, build the
# example APK, run the example JUnit project, and assert the architecture.
#
# Runs on a device (this repo's own maintenance flow) and on the arm64 CI runner:
#   sh scripts/smoke.sh
#   sudo env "PATH=$PATH" DSH_ANDROID_ROOT=/opt/android-toolchain sh scripts/smoke.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${DSH_ANDROID_ROOT:-/opt/android-toolchain}
cd "$REPO"

say() { printf '[smoke] %s\n' "$*"; }

[ -d examples/hello-apk ] || { say "examples/hello-apk is missing"; exit 1; }
[ -d examples/junit-project ] || { say "examples/junit-project is missing"; exit 1; }

say "root: $ROOT"
node bin/android-provision.mjs

say "APK toolchain (cmdline-tools + platform + arm64 aapt2)"
sh scripts/setup-apk.sh

say "build the example APK"
node bin/android-build.mjs assembleDebug --cwd examples/hello-apk --timeout 900000

APK=examples/hello-apk/app/build/outputs/apk/debug/app-debug.apk
[ -f "$APK" ] || { say "expected $APK after assembleDebug"; exit 1; }
say "APK: $(wc -c < "$APK") bytes"

say "run the example tests"
node bin/android-test.mjs --cwd examples/junit-project --timeout 900000

say "architecture and signing readiness"
node bin/android-doctor.mjs > /tmp/android-toolchain-doctor.json
node -e '
const d = require("/tmp/android-toolchain-doctor.json")
const fail = (message) => { console.error("[smoke] " + message); process.exit(1) }
if (d.checks.java.arch !== "aarch64") fail("java is " + d.checks.java.arch + ", not aarch64")
if (!d.checks.aapt2.version) fail("aapt2 is not installed")
if (!d.checks.apksigner.path) fail("apksigner.jar is missing")
console.log("[smoke] java:", d.checks.java.version)
console.log("[smoke] aapt2:", d.checks.aapt2.version)
console.log("[smoke] platforms:", d.checks.sdk.platforms.join(","))
' || exit 1

say "ok"

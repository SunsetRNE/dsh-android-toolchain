#!/bin/sh
# End-to-end smoke. Two modes because the APK path cannot run on a plain Linux
# host:
#
#   sh scripts/smoke.sh           # device: full (provision + APK + JUnit + arch)
#   sh scripts/smoke.sh --jvm     # host: provision + JUnit + doctor (no APK)
#
# Why: the arm64 aapt2 we ship is Termux's bionic build and needs
# /system/bin/linker64, which only exists on an Android device. GitHub's Ubuntu
# arm64 runner has no Android userland, so `--jvm` is the CI baseline and the
# APK path is gated by the full mode on a real device.
set -eu

MODE=${1:-device}
case "$MODE" in
  device|--jvm) ;;
  *) echo "usage: $0 [--jvm]" >&2; exit 64 ;;
esac

REPO=$(cd "$(dirname "$0")/.." && pwd)
ROOT=${DSH_ANDROID_ROOT:-/opt/android-toolchain}
cd "$REPO"

say() { printf '[smoke] %s\n' "$*"; }

[ -d examples/hello-apk ] || { say "examples/hello-apk is missing"; exit 1; }
[ -d examples/junit-project ] || { say "examples/junit-project is missing"; exit 1; }

WAIT_MS=${SMOKE_WAIT_MS:-600000}

say "mode: $MODE | root: $ROOT | slot wait: ${WAIT_MS}ms"
node bin/android-provision.mjs

case "$MODE" in
  device) sh scripts/setup-apk.sh ;;
  --jvm) sh scripts/setup-apk.sh --no-aapt2 ;;
esac

if [ "$MODE" = "device" ]; then
  say "build the example APK"
  node bin/android-build.mjs assembleDebug --cwd examples/hello-apk --timeout 900000 --wait "$WAIT_MS"
  APK=examples/hello-apk/app/build/outputs/apk/debug/app-debug.apk
  [ -f "$APK" ] || { say "expected $APK after assembleDebug"; exit 1; }
  say "APK: $(wc -c < "$APK") bytes"
else
  say "skipping the APK build (no Android aapt2 on a plain Linux host)"
fi

say "run the example tests"
node bin/android-test.mjs --cwd examples/junit-project --timeout 900000 --wait "$WAIT_MS"

say "performance baseline (cold/warm)"
node scripts/bench.mjs examples/junit-project --wait-ms "$WAIT_MS"

say "architecture and toolchain assertions"
node bin/android-doctor.mjs > /tmp/android-toolchain-doctor.json
SMOKE_MODE="$MODE" node -e '
const d = require("/tmp/android-toolchain-doctor.json")
const mode = process.env.SMOKE_MODE
const fail = (message) => { console.error("[smoke] " + message); process.exit(1) }
if (d.checks.java.arch !== "aarch64") fail("java is " + d.checks.java.arch + ", not aarch64")
if (!d.checks.apksigner.path) fail("apksigner.jar is missing")
if (!d.checks.sdk.platforms.length) fail("no Android platform installed")
if (mode === "device" && !d.checks.aapt2.version) fail("aapt2 is not installed")
console.log("[smoke] java:", d.checks.java.version)
if (d.checks.aapt2.version) console.log("[smoke] aapt2:", d.checks.aapt2.version)
console.log("[smoke] platforms:", d.checks.sdk.platforms.join(","))
'

say "ok ($MODE)"

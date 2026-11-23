#!/bin/sh
# APK toolchain setup for aarch64 proot (idempotent).
#
# What it does:
#   1. Android cmdline-tools (Java, arch-independent) -> <root>/sdk/cmdline-tools/latest
#   2. platforms;android-35 + build-tools;35.0.0 via sdkmanager (accepted licenses)
#   3. arm64 aapt2 from the Termux repository (bionic-linked) + its libraries,
#      wrapped so AGP can call it through the Android linker:
#        <root>/aapt2/current/bin/aapt2 -> /system/bin/linker64 + LD_LIBRARY_PATH
#
# Why: Google Maven only ships aapt2 for linux/osx/windows x86_64 and AGP always
# resolves it from there. `android-build` passes
# -Pandroid.aapt2FromMavenOverride=<root>/aapt2/current/bin/aapt2 automatically,
# so no project change is needed.
#
# Trust: the aapt2 .deb is pinned by sha256 below; libraries come from the same
# signed Termux repository. Re-pin deliberately when bumping AAPT2_VERSION.
set -eu

# --no-aapt2: install cmdline-tools/platform/build-tools only. Used on plain
# Linux arm64 (CI), where the Termux aapt2 cannot run because it needs the
# Android bionic loader at /system/bin/linker64.
NO_AAPT2=0
[ "${1:-}" = "--no-aapt2" ] && NO_AAPT2=1

ROOT=${DSH_ANDROID_ROOT:-/opt/android-toolchain}
SDK="$ROOT/sdk"
CACHE="$ROOT/tmp"
TERMUX=https://packages.termux.dev/apt/termux-main
AAPT2_VERSION=16.0.0.4-4
AAPT2_SHA256=1b3e4d716670d78fed4a66e04a1ba92827a36fe3000e9bef98208392f3100050
AAPT2_DEPS="abseil-cpp libc++ libprotobuf fmt libexpat libpng libzopfli zlib"
PLATFORM=android-35
BUILD_TOOLS=35.0.0

say() { printf '[setup-apk] %s\n' "$*"; }
die() { say "error: $*"; exit 1; }

[ -w "$ROOT" ] || mkdir -p "$ROOT" 2>/dev/null || die "$ROOT is not writable; set DSH_ANDROID_ROOT"
mkdir -p "$CACHE" "$SDK"
export JAVA_HOME="$ROOT/jdk/current"
[ -x "$JAVA_HOME/bin/java" ] || die "no JDK under $JAVA_HOME (run android-provision first)"
export PATH="$JAVA_HOME/bin:$PATH"

# 1. cmdline-tools
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  zip="$CACHE/commandlinetools-linux.zip"
  [ -f "$zip" ] || curl -fsSL -o "$zip" "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  say "extracting cmdline-tools"
  rm -rf "$CACHE/cmdline-tools"
  mkdir -p "$CACHE/cmdline-tools"
  python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$CACHE/cmdline-tools"
  mkdir -p "$SDK/cmdline-tools/latest"
  cp -a "$CACHE/cmdline-tools/cmdline-tools/." "$SDK/cmdline-tools/latest/"
  chmod +x "$SDK/cmdline-tools/latest/bin/"* 2>/dev/null || true
fi
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
[ -x "$SDKMANAGER" ] || die "sdkmanager missing after extraction"

# 2. licenses + platform/build-tools
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
if [ ! -f "$SDK/platforms/$PLATFORM/android.jar" ] || [ ! -d "$SDK/build-tools/$BUILD_TOOLS" ]; then
  say "installing platforms;$PLATFORM and build-tools;$BUILD_TOOLS"
  yes | "$SDKMANAGER" --sdk_root="$SDK" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" >/dev/null
fi

# 3. arm64 aapt2 (Termux) + wrapper
if [ "$NO_AAPT2" = "1" ]; then
  say "skipping the Android aapt2 (needs /system/bin/linker64; CI uses the Maven aapt2)"
elif [ ! -x "$ROOT/aapt2/current/bin/aapt2" ]; then
  index="$CACHE/termux-Packages"
  [ -f "$index" ] || curl -fsSL -o "$index" "$TERMUX/dists/stable/main/binary-aarch64/Packages"
  mkdir -p "$CACHE/termux-debs" "$CACHE/termux-x"
  fetch() {
    name=$1
    file=$(awk -v p="$name" '$0 == "Package: " p { found = 1 } found && /^Filename: / { print $2; exit }' "$index")
    [ -n "$file" ] || die "cannot resolve Termux package $name"
    target="$CACHE/termux-debs/$(basename "$file")"
    [ -f "$target" ] || curl -fsSL -o "$target" "$TERMUX/$file"
    out="$CACHE/termux-x/$(basename "$file" .deb)"
    [ -d "$out" ] || { mkdir -p "$out"; dpkg-deb -x "$target" "$out"; }
  }
  fetch aapt2
  deb="$CACHE/termux-debs/aapt2_${AAPT2_VERSION}_aarch64.deb"
  [ -f "$deb" ] || die "expected $deb"
  echo "$AAPT2_SHA256  $deb" | sha256sum -c - >/dev/null || die "aapt2 sha256 mismatch"
  for dep in $AAPT2_DEPS; do fetch "$dep"; done

  prefix="$ROOT/aapt2/$AAPT2_VERSION"
  rm -rf "$prefix"
  mkdir -p "$prefix/bin" "$prefix/lib"
  cp "$CACHE/termux-x/aapt2_${AAPT2_VERSION}_aarch64/data/data/com.termux/files/usr/bin/aapt2" "$prefix/bin/aapt2.bin"
  for dir in "$CACHE"/termux-x/*/data/data/com.termux/files/usr/lib; do
    [ -d "$dir" ] && cp -a "$dir/." "$prefix/lib/"
  done
  chmod +x "$prefix/bin/aapt2.bin"
  cat > "$prefix/bin/aapt2" <<'WRAPPER'
#!/bin/sh
PREFIX="$(cd "$(dirname "$0")/.." && pwd)"
exec env LD_LIBRARY_PATH="$PREFIX/lib" /system/bin/linker64 "$PREFIX/bin/aapt2.bin" "$@"
WRAPPER
  chmod +x "$prefix/bin/aapt2"
  ln -sfn "$AAPT2_VERSION" "$ROOT/aapt2/current"
  ln -sfn ../aapt2/current/bin/aapt2 "$ROOT/bin/aapt2"
fi

AAPT2="$ROOT/aapt2/current/bin/aapt2"
if [ "$NO_AAPT2" = "0" ]; then
  version=$("$AAPT2" version 2>&1 | grep -i "aapt" | tail -n1)
  case "$version" in
    *aapt*) say "aapt2: $version" ;;
    *) die "aapt2 did not run: $version" ;;
  esac
fi

say "SDK: $SDK (platforms/$PLATFORM, build-tools/$BUILD_TOOLS)"
if [ "$NO_AAPT2" = "0" ]; then
  say "use: android-build assembleDebug --cwd <project>"
  say "android-build injects -Pandroid.aapt2FromMavenOverride=$AAPT2"
else
  say "use: android-build assembleDebug --cwd <project> (aapt2 comes from Google Maven)"
fi

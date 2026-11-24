# Signing template

Two ways to sign a release APK on this device. Both keep the password out of
the repository and out of the conversation.

## A. Toolchain signing (recommended for agent builds)

Sign after `assembleDebug`; the keystore stays outside the project.

```sh
android-sign app/build/outputs/apk/debug/app-debug.apk --out app-release.apk
```

Configuration lives in `<root>/signing.json` (chmod 600) or the `ANDROID_*`
environment variables; the tool never accepts a password as an argument.
Password files are passed as `--ks-pass env:...`, so they cannot appear in
`ps`. See [the runbook](../../docs/RUNBOOK.md#6-签名两种方式密码都不进仓库对话).

## B. In-project signing (release builds from Gradle/IDE)

1. Copy `signing.gradle` to your project root.
2. Copy `keystore.properties.example` to `keystore.properties`, fill it in,
   and run `chmod 600 keystore.properties`.
3. Add both `keystore.properties` and `*.jks` to `.gitignore`.
4. In `app/build.gradle`, after the `com.android.application` plugin:

   ```groovy
   apply from: "$rootDir/signing.gradle"
   ```

5. Build and verify:

   ```sh
   android-build assembleRelease --cwd .
   <root>/sdk/build-tools/35.0.0/lib/apksigner.jar verify --print-certs \
     app/build/outputs/apk/release/app-release.apk
   ```

If `keystore.properties` is absent and no `ANDROID_*` variables are set, the
template leaves `signingConfigs.release` empty: a release build still works but
is unsigned, so a missing keystore never breaks `assembleDebug`.

## CI

Set `ANDROID_KEYSTORE`, `ANDROID_KEY_ALIAS` and `ANDROID_KEYSTORE_PASSWORD`
(plus `ANDROID_KEY_PASSWORD` when it differs) as secrets. Never commit a
`keystore.properties` produced by a CI run.

# Examples

Small, dependency-light projects that double as copyable templates. The smoke
test builds them on a real device; CI runs the JVM one.

- `hello-apk/` — smallest `com.android.application` module (AGP 8.7.3, compileSdk 35,
  minSdk 24). Proves the arm64 aapt2 override, platform and build-tools wiring.
- `junit-project/` — plain Java project with one JUnit 4 test. Proves the test
  summary path (`android-test` reads JUnit XML).
- `signing/` — `signing.gradle` + `keystore.properties.example` for release
  signing; a template, not a build target (see its README and
  [docs/RUNBOOK.md](../docs/RUNBOOK.md)).

Start a new app by copying the template:

```sh
cp -r examples/hello-apk ~/myapp
rm -rf ~/myapp/.gradle ~/myapp/app/build   # drop local build state
android-build assembleDebug --cwd ~/myapp
```

Then edit `applicationId` / `namespace` in `app/build.gradle`; nothing else is
required. All projects stay dependency-light (AGP / JUnit only), so a cold CI
run does not download an ecosystem.

The templates are meant to be edited: they are the "copy a project and build"
path from the runbook, not a library.

# Examples

Two minimal projects the smoke test builds on a real device or runner:

- `hello-apk/` — smallest `com.android.application` module (AGP 8.7.3, compileSdk 35,
  minSdk 24). Proves the arm64 aapt2 override, platform and build-tools wiring.
- `junit-project/` — plain Java project with one JUnit 4 test. Proves the test
  summary path (`android-test` reads JUnit XML).

They are deliberately dependency-light: no AndroidX, no Compose, no Kotlin, so a
cold CI run downloads only AGP and JUnit.

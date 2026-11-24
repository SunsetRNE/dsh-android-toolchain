# 性能基线

目的：防止“还能编译，但慢了一个数量级”的回归——比如 Gradle daemon 被关掉、构建缓存被绕过、单槽退化成串行等待。功能测试抓不到这类问题。

## 怎么测

```sh
node scripts/bench.mjs examples/junit-project            # 用仓库基线判定
node scripts/bench.mjs examples/junit-project --update   # 重新记录基线（review diff 后提交）
```

- **冷** = 删除项目的 `build/` 目录后构建（Gradle 缓存保留，等价于新 checkout）；
- **热** = 紧接着再构建一次；
- 两次都经 `runInSlot`，所以数字包含排队与 limits，和真实调用一致；
- 输出 JSON（`coldMs` / `warmMs` / `limits` / `violations`），人类可读行写 stderr。

## 阈值

`bench/baselines.json` 记录设备实测值，允许 `factor` 倍（默认 **3×**），并带地板值（冷 **120 s**、热 **60 s**）避免 CI 抖动误报：

```
上限 = max(基线 × factor, 地板)
```

超过上限时 `scripts/bench.mjs` 退出 1，`scripts/smoke.sh` 随之失败（= CI 报警）。

## 已记录基线

设备：aarch64 proot，JDK 21.0.5+11，Gradle 8.10.2（2026-11-24）

| 项目 | 冷 | 热 |
|---|---|---|
| `examples/junit-project` | **17.8 s** | **3.5 s** |
| `examples/hello-apk` | 约 2 min（含 AGP 依赖下载，见 README 实测表） | 约 39 s（缓存命中） |

## 重新基线的规则

1. 只在下述情况更新：设备/工具链/DSH 大版本变化，或确认是合理的性能变化。
2. `--update` 后检查 `bench/baselines.json` 的 diff，和提交一起说明原因。
3. 不要为了“让 CI 绿”抬高基线；先查清变慢的原因（`android-doctor`、`android-status.recent` 的 `durationMs`、`gradle --version`、daemon 数量）。

## 已知限制

- 只把 JVM 示例作为阻塞阈值；APK 冷构建依赖 AGP 下载，网络波动会污染数字，只做人工参考。
- GitHub arm64 runner 与手机性能不同，地板值保证不会误报；它抓的是数量级回归，不是 10% 抖动。

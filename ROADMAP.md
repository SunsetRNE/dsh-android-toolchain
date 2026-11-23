# ROADMAP

长期目标：让**任何 DSH 会话**在这台 aarch64 设备上都能可靠地编译、打包、安装 Android 产物，而不需要各自准备环境、也不会因为并发把设备拖垮。

分阶段推进，每个阶段都能独立发布、独立回滚；**阶段之间不并行开工**，一次只做一件事。

## 0. 已交付（0.1.x）

- 共享区供应：JDK 21 (aarch64) + Gradle 8.10.2，pin sha256，幂等
- 单槽 broker：`flock` 跨进程互斥、排队上限、超时、nice/CPU 限制
- MCP 全局工具：`android_status` / `android_doctor` / `android_provision` / `android_build`
- APK：`setup-apk.sh`（cmdline-tools + platform 35 + build-tools + Termux arm64 aapt2 覆盖），真机 `assembleDebug` 通过
- 分发：GitHub Release tarball + `SHA256SUMS`（无 npm）；`dsha-plugin import` 安装
- 展示：图标 + 中英 locale 元数据
- 全局约定：`~/.dsh/AGENTS.md` 索引

## 1. 可观测与稳定（0.2）

**为什么**：多会话长期运行后，最有价值的问题不是“能不能编译”，而是“刚才那次为什么排队/失败”。

- [x] `run/history.jsonl`：最近 200 次构建记录（id、owner、cwd、等待/耗时、退出码、超时、busy）
- [x] `android_status` 返回 `recent`（默认 5 条），`android_build` 返回 `buildId`
- [x] `android-build` CLI 输出 build id，便于和日志对齐
- [x] `doctor` 增加：Gradle daemon 数量、最近 3 条构建
- [x] 状态归一（`ok` / `failed` / `timeout` / `busy` / `queue-full` / `error`），文档化
- [ ] `doctor` 缓存体积统计与清理建议（下一轮）

**验收**：并发 5 个构建（3 个排队、2 个被拒）后，`android_status.recent` 能完整还原这 5 条，且每条可定位到 owner 与结果。

## 2. 交付链路（0.3）

**为什么**：现在只到“产出 APK”，安装到手机、签名发布、跑单测还要人工。

- [x] `android_test`：Gradle `test`（JVM 单测），走同一槽位，汇总 JUnit XML（0.3.0）
- [x] `android_sign`：release keystore（路径 + 别名从环境/凭据读取，**不进日志**）、`apksigner.jar` 签名与验证（0.3.1）
- [ ] `android_install`：经 `adb-shell`（守卫通道）安装 APK 到当前用户，禁止 `pm` 直连
- [ ] 失败时给出可操作错误（未授权 adb、签名不匹配、minSdk 冲突）

**验收**：一条命令完成 `assembleDebug → sign → install → 启动`，且 `android_status` 有对应记录；keystore 不在日志/仓库中出现。

## 3. CI 回归保护（0.4）

**为什么**：APK 路径（aapt2 包装、SDK 布局、脚本）目前没有自动化守卫，改坏只能靠人肉发现。

- [ ] 公共仓库的 `ubuntu-24.04-arm` runner 上跑 `setup-apk.sh` + 示例项目 `assembleDebug`
- [ ] 缓存 SDK / aapt2 / Gradle 依赖，控制 CI 时长
- [ ] manifest 变更守卫：源可达 + sha256 变化必须显式更新
- [ ] 版本兼容矩阵：DSH 0.2.x 各 rc 的 MCP/插件契约

**验收**：PR 改动 `scripts/`、`toolchain.manifest.json`、`bin/` 时 CI 能真实构建成功；失败信息指向具体步骤。

## 4. 可配置与多实例（0.5）

- [ ] 槽数/排队/超时/nice/CPU 从 DSH 设置读取（保留默认值）
- [ ] `<root>` 注册表：一台设备多套工具链（不同 JDK/NDK 版本）时各自锁分片
- [ ] `android_status --all` 汇总所有 root 的槽位与版本
- [ ] 迁移命令：`android-provision --root` 之间搬移/复用缓存

**验收**：两个 root 同时构建互不阻塞；设置改动无需重启 Web 即生效。

## 5. 文档与生态（0.6）

- [ ] `docs/DETAIL.zh.md` + `DETAIL.md` + 640×300 特性图（工具卡详情页）
- [ ] 示例工程仓库（最小 AGP app、JVM 单测、签名配置）作为可复制的模板
- [ ] 从零到 APK 的完整 runbook（含失败排查分支）
- [ ] 与 `dsh-doc` 一致的能力声明（`dsh` 版本范围、配置项说明）

**验收**：新设备按 runbook 从零到 `assembleDebug` 成功，全程不需要读源码。

## 6. 1.0 硬化

- 兼容性声明与升级/回滚路径（插件升级不丢工具链、工具链升级不炸插件）
- 安全审计：所有下载点 sha256、脚本不含动态执行、keystore 仅本地读取
- 性能基线：冷/热构建耗时回归阈值，超阈值 CI 报警
- 明确不支持项写入 README：npm 分发（注册受阻）、本地 NDK/C++ 编译、跨用户隔离

## 明确不做

- **不从 npm 分发**：维护者无法完成 npm 注册（人机验证弹窗不可用），只走 GitHub Release tarball
- **不在本地做 NDK/C++ 编译**：NDK 主机工具链只有 x86_64；需要时交给远程构建机
- **不把工具链塞进 profile/workspace**：插件升级或清理工作区不能影响工具链
- **不做多用户/多租户隔离**：单设备单维护者场景，锁足够

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Termux aapt2 上游停更/改包 | APK 打不出来 | 版本与 sha256 固定；升级需真机 `assembleDebug` 验证；备选：远程构建机 |
| 设备内存吃紧（可用约 1 GB） | 构建 OOM/排队变长 | 单槽 + `-Xmx` 上限 + `doctor` 余量提示；必要时降到 1024m |
| DSH 插件契约变化（MCP/loader） | 工具消失 | 兼容矩阵 + CI 校验 + 保留 CLI 兜底 |
| 工具链目录被误删 | 所有会话不可用 | `android-doctor` 告警 + `android-provision` 幂等重建 |

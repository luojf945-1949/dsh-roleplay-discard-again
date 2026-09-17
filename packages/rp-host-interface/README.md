# Roleplay Harness 适配层

集中承载整套 Roleplay 套件对 DeepSeek Harness 的全部依赖。插件不得直接 import `@deepseek-ai/dsh-*`，一律经由此包。

## 为什么要有这一层

套件的其余部分应当只表达 Roleplay 产品语义。Harness 是外部依赖，且其预发布版本之间会移动模块划分、重命名导出、改变生命周期语义；把这些调用散落在各插件里，一次 Harness 升级就变成全仓库排查，而真正会坏的那几个点往往很小、很容易漏。

因此本包是**唯一**允许直接写 Harness 模块名的地方：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| Agent 收件箱 | `readAgentInbox`、`rearmInboxTail`、`delivery` | 队列向量与唤醒语义，本套件最易随 Harness 漂移的接口 |
| 系统提示节点 | `registerPromptSection`、`HARNESS_IDENTITY_SLOT` | 排序槽位由 Harness 解析，不在本套件硬编码数字 |
| LLM 消息与错误 | `createUserMessage`、`HarnessError` 等 | 构造转录消息、区分失败类型 |
| 压缩 | `BasicCompactionEngine`、`toolPairingBalanced*` | RP 摘要引擎的基类与转录安全检查 |
| 工具声明 | `defineTool`、`validateJsonSchemaValue` 等 | 声明工具、校验跨模型边界的 JSON Schema |
| 远程服务 | `Remote`、`TypertRemoteService` | 浏览器半侧类型化桥接的基类 |

`./message` 子路径对应 Harness 把消息词汇表拆到 `/message` 子路径的现状，调用方不必知道某个符号住在哪一半。

## 版本基线的两条硬规则

1. **Harness 预发布版本必须精确锁定。** 预发布上的 `^` 语义与直觉相反：`^0.1.5-rc.1` 会向前解析到更新的预发布版本，而 `^0.1.5-rc.2` 并不接受 `0.1.5-rc.1`，混版图必然留下无法满足的 peer。
2. **改基线用工具，不要手改。** `node tools/adapt-harness.mjs <version>` 一次性重写全部声明；`pnpm run check:compat` 在漂移时报错。`DS_ROLEPLAY_HARNESS` 是本套件在运行时可读的基线标识。

## 为什么还要钉住传递依赖

只锁仓库里写出来的声明是不够的。Harness 各预发布版本之间的 peer 范围互相兼容（例如 `^0.1.5-rc.1`），所以只要 registry 上出现了更新的预发布版本，`pnpm install` 就会把一部分传递依赖解析到新版本——**直接依赖是 `0.1.5-rc.1`，依赖图里却混着 `0.1.5-rc.2`**，`pnpm peers check` 随即失败，而失败点在 lockfile 里，靠读 manifest 看不出来。

因此 `pnpm-workspace.yaml` 持有一组覆盖全部 DSH 包名的 `overrides`，把每个包都钉到基线版本。该段由 `node tools/pin-transitive-harness.mjs <version>` 生成，`--check` 会报出任何非基线的 DSH 版本。

## 维护流程

1. `node tools/adapt-harness.mjs <version>` 改基线。
2. `node tools/pin-transitive-harness.mjs <version>` 重钉传递依赖。
3. `pnpm install --no-frozen-lockfile` 重新解析依赖图。
4. `node tools/pin-transitive-harness.mjs <version> --check` 确认图上没有混版。
5. `pnpm run check:compat` 必须通过。
6. `pnpm -r --if-present run check` 与测试套件必须通过。
7. 若 Harness 改了实际 API，只改本包，并用 `node tools/adopt-host-interface.mjs --check` 确认插件侧没有新的直连 import。

> 第 2 步与第 5 步顺序相反：`overrides` 的包名清单来自**当前** lockfile，所以首次改基线时先按旧基线生成、再解析（新基线的包集合通常一致），解析后再用 `--check` 复核。

## Model Experience

本包不产生任何模型可见内容。它只把 Harness 能力转交给插件，因此不注册工具、不写系统提示、不改变会话事实源。

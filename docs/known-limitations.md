# 已知限制与测试跳过登记

本文件是本仓库**唯一**的已知兼容限制登记处，也是「没有任何静默跳过」这条交付要求的
可执行依据：`tools/check-test-skips.mjs` 解析本文件的登记表与 LIM 条目，任何没有书面
理由的跳过都会让门禁失败（详见文末「维护约定」）。

当前 DSH 基线：`0.1.5-rc.1`（本机安装版本与仓库锁定一致）。

| 条目 | 状态 | 一句话 |
| --- | --- | --- |
| LIM-1 | 已知（未关闭） | 助手消息无法被 replace，编辑/删除/重新生成等消息操作在当前基线上不可用 |
| LIM-2 | 已解决 | `flush()` 不负责开启写句柄；测试改为按宿主生命周期建句柄后恢复通过 |
| LIM-3 | 环境边界 | 客户端 vitest 用例与个别依赖真实子进程的用例无法在本机全量执行 |

---

## LIM-1 · `assistant/message` 的 surface replace 在 DSH 0.1.5-rc.1 上不可用

- 状态：known（未关闭，已在仓库内登记为显式已知限制）
- 原因：DSH 的 surface 契约有两条互相矛盾的规则。`sourceEventSeqs` 是 replace 列出被遮蔽
  节点的唯一渠道，而 `assistant/message` 一旦携带该字段就直接抛错。
- 受影响的用户能力：① 编辑已生成的助手回复；② 编辑或清空开场白；③ 删除任意一条消息
  （用户消息、助手回复、失败回复）；④ 重新生成最后一条可恢复回复；⑤ 保存并重新生成；
  ⑥ 失败或中断回复的清理与重试（与 ③④ 走同一条写入路径）。对应 31 个用例，见登记表。
- 自动恢复条件：DSH 放宽 `assistant/message` 的 provenance 规则后自动恢复——届时
  `tools/repro-assistant-replace-unsupported.mjs` 以退出码 1 报出「缺口已关闭」，
  删掉条件跳过并重跑 `node tools/run-package-tests.mjs`；同时
  `node tools/check-session-contract.mjs`（不带 `--allow-assistant-replace-gap`）
  会沿用「缺口应已修复」这一断言通过，提醒把本条状态改为 resolved。
  31 个用例里有 30 个届时即恢复真实执行；余下 1 个
  （`plugins/rp-message-actions/test/agent-loop-integration.test.js` 第 84 行那条）
  还有第二个、与 provenance 无关的原因，必须同时改掉它的等待条件才会真正执行，
  见下面的「第二个原因（仅 1 个用例）」。

### 最小复现

```bash
node tools/repro-assistant-replace-unsupported.mjs
```

实测输出（要点）：

```text
· assistant/message + sourceEventSeqs: [1]
    抛错: assistant/message embeds its source stream and cannot carry sourceEventSeqs
· assistant/message 不带 sourceEventSeqs
    抛错: surface replace: sourceEventSeqs must include every shadowed surface node; missing 1
· user/message（纯文本 / 空内容）+ sourceEventSeqs
    接受；节点类型 user/message；模型历史 => [user, user]（可见消息）
· system/message（空内容）+ sourceEventSeqs
    接受；节点类型 system/message；模型历史 => [user]（投影为 null）
· tool/result + sourceEventSeqs（遮蔽助手节点）
    抛错: tool/result surface replacement must target a current tool/result
```

### 根因（DSH 0.1.5-rc.1 源码位置）

以下路径相对已安装的 DSH（`node_modules/@deepseek-ai/dsh-session/lib/types/`），本仓库不修改它们：

| 规则 | 位置 |
| --- | --- |
| replace 必须覆盖每个被遮蔽节点，来源只能是 `sourceEventSeqs` | `surface.js:342-363`（`planSurfaceEvent` 第 353 行调用 `assertProvenance(event, range.shadowedSeqs)`） |
| `assistant/message` 不得携带 `sourceEventSeqs` | `surface.js:205-209`（`assertProvenance` 开头） |
| 遮蔽节点未列全时的报错 | `surface.js:234-237` |
| 只有空内容 `system/message` / `assistant/message` 投影为 `null` | `surface.js:96-101` |
| `tool/result` 的 replace 只能重写一个当前 `tool/result` 节点 | `surface.js:296-324` |
| `system/message` 必须命中当前打开的 turn/step | `invariant.js:106-109`（伴随插件，`dsh-sdk-minimal` 组合会加载） |
| DSH 自带的先例：压缩用**一个 `user/message`** 遮蔽含助手节点的区间 | `dsh-compaction-basic/lib/index.js:621-632` |

### 为什么不能在仓库内绕过

需要一个「遮蔽助手节点、同时从模型历史投影为 `null`」的写入形状。四种 surface 事件里：

- `assistant/message`：能投影为 `null`，但被第一条规则与第二条规则夹死（带字段抛 A、不带抛 B）。
- `user/message`：可以遮蔽，但**必然**在模型历史里留下一条可见的用户消息（空内容也不例外）。
- `system/message`：可以遮蔽且投影为 `null`，但（a）节点类型是系统提示节点，而产品载体契约
  （`docs/rp-architecture.md` 第 96/98/100/206/207 行）与全部 carrier 消费点都要求节点是
  `assistant/message` + `rpMessageAction`；（b）`system/message` 必须命中当前打开的 turn/step，
  而消息操作按设计发生在会话空闲时。
- `tool/result`：只能重写一个当前 `tool/result` 节点。

链式替换也无解：先用 `user/message` 遮蔽、再试图把该节点换回助手节点，第二次仍然抛同一条错。

因此这不是「适配层少写了一个字段」，而是上游契约冲突；任何在仓库内的「修好」都等于改写
产品的持久载体契约，属于产品决策而不是兼容适配。

### 第二个原因（仅 1 个用例）

上面的自动恢复条件不是对全部 31 个用例都成立。`plugins/rp-message-actions/test/agent-loop-integration.test.js`
第 84 行那条用例除了等 replace 成功，还在第 106-112 行等 `session/event` 上的
`assistant/chunk` + `text-delta`；而该事件在 DSH 0.1.5-rc.1 已经不是会话事件的类型
（`dsh-session/lib/types/known-event-types.js` 只列出 `assistant/message`），流式片段现在内嵌在
`assistant/message` 的 `data.stream` 里 —— 仓库自己在 `plugins/rp-core/test/writing-flow-integration.test.js:169-179`
已记录过这次迁移。因此即使上游放宽 provenance，这条用例仍会停在 `await partialVisible`，
走不到被测行为。要真正恢复它，需要把等待条件改成 `assistant/message` + `data.stream`
的片段记录；在改掉之前，它由 LIM-1 与 `assistant/chunk` 两个原因共同跳过。

### 可决策的选项

| 选项 | 内容 | 代价 | 结论 |
| --- | --- | --- | --- |
| 1（当前） | 保留条件跳过 + 显式门禁参数；产品对受影响操作返回明确失败（`ASSISTANT_REPLACE_UNAVAILABLE`）与用户可读文案，不再出现「神秘失败」 | 上述六项用户能力在当前基线上不可用 | 已落地；上游放宽后自动恢复 |
| 2 | 把持久载体改成 DSH 压缩同款：用一个 `user/message` replacement 遮蔽区间（`dsh-compaction-basic` 先例）+ 用 append 的助手事件携带 `rpMessageAction` | 模型历史多一条用户可见标记；就地编辑变成「遮蔽 + 尾部追加」；`docs/rp-architecture.md` 的「空载体投影为 null」契约改写；`turn-surface.js:14`、`rp-state/protocol.js:188`、各客户端 carrier 消费点按类型改写；31 个用例的期望值与耐久日志格式一并迁移 | 需要产品决策，不在兼容适配范围内 |
| 3 | 上游放宽 `assistant/message` 的 provenance 规则（allow replace 引用被遮蔽区间，或让 fold 自行推导覆盖） | 需要改 DSH 上游并随新版本发布 | 长期正解；本任务边界禁止改上游，建议回报上游 |
| 4 | 用 `ctx.sessions.fork()` 子会话替代就地编辑/删除/重新生成 | 违反仓库「消息操作不得创建、切换或归档其他 Session」的架构约束（`AGENTS.md`、`docs/rp-architecture.md`） | 不建议 |

### 证据与哨兵

```bash
node tools/repro-assistant-replace-unsupported.mjs                 # 载体穷举；契约变化时退出 1
node tools/check-session-contract.mjs --allow-assistant-replace-gap # 显式接受该缺口（未登记则失败）
node tools/check-session-contract.mjs                               # 不带参数时即断言「缺口已修复」
```

---

## LIM-2 · 会话持久化写盘由宿主开启写句柄决定（已被测试覆盖）

- 状态：resolved
- 原因：`ctx.sessions.flush()` 只是**耐久屏障**，不是写盘触发器。它把 `session/flush` 派发给
  已注册的监听器；只有当某个写句柄拥有该会话时，JSONL 后端才会路由事件。旧测试假设
  「`flush()` 会自己开启写句柄」，于是在新基线上 `flush()` 返回 `true` 却不写 `session.jsonl`、
  `sessionPersistence.list()` 返回 0 条——缺的是宿主的那一步，不是 DSH 的持久化坏了。
- 受影响的用户能力：会话归档/冷会话读取链路（删除角色卡后仍可读取历史会话）的集成覆盖；
  真实部署不受影响——宿主本来就会开启句柄。
- 自动恢复条件：无需等待上游。测试已改为按宿主生命周期建句柄后再 `flush()`，
  `plugins/rp-standard/test/archive-cascade.test.js` 恢复真实执行并全绿。

### 根因与证据

宿主行为（已安装 DSH，本仓库不修改）：`dsh-agent-loop/lib/index.js:1787-1790` 在会话启动时
调用 `persistence.create(session.header, …)`；`dsh-base/cordis.patch.yml:110-113` 注册
`@deepseek-ai/dsh-session-persistence-jsonl`。仓库侧对应改动在
`plugins/rp-standard/test/archive-cascade.test.js:104-129`：`persistSession()` 先
`ctx.sessionPersistence.create(...)`，再 `appendProfile(...)`，最后 `ctx.sessions.flush(session)`；
读取走 `open(id, 'read')` + `read()`（`list()` 现在返回 `{ header, revision, sizeBytes }` 观察记录）。

```bash
node --test --experimental-test-isolation=none plugins/rp-standard/test/archive-cascade.test.js
# => # tests 1 | # pass 1 | # fail 0
```

`rp-library` 的持久化读写路径**未**需要改动；把 `open(id,'read')` 之类的调用形态改成新版契约
只发生在测试里，业务逻辑保持原样。

---

## LIM-3 · 本机受限环境下的测试执行边界

- 状态：known（环境边界，与仓库实现无关）
- 原因：本机沙箱拒绝「管道捕获子进程输出」（Node 默认 `stdio: 'pipe'` 报 `spawn EPERM`），
  因此 `node --test` 的默认每文件隔离跑不起来；`run-package-tests.mjs` 用文件描述符捕获输出，
  并加 `--experimental-test-isolation=none` 跑在同一进程内。
- 受影响的用户能力：无产品影响，只影响「本机一次命令跑全部测试」的覆盖面与可读性。
- 自动恢复条件：在允许子进程管道与真实 `spawn` 的环境（普通开发机 / CI）执行同一条命令即可；
  届时去掉 `--experimental-test-isolation=none` 与文件描述符兜底也仍然通过。

### 三个具体边界

1. **默认隔离在本机假失败**：`node --test tools/check-harness-compat.test.mjs` →
   `error: 'spawn EPERM'`，`# fail 1`。这是环境拒绝，不是用例失败；用
   `node --test --experimental-test-isolation=none <文件>` 复核。同一原因也让
   `pnpm run test:compat` 这类「一次传多个文件」的脚本在本机失败：实测（2026-09-18 09:49 复测）
   退出码 1、`failureType: 'testCodeFailure'`、`error: 'spawn EPERM'`、
   `# tests 5 / # pass 0 / # fail 5 / # cancelled 0` —— 5 个文件各自在启动隔离子进程时被拒，
   **不是** `cancelledByParent`，也不是用例断言失败。真正的取消形态见下条。
   本机的权威结果看 `node tools/run-package-tests.mjs`，它逐文件执行根级测试。
2. **父级取消**：进程内隔离下，需要真实子进程的用例（`plugins/rp-core/test/subagent-run.test.js`
   的 `structured child timeout`）被父级取消，并会把**同一批次里它之后的用例**一起标成
   `cancelledByParent`——取消可能掩盖后续失败（本仓库就曾因此掩盖住一条真实失败的
   `scripts/dev.test.mjs` 用例，已修复）。处理方式：
   - `tools/run-package-tests.mjs` 对根级测试**逐文件**执行，并在某个目标出现取消时
     自动逐文件复核该目标，输出里会标出 `（已逐文件复核）`；
   - 逐文件实测：`plugins/rp-core` 共 91 个用例、`fail 0`、`cancelled 1`（唯一被取消的仍是
     上面那条需要真实子进程的用例），即取消之后没有隐藏失败。
3. **客户端 vitest 用例不在本管线内**：`test:client`（`vitest run`）需要 worker 子进程，
   本机起不来，因此 `run-package-tests.mjs` 只取包内 `node --test` 那一段。受影响文件例如
   `plugins/rp-message-actions/test/client.client.spec.jsx`。在可用环境执行：

   ```bash
   pnpm -r --if-present run test:client      # 或 pnpm --filter <包名> test:client
   ```

   本机唯一可验证的替代覆盖：`messageActionError()` 的文案映射由
   `plugins/rp-message-actions/test/message-action-error.test.js` 用 `node --test` 覆盖。
4. **pnpm 的递归脚本在本机起不来**：`pnpm run <单个脚本>` 正常，但
   `pnpm -r --if-present run check` 这类递归调用报 `EPERM spawn`，因此聚合脚本
   `pnpm run check` 在本机无法一次跑完。等效的本机证据（逐条都已实测通过）：

   ```bash
   node tools/check-harness-compat.mjs
   node tools/check-test-skips.mjs
   node tools/check-session-contract.mjs --allow-assistant-replace-gap
   node --check scripts/dev.mjs
   ```

   逐包 `check` 脚本（26 个）可直接执行：24 个纯 `node --check` 链用 `cmd /c "<脚本>"`
   运行，2 个 `tsc -p tsconfig.json --noEmit` 用本地 `node_modules/.bin/tsc` 运行，全部退出 0。

### 与「取消」相关的两个已修问题

- `scripts/dev.test.mjs` 曾硬编码「工作区有 25 个 package」，适配层新增
  `packages/rp-host-interface` 后静默过期，且失败被同批次的父级取消掩盖。现在断言
  「发现的集合 == 工作区声明的集合」，不再硬编码数量。
- `tools/run-package-tests.mjs` 现在逐文件执行根级测试，并在出现取消时逐文件复核，
  取消不再掩盖后续失败。

---

## 测试跳过登记表

登记表是「无静默跳过」的机器可读来源。`源码热点数` = 该文件里引发跳过的源码位置数；
`运行时跳过数` = TAP 汇总里该包实际跳过的用例数；两者不一致时 `备注` 必须写明原因。

| 跳过来源 | 关联条目 | 源码热点数 | 运行时跳过数 | 备注 |
| --- | --- | --- | --- | --- |
| plugins/rp-conversation-summary/test/assistant-replace-support.js | LIM-1 | 1 | 0 | 探测模块，`skip:` 选项在此生成，本文件不跳过用例 |
| plugins/rp-conversation-summary/test/engine.test.js | LIM-1 | 2 | 2 | — |
| plugins/rp-conversation-summary/test/token-meter.test.js | LIM-1 | 1 | 1 | — |
| plugins/rp-core/test/assistant-replace-support.js | LIM-1 | 1 | 0 | 探测模块，`skip:` 选项在此生成，本文件不跳过用例 |
| plugins/rp-core/test/runtime.test.js | LIM-1 | 1 | 1 | — |
| plugins/rp-message-actions/test/assistant-replace-support.js | LIM-1 | 1 | 0 | 探测模块，`skip:` 选项在此生成，本文件不跳过用例 |
| plugins/rp-message-actions/test/agent-loop-integration.test.js | LIM-1 | 8 | 8 | 其中 1 个用例还有第二个与 provenance 无关的原因（等待已不再是事件类型的 `assistant/chunk`），见 LIM-1「第二个原因（仅 1 个用例）」 |
| plugins/rp-message-actions/test/message-actions.test.js | LIM-1 | 16 | 17 | 其中一个注解位于 `for` 循环内，运行时展开为 2 个用例 |
| plugins/rp-session/test/assistant-replace-support.js | LIM-1 | 1 | 0 | 探测模块，`skip:` 选项在此生成，本文件不跳过用例 |
| plugins/rp-session/test/session.test.js | LIM-1 | 1 | 1 | — |
| plugins/rp-standard/test/assistant-replace-support.js | LIM-1 | 1 | 0 | 探测模块，`skip:` 选项在此生成，本文件不跳过用例 |
| plugins/rp-standard/test/fork-projections.test.js | LIM-1 | 1 | 1 | — |

合计：源码热点 35 处，运行时跳过 31 个用例，全部归属 LIM-1。

## 附：上游未被修改的校验证据

本仓库不修改 DeepSeek Harness：适配层只通过公开 import 与 `peerDependencies` 接入，验证
过程也不写入 DSH 的任何文件。可复现的校验：

```bash
pnpm store status                      # => Packages in the store are untouched（退出码 0）
git status --short                     # 只列出仓库内文件；node_modules/ 由 .gitignore 排除
git check-ignore -v node_modules/@deepseek-ai/dsh/package.json
```

`pnpm store status` 逐内容校验 pnpm store；本仓库 `node_modules` 里的 DSH 包与该 store
共享硬链接，因此任何就地改动都会被它报出来。配套的时点证据：交付时 DSH 的 234 个包、
2334 个源码文件里，最近 12 小时内被修改的文件数为 0。

## 维护约定

- 新增任何形式的跳过（`{ ...<probe>Skip }`、`test.only` 之外的 `test.skip` / `t.skip`、
  或测试选项里的 `skip:` 字面量）都必须：先在上一节表格里登记归属条目与两个计数，
  再在 LIM 条目里写清「原因 / 受影响的用户能力 / 自动恢复条件」。
- `node tools/check-test-skips.mjs` 做静态校验（登记表 vs 源码热点、条目字段完备性）；
  `node tools/run-package-tests.mjs` 做运行时校验（登记表的运行时跳过数 vs TAP 汇总）。
  两者任一不符都会以非零退出码失败，并打印缺失的登记项。
- 缺口关闭后不要只删跳过：同步更新对应 LIM 条目状态，让本文件继续反映真实基线。

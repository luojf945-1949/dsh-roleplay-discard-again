# 把 `@luojf945-1949/dsh-roleplay` 推到 fork —— 交接说明

> 本文件由适配工作会话生成，供你或另一个会话执行。
> 注意：**当前 checkout 里有另一个 DSH 会话（`session-989d57f3…`）正在同时修改文件**，
> 所以在动手前先确认对方已停止，否则会互相覆盖。

## 0. 首先：fork 的是另一个仓库

原任务是 fork `lutrodev/dsh-roleplay`，但 `luojf945-1949/dsh-roleplay` 的父仓库实际是
**`chinosk6/dsh-roleplay`** —— 同名但是**另一个项目**（v0.5.1，单包，已发布 npm）。

| | chinosk6/dsh-roleplay | lutrodev/dsh-roleplay |
| --- | --- | --- |
| 版本 | 0.5.1 | 0.1.8 |
| 结构 | 单包（`src/` `client/`） | 27 包 monorepo（`plugins/` `packages/`） |
| npm | 已发布 `dsh-roleplay` | 私有，需 build 后安装 |
| DSH 声明 | peer `^0.1.0-rc.6`（实测 0.1.5-rc.1 存在） | 精确锁定（已改到 0.1.5-rc.1） |
| 适配层 | 已有 `src/dsh-compat.ts` + `client/compat.ts` | 本次新增 `packages/rp-host-interface` |

在 GitHub 打开 <https://github.com/lutrodev/dsh-roleplay> 点 **Fork**，账号选 `luojf945-1949`。
本仓库的适配工作全部针对 lutrodev 那个项目。

## 1. 加 remote

```bash
cd E:/WorkSpace/family/dsh-roleplay
git remote rename origin upstream
git remote add origin https://github.com/luojf945-1949/dsh-roleplay.git
git fetch origin
```

## 2. 提交清单（本次适配的产出）

新增：

- `packages/rp-host-interface/` —— Harness 适配层（`package.json`、`tsconfig.json`、`README.md`、
  `src/{index,inbox,system-prompt,version,message}.{js,d.ts}`、`test/{inbox,system-prompt}.test.js`）
- `tools/adapt-harness.mjs` —— 一次性重写全部 DSH 版本锁定
- `tools/adopt-host-interface.mjs` —— 插件直连 Harness 的检查工具
- `tools/repoint-fork.mjs` —— 改 npm scope 与仓库 URL

修改：

- `package.json`、`README.md`、`CHANGELOG.md` —— 改名 `@luojf945-1949/dsh-roleplay`、仓库 URL、基线 0.1.5-rc.1
- `scripts/build-npm-package.mjs` —— 修两个上游 bug（见第 4 节）
- 9 个消费插件 —— 改为经适配层 import，并声明 `peerDependencies.dsh-roleplay-rp-host-interface`
- `pnpm-workspace.yaml`、`pnpm-lock.yaml` —— 基线重定向与传递依赖钉版

**不属于本次适配**（另一个会话产出，按你的意愿决定是否一起提交）：
`.gitignore`、`.npmrc`、`tools/pin-transitive-harness.mjs`、`tools/verify-local-symbols.mjs`。
其中 `pin-transitive-harness.mjs` 是 `pnpm run check:compat` 能通过的前提，**建议一起提交**。

## 3. 提交前验证

```bash
pnpm install --no-frozen-lockfile
pnpm run check:compat                    # 必须通过
pnpm -r --if-present run check           # 必须全绿
node tools/adopt-host-interface.mjs --check
node --test packages/rp-host-interface/test/inbox.test.js
node --test packages/rp-host-interface/test/system-prompt.test.js
```

当前实测结果：`check:compat` 通过（DSH 0.1.5-rc.1，26 个 workspace package，234 个 DSH 包锁定，
lockfile 零 rc.2 残留）；适配层 19 个测试全绿；`check` 全绿。

```bash
git add packages/rp-host-interface tools/adapt-harness.mjs tools/adopt-host-interface.mjs \
        tools/repoint-fork.mjs scripts/build-npm-package.mjs package.json README.md CHANGELOG.md \
        pnpm-workspace.yaml pnpm-lock.yaml plugins packages
git commit -m "feat: adapt suite to DSH 0.1.5-rc.1 and centralize Harness access"
git push -u origin main
```

## 4. 两个上游 bug（已修，值得回报上游）

1. `scripts/build-npm-package.mjs` 的守卫 `outputDir.endsWith('/.npm-package')`：Windows 路径用反斜杠，
   该表达式**恒为假**，构建必定中止。已改为比较 `basename`。
2. 同文件生成 `cordis.patch.yml` 时，正则**在包名已被替换之后才去匹配旧名**，永不命中，
   于是 `name: @scope/pkg` 未加引号 —— YAML 语法错误，`dsh --profile web --dump-config` 直接崩。
   已改为匹配公开包名。

## 5. 已知未解决：会话持久化在新版 DSH 上是坏的

同一份测试文件、纯净 0.1.2-rc.1 基线 vs 新版对照：

| | 0.1.2-rc.1 | 0.1.5-rc.1 | 0.1.5-rc.2 |
| --- | --- | --- | --- |
| `flush()` 后写盘 | 写 `session.jsonl` | 不写 | 不写 |
| `sessionPersistence.list()` | 1 条 | 0 条 | 0 条 |

根因：`ctx.sessions.flush()` 现在只收集 `session/flush` 监听器
（`collectSessionCallbacks`），JSONL 持久化插件的监听器没有参与，`flush()` 返回 `true` 却什么都不写。

影响 1 个测试：`plugins/rp-standard/test/archive-cascade.test.js`。
另 1 个失败（`structured child timeout`）在纯净基线上同样失败，与本次适配无关。

修它需要改 `rp-library` 的持久化读写路径（`list()` 语义已变，且 `open(id,'read')`
在 0.1.2 上根本不存在），属于业务逻辑改动，未擅自处理。

## 6. 已改名的包名不可提交的部分

`.npm-package/` 已被 `.gitignore` 忽略，是构建产物。发布用：

```bash
pnpm run pack:package     # 产出 luojf945-1949-dsh-roleplay-0.1.8.tgz
```

注意：`dsh plugin --profile web add <本地目录>` 会生成 `link:`，peer 依赖无法解析；
要验证安装请装 **tarball**。装好后 `dsh --profile web --dump-config` 退出 0，
19 个 Roleplay 插件条目全部正确编入。

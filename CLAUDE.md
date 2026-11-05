# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

微信/抖音小游戏《疯狂水世界》的协议侧挂机工具：不启动游戏客户端，直连游戏 WebSocket 网关，并提供本地网页控制台。仅面向 Windows，Node.js >= 20.11，ESM。文档、界面和日志均为中文。

## 常用命令

```powershell
npm start                     # 启动控制台，端口 17321（CW_PORT 可改，CW_NO_BROWSER=1 不开浏览器）
.\start-console.cmd           # 用户入口，端口 17323，先检查 MITM 根证书状态
npm run build:ui              # 改 src/ui 下的 tsx 或 theme.css 后必须运行
npm test                      # 主测试集，约 30 秒，串行、遇错即停
npm run test:level16          # npm test 的子集
npm run test:progression      # npm test 的子集
npm run test:capture          # 以下三组不在 npm test 内
npm run test:wechat
npm run test:wxapkg
node tools/selftest-radar.mjs # 运行单个测试：直接执行对应文件
npm run sync-config           # 同步配置表到 work/
npm run sync-art              # 同步素材到 work/，缓存缺图时加 -- --fetch
```

没有 lint 和测试框架。测试是用 `node:assert/strict` 写的脚本，新增测试文件后要手动加进 `package.json` 的脚本，不会自动发现。

- `tools/selftest-{fishing,fishing-upgrade,antique-recruit,activity-schedule,resident-orders,resident-http}.mjs` 只导出函数，由 `selftest-automation.mjs` 调用，单独执行不会跑测试。
- `selftest-registry.mjs` 和 `selftest-describe.mjs` 不在任何 npm 脚本内。前者会写当前用户注册表的测试键并自行清理；后者目前失败，`tools/describe.mjs` 还原 `LoginResponse` 时缺少字段 2 `playerInfo`。

CLI 模式见 `src/app.mjs` 的 `main()`。本地只读：`accounts`、`actions`、`config [表名]`。连接游戏：`state`、`worlds`、`world`、`tasks`、`dailies`、`heroes`、`loot`、`loop`、`stages`、`field`、`act <id> k=v`、`connect`、`probe`。用 `--account` 或 `CW_ACCOUNT` 选账号。

## 操作真实账号的注意事项

- 带 `--yes` 或 `CW_ALLOW_MUTATE=1` 的命令会改变真实账号状态，`--dry` 不执行写操作，但仍会登录。验证改动时优先用离线测试。
- 工具登录会把正在玩的游戏会话顶下线，反之亦然。
- `node src/app.mjs worlds <worldId>` 进入没有角色的区服可能创建新角色。
- `data/` 含账号登录凭证和协议日志，`work/` 含从游戏提取的协议与配置，两者都被 git 忽略，不要提交或外发。

## 架构

### 协议与配置都来自本机游戏缓存

仓库不含 `.proto` 和配置表，因此测试和运行都依赖本机缓存：

- **协议**：`proto.mjs` 加载并执行游戏自带的 `game.js`，取出 protobufjs 生成的编解码类。来源顺序见 `protocol-source.mjs`：`CW_PROTO_BUNDLE` → 微信缓存中版本号最高的 `_src_chunks_.wxapkg` → `work/extracted/`。没有反射信息，字段布局用 `tools/describe.mjs` 从生成代码还原，压缩代码里查上下文用 `tools/ctx.mjs`。
- **配置表**：`config.mjs` 按 `CW_CONFIG_PACK` → `work/cdn/config_cn_pack.json` → 微信缓存的顺序查找。代码注释和报错里提到的 `tools/fetch-config.mjs` 已不存在，实际命令是 `npm run sync-config`。
- 请求名和字段以 `protocol[name]` 为准。`actions.mjs` 是协议调用目录，用 `mutate` 区分只读与写操作。

### 分层

- `client.mjs`（`GameClient`）：WebSocket、序号、Ack、心跳和请求匹配。帧格式在 `codec.mjs`、`frame-header.mjs`、`lz4.mjs`。有响应类型的请求用 `request`；没有的用 `sendWatch`，它只在短时间内等待 prompt，没等到就视为成功，所以结果未必可靠。
- 玩法模块（`world`、`dailies`、`tasks`、`radar`、`museum`、`pet-breeding` 等）：先只读探测，再算计划，最后执行。
- `loop.mjs`（`runLoop`）：一轮挂机的编排。第二轮起计划自然为空，不会重复发请求。被服务端拒绝的动作跨轮记录。CLI 与控制台共用它，**是否传 `isEnabled` 会改变分支**：控制台按账号开关和 `reward-schedule` 执行，CLI 走另一条路径，改动时两边都要看。
- `server.mjs`（`createConsole`）：HTTP API 和按账号的会话。同一账号的手动操作和挂机都经 `enqueue` 串行执行，新的写操作也要走这个队列。
- `accounts.mjs`、`capture.mjs`、`tools/mitm-*.mjs`：账号存储与凭证采集。采集会临时改系统代理和用户证书。

### 控制台页面

`page.mjs` 在模块加载时拼出一个完整 HTML 字符串 `PAGE`，由三部分组成：

- `src/ui/*.tsx` 经 esbuild 打包到 `src/ui/dist/`（已提交），在服务端渲染为静态标记，**浏览器里没有 React**，组件不能依赖 hooks 或事件属性。
- 页面行为是原生 JS：`page.mjs` 内联脚本加 `src/ui/progression.js`、`activities.js`，后两者原样内联，无需构建，共享全局作用域。
- 样式是 `console.css`（legacy 层）加 Tailwind 产物。

改完任何页面文件都要重启控制台才生效；改 tsx 或 `theme.css` 还要先 `npm run build:ui`，并把 `dist` 一起提交。

### 自动任务的接线

新增一项挂机任务通常要改这些地方：

1. `automation.mjs` 的 `automationTasks`：`[key, 标签, 分组, 默认值]`。挂机页按此自动生成开关；`限时活动` 分组不在挂机页显示。
2. `loop.mjs`：加入 `enabled(key)` 判断，并通过 `report` 上报 `{ key, skipped, reason, ... }`。跳过原因只在变化时写日志。
3. `reward-schedule.mjs`：用 `defer` 记下一次检查时间，并在对应的服务端推送到来时清除。
4. 新增 API 路由时，在 `operation-labels.mjs` 补中文操作名。
5. 把测试加进 `package.json`，并更新 `README.md`、`CHANGELOG.md`。

会消耗资源的新任务默认值必须为 `false`，已有账号需要主动开启，`selftest-progress-automation.mjs` 对此有断言。

### 资源预留

`order-reservations.mjs`（材料）、`gold-reservations.mjs`（金币）、`fleet-reservations.mjs`（舰队与汽油）协调跨玩法消费。服务端确认操作可能早于库存更新，所以已确认的扣款记录在进程内存中，按账号跨重连保留，重启进程后清空。操作结果不明时后续消耗要等待，不能用旧余额重试。新增消耗型玩法要接入对应预留，并保留周订单、贸易港和居民订单用料。

### 容易踩的数据细节

- 未安装 Long 库，int64 解码为 `{ low, high, unsigned }`。比较前用 `client.mjs` 的 `toNumber`；UID 这类超出安全整数的值要按字符串处理，如 `hero-equipment.mjs` 的 `uidText`。
- 服务端时间用 `Date.now() + client.serverClockOffsetMs`，每日重置按北京时间计算。
- 合服后 `GameWorldInfo.worldId` 可能不等于角色的 `worldId`。

## 测试约定

- 用假 client（实现 `request`、`sendWatch`）驱动玩法模块，同时断言请求名和响应名存在于真实 `protocol`，防止虚构接口。
- `DATA_DIR` 在 `accounts.mjs` 加载时确定。涉及账号存储或控制台的测试必须先设置临时的 `CW_DATA_DIR`（及 `CW_CONFIG_PACK`），再用动态 `import()` 加载 `accounts.mjs`、`server.mjs`，避免碰到真实账号数据。

## 文档

用户可见的改动同步更新 `README.md` 和按日期倒序的 `CHANGELOG.md`。协议与玩法依据记录在 `docs/gameplay.md`，16 级开放条件在 `docs/level-16.md`，登录分析在 `docs/wechat-login.md`。

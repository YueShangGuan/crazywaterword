# UI 迁移作战手册（上游外壳为基，回插用户自建功能）

> 状态：已执行完毕（2026-11-13，提交 acd7874 换壳 / 6158681 阶段3a / 5021910 阶段3b+4 / 92785e3 阶段5）。与手册的差异：server 侧以用户版为基底做加法（用户版已具备上游 handle 约定，换基座风险更高）；上游 UI 所需的缺口路由远不止 world-overview/target，实际共回插 15 个模块与 20 余条路由；settings-card.mjs 暂保留（与设置页全量编辑器并存，退役待定）；地图领地多边形联合映射仍为独立待办。
> 原则：**上游 page.mjs/server.mjs 为基底做加法，禁止三方合并**（两边已大分叉：上游 1848 行 vs 用户 2600+ 行）。

## 阶段 0：前置事实

- 构建管线两边相同：`npm run build:ui` = esbuild `src/ui/console.tsx` + tailwindcss，`prestart` 自动构建。**改 ui/ 后必须构建 + 重启控制台**（PAGE 启动时固化）。
- 上游外壳 = shadcn new-york-v4 样式 + 响应式（手机底栏/表格卡片化/触控分支）+ 原生 dialog 日志（log-categories 分类筛选）。
- 上游壳**删掉了**：断线重连、Webhook 通知、收益日报、游戏消息面板、世界地图独立 tab、自动化面板 tab——全部是用户独有功能，阶段 4 回插。
- 已就位的上游件（前三波已引）：`log-categories/console-log/art-thumbs?(未引)`、`/api/settings*` 路由、`settings-card.mjs` 轻量卡片、map 触屏适配（map.js/map.css）。

## 阶段 1：替换 src/ui/

从上游（`E:\MyProject\疯狂水世界\xutongxue233\crazywaterworld`，HEAD=fd25254）整文件拷贝：
`console.tsx, layout.tsx, pages.tsx, settings.tsx, dialog.tsx, help-tip.tsx, input.tsx, native-select.tsx, button.tsx, card.tsx, table.tsx, badge.tsx(如有), switch.tsx, checkbox.tsx, utils.ts, theme.css` + `src/console.css, src/settings.css`。
再从**用户版**回插两个自建页面组件：`mapPage()`（ui/map-page.tsx）与 `automationPage()`（ui/console.tsx:113-138 附近，含循环模块选择与游戏配置卡片）进上游 console.tsx/pages.tsx。
构建：`npm run build:ui`。此时 page.mjs 尚未换，页面仍是旧壳——**阶段 1+2 必须同一提交**。

## 阶段 2：page.mjs 重壳（上游为基）

基底 = 上游 `src/page.mjs`（1848 行）。回插清单：
1. **tab 注册**：上游 layout.tsx tabs 数组加 `map`、`automation` 两项（含手机短名）；`section#tab-map`、`section#tab-automation` 仿上游 section 模式插入；`activateConsolePage` 加两个分支（上游 page.mjs:1784-1815 模式）。
2. **脚本注入**：`${AUTOMATION_SCRIPT}${SETTINGS_SCRIPT}${mapScript}` 按上游 page.mjs:1773-1782 的拼接顺序加入；`import { AUTOMATION_SCRIPT } from './automation-ui.mjs'`、`SETTINGS_SCRIPT from './settings-card.mjs'`、mapScript 来自 ui/map.js（读文件字符串）。
3. **激活钩子**：`loadAutomation()/gsLoad()/refreshWorldMap()/loadMessages()` 挂 tab 切换与首屏（用户 page.mjs:682-687、2005-2007 逻辑平移）。
4. **确认框**：上游 dialogs 没有 `m-ack`（“我已核对当前账号”勾选）；automation 脚本引用了它则把上游确认框模板补上该勾选。
5. **首屏调用**：上游 page.mjs 的 `refreshLoop/refreshOverview` 等与用户路由对齐（见阶段 3）。
6. `connection.js`（重连+通知表单）、`income`、`messages` 面板脚本回插（阶段 4 一起）。

## 阶段 3：server.mjs 路由回插（上游 handle 为基）

上游 `handle()` 约定：`scoped_(parsed)` 账号会话、`enqueue(session,work,label)` 写串行、`longRunning` 标记、`json()` 已带 gzip+ETag（用户侧第四波已加同款）。
用户 6 组路由回插（保持用户语义）：
`/api/automation/settings|status|stop|plan|run|pirate-sweep-status|guild-ship-options`、`/api/map/layout|state|city-war/settings|city-war/dispatch|city-defence`、`/api/messages`、`/api/income`、`/api/notify*`、`/api/loop/reconnect`。
**冲突点**：`GET /api/loop` 两边同名不同 payload——以上游 loopView（含 controls/settingsRevision 供任务开关渲染）为骨架，合入用户附加字段（reconnect 配置等）。`POST /api/gift-codes/redeem` 用**用户现版**（已接上游 gift-codes 模块 + SSE）。
上游 page 会调用用户服务器没有的路由（如 `/api/world/overview`、`/api/world/target`）——两选一：把上游 `world-overview.mjs/world-target.mjs` 连路由一起带过来（推荐，地图只读视图顺带白拿），或在阶段 2 先隐藏对应入口。

## 阶段 4：补回被删功能 UI

| 功能 | 组成 | 备注 |
|---|---|---|
| 断线重连 | reconnect.mjs + `/api/loop/reconnect` + 表单 | **掉线语义二选一**：上游“断线即停+清持久开关”vs 用户“退避重连”。建议保留用户语义（挂机场景） |
| Webhook 通知 | notify/notifications.mjs + `/api/notify*` + 表单 | 按账号企微配置，30 分钟去重 |
| 收益日报 | income-report.mjs + `/api/income` + 总览表格 | 上游 d382ae0 有意移除，用户保留 |
| 游戏消息面板 | messages.mjs + `/api/messages` + 四频道组件 | 城战系统消息上色是独有资产 |
| 城战派遣控件 | map.js 内置 + `/api/map/city-war/dispatch` | 随 map tab 回归 |

## 阶段 5：收尾与增强

- `settings-ui.js`（上游 1044 行全量配置编辑器）+ `/api/settings/preview`、`/players` 路由（preview 依赖 world-target/dispatch-preview，均已就位）——接入后轻量卡片 settings-card.mjs 可退役。
- `art-thumbs.mjs` + 上游 `iconEl()` 懒加载缩略图（需引入 art-thumbs 并改 server 图标路由）。
- `/mobile` 原型页（mobile-page.mjs）与 `GET /mobile` 路由：**删除**（纯演示稿，响应式壳已覆盖）。
- 地图领地多边形：`world-map-geometry.mjs`（61 行零依赖）需与用户 canvas 的 axisGrid 多格布局做联合边界映射——独立小任务。

## 测试策略

每阶段结束跑：`node --test test/console-connection.test.mjs`（39 项，断言 PAGE 内容与路由行为——换壳后预期一批断言红，逐条按“新壳事实”修正，**不许为过测试删功能**）+ `test/automation.test.mjs`（367 项应全绿，不依赖壳）。新增一个“迁移冒烟”：手机 viewport（375px）下 `#tabs` 底栏存在、`tab-map/tab-automation` 可激活。

## 提交与回滚

阶段 1+2 一个 commit（纯前端换壳）；阶段 3 一个；阶段 4 每功能一个；阶段 5 一个。任一阶段炸了 `git checkout -- <paths>` 单独回退，不拖累已完成波次。

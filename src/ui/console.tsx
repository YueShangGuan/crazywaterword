import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"

type AutoTask = { key: string; label: string; group: string }

export function idlePanel(tasks: AutoTask[]) {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Card>
      <CardHeader>
        <CardTitle>定时挂机</CardTitle>
        <CardDescription>轮数填 0 表示持续运行。每轮只执行当前账号已开启的任务。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bar">
          <label htmlFor="loop-rounds">轮数</label>
          <Input id="loop-rounds" type="number" min="0" defaultValue="0" className="w-20" />
          <label htmlFor="loop-every">间隔（秒）</label>
          <Input id="loop-every" type="number" min="1" max="86400" defaultValue="60" className="w-24" />
          <Button id="loop-start" disabled>开始挂机</Button>
          <Button id="loop-stop" variant="outline" disabled>暂停挂机</Button>
        </div>
        <div className="dim" id="loop-hint" role="status" />
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>断线重连</CardTitle>
        <CardDescription>只在持续挂机时生效。凭证失效时不会重试。设置按账号保存。</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="reconnect-form" className="settings-form">
          <div className="task-setting">
            <label htmlFor="reconnect-enabled">掉线后自动重连</label>
            <Switch id="reconnect-enabled" className="p-0" disabled />
          </div>
          <div className="bar">
            <label htmlFor="reconnect-base">首次间隔（秒）</label>
            <Input id="reconnect-base" type="number" min="1" max="3600" step="1" required className="w-24" disabled />
            <label htmlFor="reconnect-max">最长间隔（秒）</label>
            <Input id="reconnect-max" type="number" min="1" max="86400" step="1" required className="w-24" disabled />
            <label htmlFor="reconnect-attempts">最多次数（0 为不限）</label>
            <Input id="reconnect-attempts" type="number" min="0" max="100000" step="1" required className="w-24" disabled />
          </div>
          <div className="bar">
            <label htmlFor="reconnect-kicked">被顶号后</label>
            <select id="reconnect-kicked" className="settings-select" disabled>
              <option value="stop">停止挂机并通知</option>
              <option value="retry">等待后自动重连</option>
            </select>
            <label htmlFor="reconnect-kicked-minutes">等待（分钟）</label>
            <Input id="reconnect-kicked-minutes" type="number" min="1" max="1440" step="1" required className="w-24" disabled />
            <Button id="reconnect-save" type="submit" variant="outline" disabled>保存</Button>
          </div>
          <p className="dim">选择自动重连时，如果你正在玩游戏，到时间后会被顶下线。</p>
          <div className="dim" id="reconnect-hint" role="status" />
        </form>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>异常通知</CardTitle>
        <CardDescription>通过 Webhook 发送，所有账号共用。同一账号的同一事件 30 分钟内只通知一次。</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="notify-form" className="settings-form">
          <div className="bar">
            <label htmlFor="notify-webhook">Webhook 地址</label>
            <Input id="notify-webhook" type="url" placeholder="留空表示不发送" className="settings-url" disabled />
            <label htmlFor="notify-format">格式</label>
            <select id="notify-format" className="settings-select" disabled>
              <option value="generic">通用 JSON</option>
              <option value="wecom">企业微信、钉钉</option>
              <option value="feishu">飞书</option>
            </select>
          </div>
          <div id="notify-events" className="task-grid" />
          <div className="bar">
            <Button id="notify-save" type="submit" variant="outline" disabled>保存</Button>
            <Button id="notify-test" type="button" variant="outline" disabled>发送测试通知</Button>
          </div>
          <p className="dim">Webhook 消息包含账号备注或昵称，只填写你信任的地址。</p>
          <div className="dim" id="notify-hint" role="status" />
        </form>
      </CardContent>
    </Card>
    <div className="idle-groups">{Array.from(new Set(tasks.map(t => t.group))).map(group => <Card key={group}>
      <CardHeader><CardTitle>{group}</CardTitle></CardHeader>
      <CardContent className="task-grid">
        {tasks.filter(t => t.group === group).map(t => <div className="task-setting" key={t.key}>
          <label htmlFor={'auto-' + t.key}>{t.label}<small id={'next-' + t.key} className="block text-muted-foreground" /></label>
          <Switch id={'auto-' + t.key} data-auto-task={t.key} className="p-0" disabled />
        </div>)}
      </CardContent>
      {group === '钓鱼' && <CardContent>
        <form id="fishing-reserve-form" className="bar">
          <label htmlFor="fishing-reserve">强化后至少保留金币</label>
          <Input id="fishing-reserve" type="number" min="0" step="1" required className="w-32" disabled />
          <Button id="fishing-reserve-save" type="submit" variant="outline" disabled>保存</Button>
        </form>
      </CardContent>}
    </Card>)}</div>
  </div>)
}

/**
 * Render the account-scoped automation workspace used for detailed module settings,
 * single-pass execution, and controlled recurring runs.
 */
export function automationPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Card>
      <CardHeader>
        <CardTitle>高级自动化</CardTitle>
        <CardDescription>设置按账号保存。执行前会按赛季、库存和钻石额度校验条件。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bar"><Button id="automation-load" variant="outline">重新加载设置</Button><Button id="automation-save" variant="outline">保存设置</Button><span id="automation-hint" className="warn" role="status" /></div>
        <p className="dim">赛季 0 会跳过需要赛季配置的功能。钻石消费需同时满足功能开关、总额度、模块额度和当前角色的最低钻石保留量；新模块默认关闭。</p>
        <div className="bar"><select id="automation-select" className="settings-select" aria-label="选择自动化模块" /><Button id="automation-plan" variant="outline">计划预览</Button><Button id="automation-run">执行一轮</Button><Button id="automation-stop" variant="destructive">停止</Button></div>
        <div className="bar log-heading"><span className="k">自动化运行日志</span><Button id="automation-log-copy" variant="outline" size="sm">复制当前日志</Button><span id="automation-log-copy-hint" className="dim" /></div>
        <pre id="automation-view" aria-live="polite">预览会查询当前游戏状态；执行需确认。结果不明的写请求会保留预留额度并停止后续动作。</pre>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>循环模块选择</CardTitle></CardHeader>
      <CardContent>
        <details className="automation-group"><summary>选择自动化模块和循环间隔</summary><div id="automation-loop-modules" /><div className="bar"><label htmlFor="automation-rounds">轮数</label><Input id="automation-rounds" type="number" min="0" defaultValue="1" className="w-20" /><label htmlFor="automation-every">间隔秒</label><Input id="automation-every" type="number" min="1" defaultValue="60" className="w-20" /><Button id="automation-loop">开始循环</Button></div></details>
        <div id="automation-settings" />
      </CardContent>
    </Card>
    <Button id="automation-floating-save" className="automation-floating-save" type="button" hidden>保存设置</Button>
    <Button id="automation-back-to-top" className="automation-back-to-top" type="button" hidden><span aria-hidden="true">↑</span>回到顶部</Button>
  </div>)
}

export function action(id: string, label: string, variant: React.ComponentProps<typeof Button>["variant"] = "outline", disabled = false) {
  return renderToStaticMarkup(<Button id={id} variant={variant} disabled={disabled}>{label}</Button>)
}

export function stagePanel() {
  return renderToStaticMarkup(
    <div className="grid gap-4">
    <Card>
      <CardHeader>
        <CardTitle>挑战主线关卡</CardTitle>
        <CardDescription>手动开启后，每场间隔 5 秒。过关后连续失败次数清零。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bar">
          <label htmlFor="stage-failures">同一关连续失败几次后停止</label>
          <Input id="stage-failures" className="w-20" type="number" min="1" defaultValue="3" />
          <Button id="stage-start" disabled>开启推关</Button>
          <Button id="stage-stop" variant="outline" disabled>停止推关</Button>
        </div>
        <p id="stage-view" className="dim" aria-live="polite">尚未开启</p>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>试炼副本</CardTitle><CardDescription>每次点击挑战下一关。通关后可在挂机页开启免费扫荡。</CardDescription></CardHeader>
      <CardContent>
        <div className="bar"><Button id="trial-refresh" variant="outline">刷新试炼进度</Button></div>
        <div id="trial-view" className="progression-view" aria-live="polite" />
      </CardContent>
    </Card>
    </div>
  )
}
export * from "./layout"
export * from "./pages"

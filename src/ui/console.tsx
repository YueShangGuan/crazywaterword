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
    {Array.from(new Set(tasks.map(t => t.group))).map(group => <Card key={group}>
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
    </Card>)}
    <details><summary>挂机记录</summary><pre id="loop-view">尚无记录</pre></details>
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
        <pre id="stage-view" aria-live="polite">尚未开启</pre>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>试炼副本</CardTitle><CardDescription>每次点击挑战下一关。通关后可在挂机页开启免费扫荡。</CardDescription></CardHeader>
      <CardContent className="bar">
        <Button id="trial-1" variant="outline">挑战英雄经验副本</Button>
        <Button id="trial-2" variant="outline">挑战强化石副本</Button>
        <Button id="trial-3" variant="outline">挑战海兽经验副本</Button>
      </CardContent>
    </Card>
    </div>
  )
}
export * from "./layout"
export * from "./pages"

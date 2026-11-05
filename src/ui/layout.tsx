import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Compass, LayoutDashboard, Timer, Hand, Flag, Swords, CalendarDays, ContactRound, Gift, ScrollText, SlidersHorizontal, X } from "lucide-react"
import { Button } from "./button"
import { Badge } from "./badge"
import { Card, CardContent, CardHeader, CardTitle } from "./card"
import { NativeSelect } from "./native-select"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table"

const navGroups = [
  ["概览", [["overview", "总览", "icon_btn_bottom_home", LayoutDashboard], ["idle", "挂机", "icon_btn_offline", Timer]]],
  // 高级自动化有独立的账号设置与执行记录，不能和通用挂机开关混在同一个入口。
  ["操作", [["manual", "单次操作", "icon_btn_bottom_bag", Hand], ["stages", "挑战", "icon_btn_bottom_battle", Flag],
    ["heroes", "英雄", "icon_btn_bottom_hero", Swords], ["dailies", "日常", "icon_btn_star", CalendarDays],
    ["activities", "活动", "icon_activity_week_month", Gift], ["automation", "自动化", "icon_btn_moreFunc", SlidersHorizontal]]],
  ["管理", [["account", "账号", "icon_btn_moreFunc", ContactRound]]],
] as const

type Sprite = { url: string; x: number; y: number; w: number; h: number; rotated: boolean }
function GameIcon({ sprite, size, children }: { sprite: Sprite | null; size: number; children: React.ReactNode }) {
  if (!sprite) return children;
  const { url, x, y, w, h, rotated } = sprite;
  const scale = size / Math.max(w, h);
  return <span aria-hidden="true" style={{ position: "relative", display: "inline-block", flexShrink: 0,
    width: w * scale, height: h * scale, overflow: "hidden" }}>
    <span style={{ position: "absolute", top: 0, left: 0, width: rotated ? h : w, height: rotated ? w : h,
      background: `url("${url}") ${-x}px ${-y}px no-repeat`, transformOrigin: "0 0",
      transform: rotated ? `translateY(${h * scale}px) rotate(-90deg) scale(${scale})` : `scale(${scale})` }} />
  </span>
}

export function rail(icon: (name: string) => Sprite | null) {
  return renderToStaticMarkup(<aside className="rail">
    <div className="mast"><span className="mast-icon"><GameIcon sprite={icon("icon_sail")} size={26}><Compass className="bearing" aria-hidden="true" /></GameIcon></span>
      <div><h1>疯狂水世界</h1><span className="brand-label">航行控制台</span></div></div>
    <nav id="tabs" aria-label="功能导航">{navGroups.map(([group, items]) => <div className="nav-group" key={group}>
      <span className="nav-label">{group}</span>
      {items.map(([key, title, name, Icon]) =>
        <Button key={key} data-tab={key} aria-current={key === "overview" ? "page" : undefined} variant="ghost"><GameIcon sprite={icon(name)} size={22}><Icon aria-hidden="true" /></GameIcon>{title}</Button>)}
    </div>)}</nav>
  </aside>)
}

export function topbar() {
  return renderToStaticMarkup(<header className="topbar">
    <h2 id="page-title">总览</h2>
    <div className="connection">
      <span id="hint" className="warn" />
      <label className="account-label" htmlFor="account">当前账号</label>
      <NativeSelect id="account" title="选择账号" />
      <span id="busy" className="status-pill" data-state="off" role="status" />
      <Button id="connect" size="sm">连接</Button><Button id="disconnect" size="sm" variant="outline">断开</Button>
      <Button id="account-pause" size="sm" variant="outline" title="暂停后断开游戏连接，方便自行上号">暂停托管</Button>
      <Button id="log-toggle" size="sm" variant="outline" aria-controls="journal" aria-expanded="false"><ScrollText aria-hidden="true" />日志<span id="log-toggle-count" className="log-toggle-count" hidden /></Button>
    </div>
  </header>)
}

export function journal() {
  return renderToStaticMarkup(<aside id="journal" aria-label="运行日志"><Card>
    <CardHeader><div className="journal-top"><CardTitle>运行日志</CardTitle><Badge id="log-count">0</Badge>
      <Button id="log-close" size="icon-sm" variant="ghost" aria-label="收起日志" title="收起日志"><X aria-hidden="true" /></Button></div></CardHeader>
    <CardContent>
      <div className="log-filter" role="group" aria-label="日志筛选">
        <Button id="log-all" size="sm" variant="outline" aria-pressed="true">全部</Button>
        <Button id="log-issues" size="sm" variant="outline" aria-pressed="false">警告与错误</Button>
      </div>
      <div id="log" role="log" aria-live="polite" aria-label="操作记录" />
      <p id="log-empty">还没有运行记录</p>
    </CardContent>
  </Card></aside>)
}

export function dialogs() {
  return renderToStaticMarkup(<>
    <dialog id="modal" aria-labelledby="m-title"><Card>
      <CardHeader><CardTitle id="m-title" /></CardHeader>
      <CardContent><div id="m-body" />
        <div className="bar"><Checkbox id="m-ack" className="p-0" /><label htmlFor="m-ack">我已核对当前账号和本次操作</label></div>
        <div className="bar"><Button id="m-ok" disabled>确认</Button><Button id="m-cancel" variant="outline">取消</Button><span id="m-count" className="dim" /></div>
      </CardContent>
    </Card></dialog>
    <dialog id="account-dialog" aria-labelledby="account-title"><form method="dialog"><Card>
      <CardHeader><CardTitle id="account-title" /></CardHeader>
      <CardContent><p id="account-message" /><Input id="account-label-input" aria-label="账号备注" />
        <div className="bar"><Button value="ok">确认</Button><Button value="cancel" variant="outline">取消</Button></div>
      </CardContent>
    </Card></form></dialog>
  </>)
}

// Clone these rendered components for data that arrives after the initial page.
export function templates() {
  return renderToStaticMarkup(<>
    <template id="ui-table"><Table><TableHeader><TableRow><TableHead /></TableRow></TableHeader><TableBody><TableRow><TableCell /></TableRow></TableBody></Table></template>
    <template id="ui-button"><Button variant="outline" size="sm" /></template>
    <template id="ui-select"><NativeSelect size="sm" /></template>
    <template id="ui-delete"><Button variant="destructive" size="sm" /></template>
    <template id="ui-badge"><Badge variant="outline" /></template>
    <template id="ui-number"><Input type="number" className="w-20" /></template>
  </>)
}

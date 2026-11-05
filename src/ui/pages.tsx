import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardHeader, CardTitle, CardContent } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"

function Panel({title, children}: {title: string; children: React.ReactNode}) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>
}

function Option({id, label, checked = false}: {id: string; label: string; checked?: boolean}) {
  return <div className="bar"><Switch id={id} data-local-switch="" defaultChecked={checked} className="p-0" /><label htmlFor={id}>{label}</label></div>
}

// Sections stay in the DOM and the page script toggles them, so ids keep working across tabs.
function SubTabs({name, label, items}: {name: string; label: string; items: {id: string; title: string; content: React.ReactNode}[]}) {
  const tabId = (id: string) => 'subtab-' + name + '-' + id
  const panelId = (id: string) => 'subpanel-' + name + '-' + id
  return <div data-subtabs={name}>
    <div className="subtabs" role="tablist" aria-label={label}>
      {items.map((item, index) => <button key={item.id} type="button" role="tab" id={tabId(item.id)} aria-controls={panelId(item.id)}
        aria-selected={index === 0} tabIndex={index === 0 ? 0 : -1}>{item.title}</button>)}
    </div>
    {items.map((item, index) => <section key={item.id} id={panelId(item.id)} role="tabpanel" aria-labelledby={tabId(item.id)}
      className="grid gap-4" hidden={index !== 0}>{item.content}</section>)}
  </div>
}

export function overviewPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="角色概况">
<div className="who" id="who"><span className="dim">还没连上。点顶部的「连接」，或先去「账号」页添加账号。</span></div>
      <div className="overview-meta"><span id="overview-updated" className="dim" role="status" /><Button id="overview-refresh" variant="outline" size="sm" disabled>立即刷新</Button></div>
    </Panel>
    <Panel title="收益日报"><div id="income-view" className="income-view"><span className="dim">挂机运行后开始记录</span></div>
    </Panel>
    <Panel title="资源"><div className="icons" id="res"><span className="dim">连接后显示</span></div>
    </Panel>
    <Panel title="库存"><div className="icons" id="items"><span className="dim">连接后显示</span></div>
    </Panel>
    <Panel title="主力英雄"><div className="icons" id="hero-strip"><span className="dim">连接后显示</span></div></Panel>
  </div>)
}

export function activitiesPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <div className="activity-toolbar"><p className="dim">选择活动，单独执行或设置自动运行。</p><Button id="activities-refresh" variant="outline" size="sm">刷新活动</Button></div>
    <div id="activities-status" className="dim" role="status" />
    <div className="activity-shell">
      <div id="activity-tabs" className="activity-tabs" role="tablist" aria-label="选择活动" />
      <section id="activity-panel" role="tabpanel" tabIndex={0} hidden>
        <Card><CardHeader><div className="activity-heading"><CardTitle id="activity-title" /><span id="activity-kind" /></div><p id="activity-end" className="dim" /></CardHeader>
          <CardContent className="activity-content">
            <div id="activity-pirates" hidden><div id="pirate-board-view" className="pirate-board" aria-live="polite" /></div>
            <div id="activity-detail"><div id="activities-list" className="activity-body" /><div id="activities-order" /></div>
          </CardContent>
        </Card>
      </section>
    </div>
    <template id="ui-event-switch"><Switch className="p-0" /></template>
  </div>)
}

export function manualPage() {
  return renderToStaticMarkup(<SubTabs name="manual" label="单次操作分类" items={[
    { id: "claim", title: "领取", content: <>
    <Panel title="一键领取">
    <div className="bar">
      <Button id="loot-run" variant="default">领取现在能领的</Button>
      <span id="loot-hint" className="warn"></span>
    </div>
    <p className="dim">领取主线、成就、邮件、挂机收益，以及已拥有英雄的技能展示首领奖励。不花钻石。结果见运行日志。</p>
    </Panel>
    <Panel title="任务奖励">
    <div className="bar">
      <Button id="tasks-plan" variant="outline">检查可领</Button>
      <Button id="tasks-run" variant="default">领取任务奖励</Button>
      <span id="tasks-hint" className="warn"></span>
    </div>
    <p className="dim">主线、支线、成就、每日订单档位。算不出目标值的会跳过。结果见运行日志。</p>

    </Panel>
    </> },
    { id: "world", title: "海面", content: <>
    <Panel title="海面">
    <div className="bar">
      <Option id="world-speedup" label="本轮允许花加速器" checked />
      <Option id="world-reroll" label="本轮拒单重刷" />
      <Button id="world-plan" variant="outline">刷新数据</Button>
      <Button id="world-run" variant="default">执行一轮</Button>
      <span id="world-hint" className="warn"></span>
    </div>
    <div className="who world-summary" id="world-summary" />
    <div id="world-view" className="world-plan">收成品 → 竣工 → 交单 → 按订单缺口排产 → 余料升级建筑。</div>
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    </Panel>
    </> },
    { id: "stock", title: "仓库与资源田", content: <>
    <Panel title="仓库"><div className="icons" id="world-stock"></div>
    </Panel>
    <Panel title="资源田"><pre id="world-fields"></pre></Panel>
    </> },
  ]} />)
}

export function heroesPage() {
  return renderToStaticMarkup(<SubTabs name="heroes" label="英雄功能分类" items={[
    { id: "growth", title: "养成", content: <>
    <Panel title="英雄养成">
<div className="bar">
      <Button id="hero-plan" variant="outline">计算计划</Button>
      <Button id="hero-run" variant="default">执行养成</Button>
      <span id="hero-hint" className="warn"></span>
    </div>
    <p className="dim">升级、升星、升技能的条件取自游戏客户端的红点逻辑；执行前会先算一遍计划。结果见运行日志。</p>
    <div id="hero-table"></div>
    </Panel>
    </> },
    { id: "appoint", title: "任命", content: <>
    <Panel title="英雄任命">
    <div className="bar">
      <Button id="appoint-view" variant="outline">查看职位</Button>
      <Button id="appoint-run" variant="default">一键任命</Button>
    </div>
    <div id="appoint-table" className="dim">按游戏内的职位优先顺序自动分配英雄，已有任命可能调整。</div></Panel>
    </> },
    { id: "equipment", title: "装备", content: <>
    <Panel title="英雄装备">
      <div className="bar"><Button id="equipment-refresh" variant="outline">刷新装备</Button></div>
      <div id="equipment-view" className="progression-view" aria-live="polite" />
    </Panel>
    </> },
    { id: "crafting", title: "制造", content: <>
    <Panel title="装备制造">
      <div className="bar"><Button id="crafting-refresh" variant="outline">刷新装备厂</Button></div>
      <div id="crafting-view" className="progression-view" aria-live="polite" />
    </Panel>
    </> },
    { id: "lineup", title: "阵容", content: <>
    <Panel title="推荐阵容">
      <div className="bar"><Button id="lineup-refresh" variant="outline">刷新推荐</Button></div>
      <div id="lineup-view" className="progression-view" aria-live="polite" />
    </Panel>
    </> },
  ]} />)
}

export function dailiesPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="每日任务">
<div className="bar">
      <Button id="dailies-plan" variant="outline">探测</Button>
      <Button id="dailies-run" variant="default">一键完成</Button>
      <Option id="dailies-paid" label="允许花钻石（默认关闭）" />
      <span id="dailies-hint" className="warn"></span>
    </div>
    <p className="dim">先「探测」看看现在能做哪些、为什么不能做。点金与折扣店默认跳过，勾上才会花钻石。结果见运行日志。</p>
    <div id="dailies-table"></div></Panel>
    <Panel title="联盟">
      <div className="bar"><Button id="guild-refresh" variant="outline">刷新联盟</Button></div>
      <div id="guild-view" className="progression-view" aria-live="polite" />
    </Panel>
  </div>)
}

export function accountPage() {
  return renderToStaticMarkup(<SubTabs name="account" label="账号功能分类" items={[
    { id: "list", title: "账号", content: <>
    <Panel title="账号">
    <div className="bar"><Button id="export-accounts" variant="outline">导出全部账号</Button><span className="dim">备份含登录凭证，请妥善保管。</span></div>
    <div id="accounts"></div>

    </Panel>
    <Panel title="添加账号">
    <div className="bar">
      <Button id="cap-start" variant="default">从电脑微信添加</Button>
      <Button id="cap-douyin" variant="outline">从电脑抖音添加</Button>
      <Button id="cap-stop" variant="destructive">停止抓包</Button>
      <span id="cap-hint" className="warn"></span>
    </div>
    <div id="cap-box"></div>
</Panel>
    </> },
    { id: "worlds", title: "区服", content: <>
    <Panel title="区服">
    <div className="bar">
      <Button id="load-worlds" variant="outline">加载区服</Button>
      <Input id="world-input" aria-label="区服 ID" placeholder="区服 ID" className="w-32" />
      <Button id="enter-world" variant="outline">进入该区服</Button>
      <span id="worlds-hint" className="warn"></span>
    </div>
    <div id="worlds"></div>

    </Panel>
    </> },
    { id: "cred", title: "凭证", content: <>
    <Panel title="凭证">
    <div className="bar">
      <Button id="cred-show" variant="outline">显示凭证</Button>
      <Button id="cred-hide" variant="outline">收起</Button>
      <span className="dim">凭证是本机的明文文件，只在这台电脑上用</span>
    </div>
    <div id="cred"></div>

    </Panel>
    </> },
  ]} />)
}


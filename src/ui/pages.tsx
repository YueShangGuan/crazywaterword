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

/**
 * 渲染总览：角色概况和游戏消息保持全宽，中间各业务面板交由 CSS 瀑布流按内容高度排列。
 */
export function overviewPage() {
  return renderToStaticMarkup(<div className="overview-layout">
    <Panel title="角色概况">
      <div className="who" id="who"><span className="dim">还没连上。点右上角「连接」，或先去「账号」页添加账号。</span></div>
      <Button id="overview-refresh" variant="outline">刷新数据</Button>
    </Panel>

    <div className="overview-masonry">
      <Panel title="资源"><div className="icons" id="res"><span className="dim">连接后显示</span></div>
      </Panel>
      <Panel title="库存"><div className="icons" id="items"><span className="dim">连接后显示</span></div>
      </Panel>
      <Panel title="原材料库存（当前 / 仓库上限）"><div className="material-panel" id="materials" /></Panel>
      <Panel title="农作物库存（当前 / 上限）"><div className="material-panel" id="crops" /></Panel>
      <Panel title="主力英雄"><div className="icons" id="hero-strip"><span className="dim">连接后显示</span></div></Panel>
      <div className="fleet-panel" id="overview-fleets" />
      {['claimable','daily','afk','water','production','trade','merchant-ship','world','guild','progress','collection','data-health'].map(name =>
        <div key={name} className="overview-card" id={'overview-' + name} />)}
    </div>
    <Panel title="游戏消息">
      <div className="message-panel">
        <div className="message-tabs" id="message-tabs">
          {Object.entries({ world:'世界', notice:'通知', private:'私聊', guild:'联盟' }).map(([kind, label]) =>
            <Button key={kind} data-message-tab={kind} variant="outline">{label}</Button>)}
        </div>
        <p className="dim" id="messages-status" />
        <div className="message-list" id="message-list" />
      </div>
    </Panel>
  </div>)
}

export function activitiesPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="当前活动">
      <div className="bar"><Button id="activities-refresh" variant="outline">刷新活动</Button></div>
      <div id="activities-list" aria-live="polite" />
      <template id="ui-event-switch"><Switch className="p-0" /></template>
    </Panel>
    <Panel title="材料来源查询"><label htmlFor="source-query">游戏材料名称</label><Input id="source-query" placeholder="例如：有机土壤" /><div id="source-results" aria-live="polite" /></Panel>
    <Panel title="海盗首杀">
      <div id="pirate-tracker" aria-live="polite" />
      <div id="formation-view" className="progression-view" aria-live="polite" />
      <div id="hunt-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="周订单材料"><div id="activities-order" /></Panel>
  </div>)
}

export function manualPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="一键领取">
    <div className="bar">
      <Button id="loot-run" variant="default">领取现在能领的</Button>
      <span id="loot-hint" className="warn"></span>
    </div>
    <pre id="loot-view">领取主线、成就、邮件、挂机收益，以及已拥有英雄的技能展示首领奖励。不花钻石。</pre>
    </Panel>
    <Panel title="任务奖励">
    <div className="bar">
      <Button id="tasks-plan" variant="outline">检查可领</Button>
      <Button id="tasks-run" variant="default">领取任务奖励</Button>
      <span id="tasks-hint" className="warn"></span>
    </div>
    <pre id="tasks-view">主线、支线、成就、每日订单档位。算不出目标值的会跳过。</pre>

    </Panel>
    <Panel title="海面">
    <div className="bar">
      <Option id="world-speedup" label="本轮允许花加速器" checked />
      <Option id="world-reroll" label="本轮拒单重刷" />
      <Button id="world-plan" variant="outline">刷新数据</Button>
      <Button id="world-run" variant="default">执行一轮</Button>
      <span id="world-hint" className="warn"></span>
    </div>
    <pre id="world-view">收成品 → 竣工 → 交单 → 按订单缺口排产 → 余料升级建筑。</pre>
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    </Panel>
    <Panel title="仓库"><div className="icons" id="world-stock"></div>
    </Panel>
    <Panel title="资源田"><pre id="world-fields"></pre></Panel>
  </div>)
}

/** 选择并保存培养对象；任命和装备等上游独有入口仍保留。 */
export function heroesPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="英雄养成">
<div className="bar">
      <Button id="hero-plan" variant="outline">计算计划</Button>
      <Button id="hero-save" variant="outline">保存所选英雄</Button>
      <Button id="hero-run" variant="default" disabled>培养所选英雄</Button>
      <span id="hero-hint" className="warn"></span>
    </div>
    <pre id="hero-view">先保存所选英雄，再在自动化设置中启用对应培养动作。</pre>
    <div id="hero-selection" className="bar" />
    <div id="hero-table"></div>
    </Panel>
    <Panel title="英雄任命">
    <div className="bar">
      <Button id="appoint-view" variant="outline">查看职位</Button>
      <Button id="appoint-run" variant="default">一键任命</Button>
    </div>
    <div id="appoint-table" className="dim">按游戏内的职位优先顺序自动分配英雄，已有任命可能调整。</div></Panel>
    <Panel title="英雄装备">
      <div className="bar"><Button id="equipment-refresh" variant="outline">刷新装备</Button></div>
      <div id="equipment-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="装备制造">
      <div className="bar"><Button id="crafting-refresh" variant="outline">刷新装备厂</Button></div>
      <div id="crafting-view" className="progression-view" aria-live="polite" />
    </Panel>
  </div>)
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
    <pre id="dailies-view">先「探测」看看现在能做哪些、为什么不能做。点金与折扣店默认跳过，勾上才会花钻石。</pre>
    <div id="dailies-table"></div></Panel>
    <Panel title="联盟">
      <div className="bar"><Button id="guild-refresh" variant="outline">刷新联盟</Button></div>
      <div id="guild-view" className="progression-view" aria-live="polite" />
    </Panel>
  </div>)
}

/** 账号页集中管理本机账号、批量兑换、通知、凭证和双渠道采集。 */
export function accountPage() {
  return renderToStaticMarkup(<div className="grid gap-4">
    <Panel title="账号">
    <div className="bar"><Button id="export-accounts" variant="outline">导出全部账号</Button><span className="dim">备份含登录凭证，请妥善保管。</span></div>
    <div id="accounts"></div>

    </Panel>
    <Panel title="批量兑换码">
      <div className="batch-redeem-layout">
        <div className="batch-redeem-form">
          <label htmlFor="batch-redeem-codes">兑换码</label>
          <textarea id="batch-redeem-codes" className="batch-redeem-codes" rows={5} spellCheck="false" placeholder={'一行一个，或用逗号分隔\n例如：CODE-A, CODE-B'} />
          <div className="bar"><Button id="batch-redeem-run" variant="default">批量兑换</Button><span id="batch-redeem-hint" className="warn" role="status" /></div>
          <p className="dim batch-redeem-note">只调用当前已在线的账号；按账号、兑换码顺序执行。忙碌账号会排队等待，离线账号不会自动登录。</p>
        </div>
        <div className="batch-redeem-feed">
          <div className="batch-redeem-feed-heading"><span>本批结果</span><span id="batch-redeem-summary" className="dim">尚未开始</span></div>
          <div id="batch-redeem-results" className="batch-redeem-results" aria-live="polite">兑换后会在这里显示每个账号的结果。</div>
        </div>
      </div>
    </Panel>
    <Panel title="企微通知（当前账号）">
      <div className="bar">
        <label><input type="checkbox" id="wecom-enabled" /> 自动化异常停止、连接异常断开时通知</label>
        <Input id="wecom-webhook" type="url" autoComplete="off" placeholder="企微机器人 Webhook 地址" />
        <Button id="wecom-save">保存企微通知</Button><span id="wecom-hint" className="warn" />
      </div>
      <p className="dim">配置仅保存在当前账号的本地数据目录，不进入版本库。</p>
    </Panel>
    <Panel title="凭证">
    <div className="bar">
      <Button id="cred-show" variant="outline">显示凭证</Button>
      <Button id="cred-hide" variant="outline">收起</Button>
      <span className="dim">凭证是本机的明文文件，只在这台电脑上用</span>
    </div>
    <div id="cred"></div>

    </Panel>
    <Panel title="区服">
    <div className="bar">
      <Button id="load-worlds" variant="outline">加载区服</Button>
      <Input id="world-input" aria-label="区服 ID" placeholder="区服 ID" className="w-32" />
      <Button id="enter-world" variant="outline">进入该区服</Button>
      <span id="worlds-hint" className="warn"></span>
    </div>
    <div id="worlds"></div>

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
  </div>)
}


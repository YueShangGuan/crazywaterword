import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardContent, CardHeader, CardTitle } from "./card"
import { Input } from "./input"

// 图层开关使用原生 checkbox，页面脚本直接读取 checked，不依赖 Radix Switch 的 aria 状态。
const mapLayers = [
  ["faction", "势力归属", true],
  ["fields", "资源田", false],
  ["myFleets", "我的舰队", true],
  ["allyFleets", "盟友舰队", true],
  ["enemyFleets", "敌方舰队", false],
  ["trade", "我的商船", true],
  ["allyTrade", "友方商船", true],
  ["objects", "世界对象", true],
  ["grid", "网格", true],
] as const

/**
 * 世界地图的静态骨架。画布、图例和详情都由页面脚本在标签页打开后填充。
 *
 * @returns {string} 服务端渲染后的页面标记。
 */
export function mapPage() {
  return renderToStaticMarkup(<div className="world-map-page">
    <Card>
      <CardHeader>
        <div className="world-map-head">
          <CardTitle>世界地图</CardTitle>
          <div className="world-map-toolbar">
            <Button id="map-refresh" variant="outline" size="sm">刷新</Button>
            <Button id="map-fit" variant="outline" size="sm">适应窗口</Button>
            <Button id="map-focus" variant="outline" size="sm">定位舰队</Button>
            <label className="world-map-check"><input id="map-auto" type="checkbox" defaultChecked />自动刷新</label>
            <span id="map-status" className="dim" role="status" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="world-map-layout">
          <div className="world-map-stage" id="map-stage">
            <canvas id="map-canvas" aria-label="世界地图" />
            <div id="map-tooltip" className="world-map-tooltip" hidden />
            <div id="map-empty" className="world-map-empty">正在加载世界地图…</div>
          </div>
          <aside className="world-map-side">
            <div id="map-layers" className="world-map-layers">
              {mapLayers.map(([key, label, checked]) => <label className="world-map-check" key={key}>
                <input type="checkbox" data-map-layer={key} defaultChecked={checked} />{label}
              </label>)}
            </div>
            <div className="world-map-fleets">
              <div className="world-map-section-head"><span className="world-map-section-title">舰队状态</span><span id="map-fleet-count" className="dim" /></div>
              <div id="map-fleets"><span className="dim">连接后显示舰队状态</span></div>
            </div>
            <div className="world-map-war">
              <div className="world-map-section-head"><span className="world-map-section-title">城战</span><span id="map-war-status" className="dim" /></div>
              <div className="world-map-war-flags">
                <label><input id="map-war-enabled" type="checkbox" />城战自动化</label>
                <label><input id="map-war-online" type="checkbox" />领取在线奖</label>
                <label><input id="map-war-reattack" type="checkbox" />重复进攻</label>
                <button id="map-war-save" className="world-map-open" type="button">保存</button>
              </div>
              <div id="map-war-hint" className="dim" />
              <div id="map-war-targets" />
            </div>
            <div id="map-legend" className="world-map-legend" />
            <div id="map-detail" className="world-map-detail dim">点击城池、舰队或商船查看详情</div>
            <p className="world-map-note dim">按真实坐标排布：格子颜色表示城池所属联盟，灰色为中立/野怪城，大城（如山景城）占多格。当前万吨货轮用绿色方框标出（世界 Boss、限时 Boss、硅矿、沉船以菱形标注），静态宝藏位不显示；舰队去货轮等目标时航线直达点位。舰队和商船按需显示，自己的舰队名始终标注。城战目标只列当前可进攻或可防守的城市；选择“自动化”则由现有城战逻辑处理。</p>
          </aside>
        </div>
      </CardContent>
    </Card>
    {/* 游戏消息从账号页移到地图下方：世界/私聊频道的战况与城战播报看地图时一起读。 */}
    <Card>
      <CardHeader><CardTitle>游戏消息</CardTitle></CardHeader>
      <CardContent>
        <div id="message-tabs" className="bar" role="tablist" aria-label="游戏消息分类">
          <Button data-message-tab="world" variant="outline" size="sm">世界</Button>
          <Button data-message-tab="notice" variant="outline" size="sm">通知</Button>
          <Button data-message-tab="private" variant="outline" size="sm">私聊</Button>
          <Button data-message-tab="guild" variant="outline" size="sm">联盟</Button>
        </div>
        <p id="messages-status" className="dim" role="status" />
        <div id="message-list" className="message-list" />
        {/* 发送行：世界/联盟频道可发（SendChatRequest），通知/私聊为只读视图。 */}
        <div className="chat-send bar">
          <Input id="chat-input" aria-label="发送消息" placeholder="输入消息，发送到世界频道" maxLength={120} />
          <Button id="chat-send" size="sm">发送</Button>
        </div>
        <p id="chat-hint" className="dim" role="status" />
      </CardContent>
    </Card>
  </div>)
}

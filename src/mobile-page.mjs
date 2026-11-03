/**
 * 移动端监控原型页面。
 *
 * 该页面先用可操作的演示数据验证移动端信息架构，后续可以把各块数据
 * 替换为现有控制台的 /api/overview、/api/loop、/api/accounts 等接口。
 */
export const MOBILE_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#07151f">
<title>深海控制台 · 疯狂水世界</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #07131c;
    --surface: #0d202b;
    --surface-2: #112b37;
    --surface-3: #173746;
    --line: rgba(161, 222, 220, .12);
    --text: #edf8f5;
    --muted: #86a4a9;
    --soft: #b7d5d3;
    --mint: #83e3ca;
    --mint-deep: #2a8c81;
    --coral: #ff9d79;
    --yellow: #f6d47d;
    --blue: #70b7ff;
    --shadow: 0 20px 60px rgba(0, 0, 0, .24);
    --radius: 22px;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 "Avenir Next", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    letter-spacing: .01em;
  }
  button, input, select { font: inherit; }
  button { color: inherit; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--mint); outline-offset: 2px; }
  .app-shell {
    min-height: 100vh;
    background:
      radial-gradient(circle at 85% 0%, rgba(55, 151, 149, .22), transparent 28%),
      radial-gradient(circle at 0% 38%, rgba(22, 85, 113, .2), transparent 32%),
      var(--bg);
  }
  .app-frame { width: min(100%, 480px); min-height: 100vh; margin: 0 auto; position: relative; overflow: hidden; }
  .screen { min-height: 100vh; padding: 20px 18px 112px; animation: enter .28s ease both; }
  .hidden { display: none !important; }
  .eyebrow { margin: 0 0 6px; color: var(--muted); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 23px; line-height: 1.18; letter-spacing: -.03em; }
  h2 { font-size: 18px; letter-spacing: -.02em; }
  h3 { font-size: 14px; }
  .muted { color: var(--muted); }
  .soft { color: var(--soft); }
  .mint { color: var(--mint); }
  .coral { color: var(--coral); }
  .yellow { color: var(--yellow); }
  .blue { color: var(--blue); }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  .topbar-left { min-width: 0; }
  .role-switch { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 8px; }
  .role-switch button { border: 0; background: transparent; padding: 0; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .avatar { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 10px; color: #08201d; background: linear-gradient(135deg, var(--mint), #d6f5ba); font-size: 12px; font-weight: 800; flex: none; }
  .role-meta { min-width: 0; text-align: left; }
  .role-meta strong { display: block; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .role-meta span { display: block; color: var(--muted); font-size: 11px; }
  .icon-button { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 14px; background: rgba(18, 49, 61, .72); cursor: pointer; }
  .icon-button svg { width: 18px; height: 18px; }
  .sync-note { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 5px rgba(131, 227, 202, .1); }
  .hero-card { position: relative; overflow: hidden; padding: 18px; border: 1px solid rgba(131, 227, 202, .24); border-radius: var(--radius); background: linear-gradient(135deg, rgba(24, 71, 82, .98), rgba(13, 36, 47, .98)); box-shadow: var(--shadow); }
  .hero-card::after { content: ""; position: absolute; width: 190px; height: 190px; top: -88px; right: -64px; border: 1px solid rgba(131, 227, 202, .22); border-radius: 50%; box-shadow: 0 0 0 24px rgba(131, 227, 202, .04), 0 0 0 48px rgba(131, 227, 202, .025); }
  .hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; position: relative; z-index: 1; }
  .hero-top h2 { max-width: 240px; }
  .live-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid rgba(131, 227, 202, .28); border-radius: 999px; color: var(--mint); background: rgba(2, 20, 25, .22); font-size: 11px; white-space: nowrap; }
  .hero-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 20px; position: relative; z-index: 1; }
  .hero-stat strong { display: block; font-size: 20px; letter-spacing: -.04em; }
  .hero-stat span { display: block; margin-top: 3px; color: var(--soft); font-size: 11px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 24px 2px 12px; }
  .section-head button { padding: 0; border: 0; background: transparent; color: var(--mint); font-size: 12px; cursor: pointer; }
  .attention-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 14px 0 4px; }
  .attention-item { padding: 10px 11px; border: 1px solid var(--line); border-radius: 14px; background: rgba(13, 32, 43, .72); }
  .attention-item span { display: block; color: var(--muted); font-size: 10px; }
  .attention-item strong { display: block; margin-top: 4px; font-size: 16px; letter-spacing: -.03em; }
  .attention-item.alert strong { color: var(--coral); }
  .attention-item.wait strong { color: var(--yellow); }
  .attention-item.good strong { color: var(--mint); }
  .status-card { min-width: 0; padding: 14px; border: 1px solid var(--line); border-radius: 18px; background: rgba(13, 32, 43, .76); cursor: pointer; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
  .status-card.status-alert { border-color: rgba(255, 157, 121, .35); background: linear-gradient(145deg, rgba(61, 39, 42, .9), rgba(13, 32, 43, .9)); }
  .status-card.status-wait { border-color: rgba(246, 212, 125, .22); }
  .status-card.status-good { background: rgba(13, 32, 43, .64); }
  .status-card:active { transform: scale(.985); border-color: rgba(131, 227, 202, .46); }
  .status-card.wide { grid-column: 1 / -1; }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .card-head-right { display: flex; align-items: center; gap: 7px; }
  .card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card-icon { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 10px; color: var(--mint); background: rgba(131, 227, 202, .1); }
  .card-icon svg { width: 16px; height: 16px; }
  .card-title strong { font-size: 13px; }
  .chevron { color: #63888d; font-size: 18px; line-height: 1; }
  .status-list { display: grid; gap: 6px; }
  .status-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
  .status-row span { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .status-row strong { min-width: 0; overflow: hidden; color: var(--soft); font-size: 12px; font-weight: 600; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .status-row strong.value { color: var(--text); font-size: 14px; }
  .status-row strong.good { color: var(--mint); }
  .status-row strong.warn { color: var(--yellow); }
  .status-row strong.alert { color: var(--coral); }
  .bar-track { height: 5px; margin-top: 9px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, .08); }
  .bar-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--mint-deep), var(--mint)); }
  .material-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
  .material-item { padding: 9px; border: 1px solid var(--line); border-radius: 13px; background: rgba(6, 20, 28, .32); }
  .material-item span { display: block; color: var(--muted); font-size: 10px; }
  .material-item strong { display: block; margin-top: 3px; font-size: 14px; }
  .tag { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 999px; font-size: 10px; white-space: nowrap; }
  .tag.good { color: var(--mint); background: rgba(131, 227, 202, .1); }
  .tag.wait { color: var(--yellow); background: rgba(246, 212, 125, .1); }
  .tag.alert { color: var(--coral); background: rgba(255, 157, 121, .11); }
  .tag.blue { color: var(--blue); background: rgba(112, 183, 255, .1); }
  .empty-card { padding: 20px; border: 1px dashed var(--line); border-radius: 18px; color: var(--muted); text-align: center; }
  .detail-header { display: flex; align-items: center; gap: 11px; margin-bottom: 22px; }
  .back-button { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); cursor: pointer; }
  .detail-title { min-width: 0; }
  .detail-title h1 { font-size: 20px; }
  .detail-title p { margin-top: 3px; color: var(--muted); font-size: 11px; }
  .detail-hero { padding: 16px; border: 1px solid var(--line); border-radius: 20px; background: linear-gradient(135deg, rgba(20, 59, 69, .9), rgba(11, 33, 44, .96)); }
  .detail-hero-main { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .detail-hero-main strong { display: block; font-size: 27px; letter-spacing: -.05em; }
  .detail-hero-main span { display: block; margin-top: 4px; color: var(--soft); font-size: 12px; }
  .detail-visual { display: grid; gap: 9px; margin-top: 16px; }
  .detail-visual-row { display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
  .detail-visual-row > span { color: var(--muted); font-size: 11px; }
  .detail-visual-row strong { color: var(--soft); font-size: 11px; text-align: right; }
  .detail-visual-track { height: 7px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, .08); }
  .detail-visual-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--mint-deep), var(--mint)); }
  .detail-visual-fill.warn { background: linear-gradient(90deg, #9c7040, var(--yellow)); }
  .detail-visual-fill.alert { background: linear-gradient(90deg, #9b4e4a, var(--coral)); }
  .detail-timeline { display: grid; gap: 8px; }
  .detail-timeline-item { position: relative; padding-left: 15px; color: var(--soft); font-size: 12px; }
  .detail-timeline-item::before { content: ""; position: absolute; top: .55em; left: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px rgba(131, 227, 202, .09); }
  .detail-timeline-item + .detail-timeline-item::after { content: ""; position: absolute; top: -10px; bottom: 12px; left: 3px; width: 1px; background: var(--line); z-index: -1; }
  .detail-timeline-item small { display: block; margin-top: 2px; color: var(--muted); font-size: 10px; }
  .detail-section { margin-top: 22px; }
  .detail-section h2 { margin-bottom: 11px; font-size: 15px; }
  .metric-list, .timeline, .setting-list { display: grid; gap: 8px; }
  .metric-row, .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 13px; border: 1px solid var(--line); border-radius: 15px; background: rgba(13, 32, 43, .75); }
  .metric-row span, .setting-row span { color: var(--muted); font-size: 12px; }
  .metric-row strong { color: var(--soft); font-size: 13px; text-align: right; }
  .setting-row { align-items: flex-start; }
  .setting-copy { min-width: 0; }
  .setting-copy strong { display: block; font-size: 13px; }
  .setting-copy small { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
  .switch { appearance: none; width: 42px; height: 24px; padding: 3px; flex: none; border: 1px solid #42616b; border-radius: 999px; background: #183440; cursor: pointer; }
  .switch::before { content: ""; display: block; width: 16px; height: 16px; border-radius: 50%; background: #88a5aa; transition: transform .18s ease, background .18s ease; }
  .switch:checked { border-color: rgba(131, 227, 202, .6); background: rgba(53, 145, 132, .48); }
  .switch:checked::before { transform: translateX(17px); background: var(--mint); }
  .select-like { padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; color: var(--soft); background: var(--surface-2); }
  .save-bar { position: sticky; bottom: 90px; display: flex; justify-content: flex-end; margin-top: 22px; pointer-events: none; }
  .save-button { padding: 12px 17px; border: 1px solid rgba(131, 227, 202, .38); border-radius: 14px; color: #07221f; background: var(--mint); font-weight: 800; box-shadow: 0 10px 30px rgba(77, 191, 161, .18); cursor: pointer; pointer-events: auto; }
  .channel-tabs { display: flex; gap: 8px; overflow: auto; padding-bottom: 2px; }
  .channel-tab { padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: transparent; white-space: nowrap; cursor: pointer; }
  .channel-tab.active { border-color: rgba(131, 227, 202, .4); color: var(--mint); background: rgba(131, 227, 202, .08); }
  .channel-count { display: inline-grid; min-width: 16px; height: 16px; margin-left: 4px; padding: 0 4px; place-items: center; border-radius: 999px; color: var(--coral); background: rgba(255, 157, 121, .12); font-size: 10px; }
  .chat-list { display: grid; gap: 10px; margin-top: 18px; }
  .chat-item { padding: 12px 13px; border: 1px solid var(--line); border-radius: 16px; background: rgba(13, 32, 43, .72); }
  .chat-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 10px; }
  .chat-meta strong { color: var(--soft); font-size: 12px; }
  .chat-body { margin-top: 6px; color: #d9e9e5; font-size: 13px; }
  .unread-line { display: flex; align-items: center; gap: 7px; margin: 18px 0 8px; color: var(--coral); font-size: 11px; }
  .unread-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--coral); }
  .run-hero { padding: 18px; border: 1px solid rgba(112, 183, 255, .25); border-radius: 22px; background: linear-gradient(135deg, #153449, #0d2533); }
  .run-hero.running { border-color: rgba(131, 227, 202, .35); background: linear-gradient(135deg, #15463f, #0d2d35); }
  .run-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
  .run-status { display: flex; align-items: center; gap: 10px; }
  .gear { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 16px; color: var(--blue); background: rgba(112, 183, 255, .12); font-size: 26px; }
  .running .gear { color: var(--mint); background: rgba(131, 227, 202, .12); animation: spin 3s linear infinite; }
  .run-status strong { display: block; font-size: 18px; }
  .run-status span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
  .run-action { padding: 9px 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(3, 16, 23, .22); cursor: pointer; }
  .run-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
  .run-summary-item { padding: 11px; border: 1px solid var(--line); border-radius: 14px; background: rgba(13, 32, 43, .72); }
  .run-summary-item span { display: block; color: var(--muted); font-size: 10px; }
  .run-summary-item strong { display: block; margin-top: 4px; color: var(--soft); font-size: 12px; line-height: 1.35; }
  .run-summary-item.good strong { color: var(--mint); }
  .run-summary-item.warn strong { color: var(--yellow); }
  .plan-card { margin-top: 14px; padding: 15px; border: 1px solid var(--line); border-radius: 18px; background: rgba(13, 32, 43, .7); }
  .plan-row { display: flex; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .plan-row:last-child { border-bottom: 0; padding-bottom: 0; }
  .plan-row:first-child { padding-top: 0; }
  .plan-row span { color: var(--muted); font-size: 12px; }
  .plan-row strong { font-size: 13px; }
  .log-list { display: grid; gap: 8px; }
  .log-item { display: grid; grid-template-columns: 46px 1fr; gap: 10px; color: var(--soft); font-size: 12px; }
  .log-item time { color: var(--muted); font-size: 10px; }
  .preference-group { padding: 15px; border: 1px solid var(--line); border-radius: 18px; background: rgba(13, 32, 43, .7); }
  .preference-group + .preference-group { margin-top: 11px; }
  .preference-group h3 { margin-bottom: 11px; }
  .settings-jump { display: flex; gap: 7px; overflow: auto; margin: 2px 0 14px; padding-bottom: 2px; }
  .settings-jump button { flex: none; padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: transparent; font-size: 11px; cursor: pointer; }
  .settings-jump button:hover { border-color: rgba(131, 227, 202, .42); color: var(--mint); }
  .preference-group .setting-row { padding: 11px 0; border: 0; border-radius: 0; background: transparent; }
  .preference-group .setting-row + .setting-row { border-top: 1px solid var(--line); }
  .account-list { display: grid; gap: 10px; margin-top: 18px; }
  .account-current { display: flex; align-items: center; gap: 11px; padding: 15px; border: 1px solid rgba(131, 227, 202, .35); border-radius: 19px; background: linear-gradient(135deg, rgba(20, 67, 70, .9), rgba(13, 32, 43, .85)); }
  .account-current .account-copy { flex: 1; }
  .account-statuses { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .account-statuses .tag { font-size: 10px; }
  .account-card { display: flex; align-items: center; gap: 11px; padding: 14px; border: 1px solid var(--line); border-radius: 18px; background: rgba(13, 32, 43, .72); cursor: pointer; }
  .account-card.active { border-color: rgba(131, 227, 202, .52); background: linear-gradient(135deg, rgba(20, 67, 70, .9), rgba(13, 32, 43, .85)); }
  .account-card .avatar { width: 38px; height: 38px; border-radius: 13px; }
  .account-copy { min-width: 0; flex: 1; }
  .account-copy strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-copy span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
  .account-check { color: var(--mint); font-size: 17px; }
  .bottom-nav { position: fixed; z-index: 10; right: 0; bottom: 0; left: 0; display: flex; justify-content: center; padding: 8px 14px calc(8px + env(safe-area-inset-bottom)); background: linear-gradient(180deg, transparent, rgba(7, 19, 28, .96) 28%); pointer-events: none; }
  .bottom-nav-inner { width: min(calc(100% - 4px), 452px); display: grid; grid-template-columns: repeat(5, 1fr); padding: 7px; border: 1px solid rgba(152, 212, 211, .16); border-radius: 22px; background: rgba(10, 31, 42, .94); box-shadow: 0 14px 35px rgba(0, 0, 0, .28); backdrop-filter: blur(18px); pointer-events: auto; }
  .nav-item { position: relative; display: grid; justify-items: center; gap: 3px; padding: 7px 2px; border: 0; border-radius: 15px; color: var(--muted); background: transparent; font-size: 10px; cursor: pointer; }
  .nav-item svg { width: 19px; height: 19px; }
  .nav-item.active { color: var(--mint); background: rgba(131, 227, 202, .09); }
  .nav-badge { position: absolute; top: 1px; left: calc(50% + 7px); width: 7px; height: 7px; border: 2px solid #0a1f2a; border-radius: 50%; background: var(--coral); }
  .toast { position: fixed; z-index: 20; right: 18px; bottom: 100px; left: 18px; display: flex; justify-content: center; pointer-events: none; }
  .toast span { padding: 10px 14px; border: 1px solid rgba(131, 227, 202, .3); border-radius: 12px; color: var(--mint); background: rgba(14, 47, 50, .96); box-shadow: var(--shadow); font-size: 12px; animation: toast-in .22s ease both; }
  @keyframes enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @media (min-width: 700px) { body { padding: 18px 0; } .app-frame { min-height: calc(100vh - 36px); border: 1px solid rgba(152, 212, 211, .12); border-radius: 32px; box-shadow: 0 24px 100px rgba(0, 0, 0, .34); } .bottom-nav { position: absolute; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; } }
</style>
</head>
<body>
<div class="app-shell">
  <div class="app-frame">
    <main id="screen-home" class="screen"></main>
    <main id="screen-chat" class="screen hidden"></main>
    <main id="screen-idle" class="screen hidden"></main>
    <main id="screen-settings" class="screen hidden"></main>
    <main id="screen-account" class="screen hidden"></main>
    <main id="screen-detail" class="screen hidden"></main>
    <nav id="bottom-nav" class="bottom-nav" aria-label="主导航"></nav>
    <div id="toast" class="toast" aria-live="polite"></div>
  </div>
</div>
<script>
(() => {
  'use strict';

  const icons = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.9 8.9 0 0 1-3.2-.6L4 20l1.5-3.5A7.4 7.4 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/></svg>',
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 15 .1.1a1.9 1.9 0 0 1-2.7 2.7l-.1-.1a1.9 1.9 0 0 0-3.2 1.3v.2a1.9 1.9 0 0 1-3.8 0V19a1.9 1.9 0 0 0-3.2-1.3l-.1.1a1.9 1.9 0 0 1-2.7-2.7l.1-.1A1.9 1.9 0 0 0 4.6 12a1.9 1.9 0 0 0-1.3-3.2h-.2a1.9 1.9 0 0 1 0-3.8h.2A1.9 1.9 0 0 0 4.6 1.8l-.1-.1a1.9 1.9 0 0 1 2.7-2.7l.1.1A1.9 1.9 0 0 0 10.5 0h.2a1.9 1.9 0 0 1 3.8 0h.2a1.9 1.9 0 0 0 3.2 1.3l.1-.1a1.9 1.9 0 0 1 2.7 2.7l-.1.1A1.9 1.9 0 0 0 21.8 7v.2a1.9 1.9 0 0 1 0 3.8h-.2a1.9 1.9 0 0 0-2.2 4Z" transform="translate(1.1 1.1) scale(.91)"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.7-3.3 3.2-5 7.5-5s6.8 1.7 7.5 5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 5-7 7 7 7"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 0 0-14.8-3L3 11"/><path d="M3 5v6h6"/><path d="M4 13a8 8 0 0 0 14.8 3L21 13"/><path d="M21 19v-6h-6"/></svg>',
    userCard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M6 16c.6-1.7 1.6-2.5 3-2.5s2.4.8 3 2.5M14 9h4M14 13h4M14 17h3"/></svg>',
    fleet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16.5 7 7h10l3 9.5"/><path d="M3 16.5h18M6 20h12M8 7l1.5-3h5L16 7"/><circle cx="8" cy="17" r="1.2"/><circle cx="16" cy="17" r="1.2"/></svg>',
    field: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20c7-1 12-5.5 15-14-7 .5-12 5.2-15 14Z"/><path d="M4 20c2.2-4 5-6.7 8.5-8.5"/></svg>',
    forge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.5 4c1.6 2.8 1.8 4.5.7 6.1-.7 1-1.8 1.6-2.7 2.8-1.6-1.2-2.7-2.7-2.7-4.7C9.8 6.4 11.6 4.8 14.5 4Z"/><path d="M8.2 13.2c-2 1.5-3 3.1-3 4.8 0 2.2 2.3 3.8 6.8 3.8s6.8-1.6 6.8-3.8c0-1.6-1-3.2-3-4.7"/><path d="M9 18h6"/></svg>',
    beast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12c0-3.8 3.3-6.5 8-6.5s8 2.7 8 6.5-3.3 6.5-8 6.5-8-2.7-8-6.5Z"/><path d="m7 6 1.5-3L11 5M17 6l-1.5-3L13 5M9 12h.01M15 12h.01M10 15c1.2.8 2.8.8 4 0"/></svg>',
    challenge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.2 5.7L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.3L12 3Z"/><path d="m19 3 .6 1.5L21 5l-1.4.5L19 7l-.6-1.5L17 5l1.4-.5L19 3Z"/></svg>',
    material: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
    factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V9l6 3V8l6 3V6l4 2v12H4Z"/><path d="M7 16h2M12 16h2M17 16h2"/></svg>',
    ship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 16h16l-2 3H6l-2-3ZM7 16V7h10v9M9 7V4h6v3M12 10v3"/></svg>'
  };

  const state = {
    tab: 'home',
    detail: null,
    chatChannel: 'world',
    unreadChat: true,
    running: true,
    lastSync: new Date(),
    activeAccount: 0,
    savedSettings: false,
    accounts: [
      { name: '深海拾荒者', zone: '微信一区 · 112服', level: 68, initials: '深', connected: true, running: true },
      { name: '潮汐观测站', zone: '微信二区 · 37服', level: 42, initials: '潮', connected: true, running: false },
      { name: '珊瑚灯塔', zone: '微信一区 · 89服', level: 31, initials: '珊', connected: false, running: false }
    ],
    cards: [
      { id: 'materials', icon: 'material', title: '原材料库存', priority: 1, tag: ['alert', '2项偏低'], materials: [['海盐晶', '184 / 800', 23], ['蓝铜矿', '92 / 500', 18]], wide: true },
      { id: 'fleet', icon: 'fleet', title: '舰队状态', priority: 2, tag: ['good', '3 / 5 运行'], rows: [['当前状态', '2 支执行中', 'good'], ['下一节点', '城战 · 20:30', ''], ['万吨运输', '装载中 · 72%', 'warn']], progress: 72, wide: true },
      { id: 'field', icon: 'field', title: '农田状态', priority: 3, tag: ['wait', '2块待收'], rows: [['当前状态', '番茄 × 240', ''], ['下一节点', '12分 08秒', 'warn'], ['空闲地块', '1 / 8', 'good']], progress: 62 },
      { id: 'forge', icon: 'forge', title: '锻造房', priority: 4, tag: ['good', '制作中'], rows: [['当前状态', '深海合金', ''], ['下一节点', '26分 41秒', 'warn'], ['生产队列', '2 / 3', '']], progress: 48 },
      { id: 'merchant', icon: 'ship', title: '海商王船队', priority: 5, tag: ['wait', '返航 1 / 3'], rows: [['当前状态', '旗舰返航 · 24分', 'warn'], ['下一节点', '北部贸易港', ''], ['可交订单', '3项', 'good']] },
      { id: 'challenge', icon: 'challenge', title: '闯关状态', priority: 6, tag: ['blue', '挂机中'], rows: [['当前状态', '深渊 27-4', 'value'], ['下一节点', '04分 12秒', 'good'], ['本轮收益', '金币 +18.2万', '']], progress: 81 },
      { id: 'daily', icon: 'challenge', title: '今日进度', priority: 7, tag: ['good', '7 / 10 项'], rows: [['当前状态', '日常任务 7 / 10', 'value'], ['下一节点', '3 项待领取', 'good'], ['体力', '86 / 120', '']], progress: 70 },
      { id: 'beast', icon: 'beast', title: '海兽培养', priority: 8, tag: ['good', '培育中'], rows: [['当前状态', '潮汐巨鳐', ''], ['下一节点', '1小时 42分', 'warn'], ['成长阶段', '成熟期 · 68%', 'good']], progress: 68 },
      { id: 'factory', icon: 'factory', title: '工厂状态', priority: 9, tag: ['good', '4座运行'], rows: [['当前状态', '4 座运行中', 'good'], ['下一节点', '能源提炼厂 · 2项', 'warn'], ['空闲工厂', '装备工坊', '']] }
    ],
    chat: {
      world: [['海风吹过', '世界', '刚刚', '有人知道今天的海兽刷新点吗？'], ['北纬三十度', '世界', '2分钟前', '雷达情报已共享，坐标在东南礁。'], ['小岛维修工', '世界', '5分钟前', '求组城战，差一位前排。']],
      notice: [['系统通知', '通知', '刚刚', '你的「深海合金」已完成。'], ['海商王', '通知', '18分钟前', '旗舰逐浪即将抵达港口。']],
      private: [['潮汐观测站', '私聊', '3分钟前', '今晚一起打 28 层吗？'], ['深蓝七号', '私聊', '1小时前', '已把工厂排期发你了。']],
      guild: [['灯塔守望者', '联盟', '刚刚', '联盟城战将在 20:30 开始。'], ['副盟主', '联盟', '12分钟前', '记得把闲置舰队派到北港。']]
    },
    chatUnread: { world: 2, notice: 1, private: 0, guild: 1 },
    logs: [['刚刚', '雷达情报完成一轮侦察'], ['1分钟前', '海兽培养进度更新为 68%'], ['3分钟前', '锻造房开始制作深海合金'], ['7分钟前', '挂机循环第 12 轮完成']],
    detailData: {
      daily: { subtitle: '任务、奖励与体力进度', main: ['7 / 10', '今日任务已完成'], stats: [['角色等级', 'Lv.68'], ['钻石库存', '12,840'], ['金币库存', '2,480万'], ['体力', '86 / 120'], ['待领取奖励', '3 项']], settings: [['自动领取可领取奖励', '进入页面后自动处理主线、成就与邮件奖励', true], ['低于体力阈值提醒', '体力达到 100% 前提醒一次', true]] },
      fleet: { subtitle: '情报、城战与万吨舰队', main: ['3 / 5', '舰队正在运行'], stats: [['雷达情报', '侦察中 · 剩余 18 分钟'], ['城战', '待命 · 下一场 20:30'], ['万吨运输', '装载中 · 72%'], ['空闲舰队', '2 支'], ['今日派遣', '8 / 12 次']], settings: [['自动派出空闲舰队', '优先执行雷达情报，再安排万吨运输', true], ['城战前自动集结', '在开战前 10 分钟完成舰队集结', true], ['允许钻石加速', '只在超过设定等待时间后使用', false]] },
      field: { subtitle: '地块、作物和收获排期', main: ['2 块', '即将成熟'], stats: [['当前批次', '番茄 × 240'], ['预计收获', '12 分 08 秒'], ['空闲地块', '1 / 8'], ['今日收获', '1,260 / 2,000'], ['缺口作物', '番茄、海藻']], settings: [['成熟后自动收获', '收获后按缺口优先补种', true], ['库存满时暂停种植', '避免成熟作物溢出仓库', true]] },
      forge: { subtitle: '锻造队列和材料消耗', main: ['2 / 3', '队列正在制作'], stats: [['当前制作', '深海合金 × 4'], ['剩余时间', '26 分 41 秒'], ['下一项', '雷达核心 × 1'], ['材料余量', '蓝铜矿 92'], ['今日完成', '6 项']], settings: [['自动补充锻造队列', '按仓库最低库存自动排入下一项', true], ['材料低于安全线暂停', '避免把其他模块的材料耗尽', true]] },
      beast: { subtitle: '海兽成长和培育排程', main: ['68%', '当前成长进度'], stats: [['培育对象', '潮汐巨鳐'], ['成长阶段', '成熟期'], ['预计完成', '1 小时 42 分'], ['今日投喂', '8 / 12 次'], ['培育槽位', '2 / 3']], settings: [['自动投喂', '优先使用低级饲料，保留稀有饲料', true], ['成熟后继续培育', '自动选择下一只待培育海兽', false]] },
      challenge: { subtitle: '当前关卡和挂机收益', main: ['27-4', '正在挑战'], stats: [['已挂机时长', '02:18:42'], ['本轮收益', '金币 +18.2 万'], ['预计下一轮', '04 分 12 秒'], ['今日挑战', '18 / 30 次'], ['失败重试', '已开启']], settings: [['失败自动重试', '连续失败 3 次后暂停并提醒', true], ['通关后继续挂机', '直到达到设定的最高关卡', true], ['仅在低耗时关卡加速', '每轮不超过 20 钻石', false]] },
      materials: { subtitle: '默认显示最低库存的两项材料', main: ['2 项', '低于安全线'], stats: [['海盐晶', '184 / 800 · 23%'], ['蓝铜矿', '92 / 500 · 18%'], ['珊瑚木', '420 / 900 · 46%'], ['深渊石', '320 / 700 · 45%'], ['安全库存线', '30%']], settings: [['低库存提醒', '材料低于安全库存线时推送提醒', true], ['自动调整生产排期', '优先补足最低库存材料', true]] },
      factory: { subtitle: '各工厂运行标记和生产排期', main: ['4 座', '正在运行'], stats: [['深海冶炼厂', '深海合金 · 26 分钟'], ['能源提炼厂', '潮汐能源 · 排期 2 项'], ['机械工坊', '雷达核心 · 1 小时 04 分'], ['装备工坊', '空闲'], ['今日完成', '14 项']], settings: [['按缺口自动排产', '优先补足原材料库存最低项', true], ['空闲工厂提醒', '工厂空闲超过 10 分钟提醒', true]] },
      merchant: { subtitle: '船队航行、货舱和订单', main: ['1 / 3', '船队正在返航'], stats: [['旗舰「逐浪」', '返航 · 24 分钟'], ['货舱', '68 / 100'], ['可交订单', '3 项'], ['下一港口', '北部贸易港'], ['今日收益', '金币 +42.8 万']], settings: [['自动接取高价值订单', '只接取缺口材料可满足的订单', true], ['返航后自动派遣', '优先派遣到缺口最高的港口', true]] }
    }
  };

  /** 创建带有属性和子节点的 HTML 节点，集中处理原型中的安全文本插入。 */
  function node(tag, attrs, children) {
    const element = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === 'class') element.className = value;
      else if (key === 'html') element.innerHTML = value;
      else if (key === 'checked') element.checked = Boolean(value);
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value);
    });
    (Array.isArray(children) ? children : [children]).filter(Boolean).forEach((child) => {
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return element;
  }

  /** 返回当前账号，用于所有页面顶部的身份信息保持一致。 */
  function account() { return state.accounts[state.activeAccount]; }

  /** 显示一次轻提示，反馈保存、切号等不会打断监控的操作结果。 */
  function toast(message) {
    const root = document.getElementById('toast');
    root.replaceChildren(node('span', {}, message));
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => root.replaceChildren(), 2400);
  }

  /** 生成顶部身份区，保证角色切换后首页和二级页立即反映当前账号。 */
  function topbar(title, kicker) {
    const current = account();
    return node('div', { class: 'topbar' }, [
      node('div', { class: 'topbar-left' }, [
        node('p', { class: 'eyebrow' }, kicker || '深海控制台'),
        node('h1', {}, title),
        node('div', { class: 'role-switch' }, node('button', { type: 'button', onclick: () => selectTab('account') }, [
          node('span', { class: 'avatar' }, current.initials),
          node('span', { class: 'role-meta' }, [node('strong', {}, current.name), node('span', {}, current.zone)])
        ]))
      ]),
      node('button', { class: 'icon-button', type: 'button', 'aria-label': '刷新状态', html: icons.refresh, onclick: refreshData })
    ]);
  }

  /** 生成首页状态卡，控制每块只保留三四行核心信息。 */
  function statusCard(card) {
    const title = node('div', { class: 'card-title' }, [node('span', { class: 'card-icon', html: icons[card.icon] }), node('strong', {}, card.title)]);
    const head = node('div', { class: 'card-head' }, [title, node('div', { class: 'card-head-right' }, [node('span', { class: 'tag ' + card.tag[0] }, card.tag[1]), node('span', { class: 'chevron' }, '›')])]);
    const body = [];
    if (card.rows) {
      body.push(node('div', { class: 'status-list' }, card.rows.map((row) => node('div', { class: 'status-row' }, [node('span', {}, row[0]), node('strong', { class: row[2] || '' }, row[1])]))));
      if (card.progress !== undefined) body.push(node('div', { class: 'bar-track' }, node('div', { class: 'bar-fill', style: 'width:' + card.progress + '%' })));
    } else {
      body.push(node('div', { class: 'material-grid' }, card.materials.map((item) => node('div', { class: 'material-item' }, [node('span', {}, item[0]), node('strong', {}, item[1]), node('div', { class: 'bar-track' }, node('div', { class: 'bar-fill', style: 'width:' + item[2] + '%' }))]))));
    }
    return node('article', { class: 'status-card status-' + card.tag[0] + (card.wide ? ' wide' : ''), role: 'button', tabindex: '0', onclick: () => openDetail(card.id), onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(card.id); } } }, [head].concat(body));
  }

  /** 渲染首页总览，把状态浓缩在可扫读的卡片中。 */
  function renderHome() {
    const root = document.getElementById('screen-home');
    root.replaceChildren(topbar('总览', '实时状态 · 自动刷新'));
    const current = account();
    root.append(
      node('section', { class: 'hero-card' }, [
        node('div', { class: 'hero-top' }, [node('div', {}, [node('p', { class: 'eyebrow' }, '实时概况'), node('h2', {}, '运行概览')]), node('span', { class: 'live-chip' }, [node('span', { class: 'pulse' }), state.running ? '挂机运行中' : '挂机已暂停'])]),
        node('div', { class: 'hero-stats' }, [node('div', { class: 'hero-stat' }, [node('strong', {}, '128.6万'), node('span', {}, '当前战力')]), node('div', { class: 'hero-stat' }, [node('strong', {}, '12,840'), node('span', {}, '钻石库存')]), node('div', { class: 'hero-stat' }, [node('strong', {}, current.zone.split(' · ')[1]), node('span', {}, '当前区服')])])
      ]),
      node('div', { class: 'sync-note', style: 'margin-top:10px' }, [node('span', { class: 'pulse' }), '已同步 · ' + state.lastSync.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })]),
      node('div', { class: 'section-head' }, [node('h2', {}, '功能状态'), node('button', { type: 'button', onclick: () => toast('首页状态会自动刷新') }, '查看刷新规则')]),
      node('div', { class: 'attention-strip' }, [
        node('div', { class: 'attention-item alert' }, [node('span', {}, '低库存'), node('strong', {}, '1 项')]),
        node('div', { class: 'attention-item wait' }, [node('span', {}, '即将完成'), node('strong', {}, '3 项')]),
        node('div', { class: 'attention-item good' }, [node('span', {}, '异常暂停'), node('strong', {}, '0 项')])
      ]),
      node('div', { class: 'status-grid' }, state.cards.slice().sort((a, b) => a.priority - b.priority).map(statusCard))
    );
  }

  /** 根据模块类型生成不同的详情视觉，避免所有模块都用同一个装饰性圆环。 */
  function renderDetailVisual(id) {
    const visuals = {
      daily: [['任务完成', 70, '7 / 10 项', 'good'], ['奖励待领', 30, '3 项', 'warn']],
      fleet: [['雷达情报', 62, '侦察中', 'good'], ['万吨运输', 72, '装载中', 'warn'], ['城战集结', 18, '待命', '']],
      field: [['番茄批次', 62, '12 分钟', 'warn'], ['地块使用', 88, '7 / 8 块', 'good']],
      forge: [['当前制作', 48, '26 分钟', 'warn'], ['队列占用', 67, '2 / 3 项', 'good']],
      beast: [['成长进度', 68, '成熟期', 'good'], ['培育槽位', 67, '2 / 3 个', 'good']],
      challenge: [['关卡进度', 81, '深渊 27-4', 'good'], ['今日次数', 60, '18 / 30 次', '']],
      materials: [['海盐晶', 23, '184 / 800', 'alert'], ['蓝铜矿', 18, '92 / 500', 'alert'], ['珊瑚木', 46, '420 / 900', 'good']],
    };
    if (visuals[id]) {
      return node('div', { class: 'detail-visual' }, visuals[id].map((item) => node('div', { class: 'detail-visual-row' }, [node('span', {}, item[0]), node('div', { class: 'detail-visual-track' }, node('div', { class: 'detail-visual-fill ' + item[3], style: 'width:' + item[1] + '%' })), node('strong', {}, item[2])] )));
    }
    const timelines = {
      factory: [['深海冶炼厂', '深海合金 · 26 分钟'], ['能源提炼厂', '排期 2 项'], ['机械工坊', '雷达核心 · 1 小时 04 分']],
      merchant: [['旗舰「逐浪」', '返航 · 24 分钟'], ['下一港口', '北部贸易港'], ['可交订单', '3 项']]
    };
    return node('div', { class: 'detail-timeline' }, timelines[id].map((item) => node('div', { class: 'detail-timeline-item' }, [item[0], node('small', {}, item[1])] )));
  }

  /** 根据卡片配置生成二级页面，详情后紧接着放置该模块的设置。 */
  function renderDetail() {
    const id = state.detail;
    const card = state.cards.find((item) => item.id === id);
    const data = state.detailData[id];
    const root = document.getElementById('screen-detail');
    root.replaceChildren(node('div', { class: 'detail-header' }, [node('button', { class: 'back-button', type: 'button', html: icons.back, 'aria-label': '返回首页', onclick: () => selectTab('home') }), node('div', { class: 'detail-title' }, [node('h1', {}, card.title), node('p', {}, data.subtitle)])]));
    root.append(
      node('section', { class: 'detail-hero' }, [node('div', { class: 'detail-hero-main' }, [node('div', {}, [node('strong', {}, data.main[0]), node('span', {}, data.main[1])])]), renderDetailVisual(id)]),
      node('section', { class: 'detail-section' }, [node('h2', {}, '当前详情'), node('div', { class: 'metric-list' }, data.stats.map((item) => node('div', { class: 'metric-row' }, [node('span', {}, item[0]), node('strong', {}, item[1])])))]),
      node('section', { class: 'detail-section' }, [node('h2', {}, '相关设置'), node('div', { class: 'setting-list' }, data.settings.map((item) => node('label', { class: 'setting-row' }, [node('span', { class: 'setting-copy' }, [node('strong', {}, item[0]), node('small', {}, item[1])]), node('input', { class: 'switch', type: 'checkbox', checked: item[2] })])))]),
      node('div', { class: 'save-bar' }, node('button', { class: 'save-button', type: 'button', onclick: saveDetail }, state.savedSettings ? '已保存' : '保存设置'))
    );
  }

  /** 渲染聊天频道，进入聊天页时清除底部导航上的未读提示。 */
  function renderChat() {
    const root = document.getElementById('screen-chat');
    const channels = [['world', '世界'], ['notice', '通知'], ['private', '私聊'], ['guild', '联盟']];
    root.replaceChildren(topbar('消息中心', '世界、通知、私聊与联盟'), node('div', { class: 'section-head' }, [node('h2', {}, '消息频道'), node('button', { type: 'button', onclick: markAllChatRead }, '全部已读')]), node('div', { class: 'channel-tabs' }, channels.map((channel) => node('button', { class: 'channel-tab' + (state.chatChannel === channel[0] ? ' active' : ''), type: 'button', onclick: () => openChatChannel(channel[0]) }, [channel[1], state.chatUnread[channel[0]] ? node('span', { class: 'channel-count' }, state.chatUnread[channel[0]]) : null]))));
    const items = state.chat[state.chatChannel];
    const unread = state.chatUnread[state.chatChannel] || 0;
    root.append(unread ? node('div', { class: 'unread-line' }, [node('span', { class: 'unread-dot' }), '本频道有 ' + unread + ' 条未读消息']) : null);
    root.append(node('div', { class: 'chat-list' }, items.map((item) => node('article', { class: 'chat-item' }, [node('div', { class: 'chat-meta' }, [node('strong', {}, item[0]), node('span', { class: 'tag blue' }, item[1]), node('span', {}, item[2])]), node('p', { class: 'chat-body' }, item[3])]))));
  }

  /** 切换消息频道并清除当前频道的演示未读数量。 */
  function openChatChannel(channel) {
    state.chatChannel = channel;
    state.chatUnread[channel] = 0;
    state.unreadChat = Object.values(state.chatUnread).some((count) => count > 0);
    renderChat();
    renderNav();
  }

  /** 清除所有频道的演示未读提示，验证消息中心的批量处理入口。 */
  function markAllChatRead() {
    Object.keys(state.chatUnread).forEach((channel) => { state.chatUnread[channel] = 0; });
    state.unreadChat = false;
    renderChat();
    renderNav();
    toast('消息已全部标记为已读');
  }

  /** 渲染挂机页，把运行状态、运行计划和日志放在同一条纵向路径上。 */
  function renderIdle() {
    const root = document.getElementById('screen-idle');
    root.replaceChildren(topbar('挂机', '运行计划 · 执行日志'));
    root.append(
      node('section', { class: 'run-hero' + (state.running ? ' running' : '') }, node('div', { class: 'run-top' }, [node('div', { class: 'run-status' }, [node('span', { class: 'gear' }, '⚙'), node('div', {}, [node('strong', {}, state.running ? '挂机运行中' : '挂机已暂停'), node('span', {}, state.running ? '第 12 轮 · 下次执行 04:12' : '点击右侧按钮继续运行')])]), node('button', { class: 'run-action', type: 'button', onclick: toggleRun }, state.running ? '暂停' : '继续')])),
      node('div', { class: 'run-summary-grid' }, [
        node('div', { class: 'run-summary-item good' }, [node('span', {}, '当前'), node('strong', {}, state.running ? '第 12 轮运行中' : '已暂停')]),
        node('div', { class: 'run-summary-item warn' }, [node('span', {}, '下一步'), node('strong', {}, state.running ? '04 分 12 秒后执行' : '等待继续')]),
        node('div', { class: 'run-summary-item' }, [node('span', {}, '最近结果'), node('strong', {}, '雷达情报完成')])
      ]),
      node('section', { class: 'plan-card' }, [node('div', { class: 'plan-row' }, [node('span', {}, '运行计划'), node('strong', {}, '不限次数')]), node('div', { class: 'plan-row' }, [node('span', {}, '执行间隔'), node('strong', {}, '每 60 秒')]), node('div', { class: 'plan-row' }, [node('span', {}, '执行模块'), node('strong', {}, '全选 · 14 项')]), node('div', { class: 'plan-row' }, [node('span', {}, '付费动作'), node('strong', { class: 'yellow' }, '仅按额度执行')])]),
      node('div', { class: 'section-head' }, [node('h2', {}, '运行日志'), node('button', { type: 'button', onclick: () => toast('日志已保持最近 50 条') }, '清理')]),
      node('div', { class: 'log-list' }, state.logs.map((item) => node('div', { class: 'log-item' }, [node('time', {}, item[0]), node('span', {}, item[1])])) )
    );
  }

  /** 渲染完整设置页，集中承载首页二级页没有展开的全局开关。 */
  function renderSettings() {
    const root = document.getElementById('screen-settings');
    root.replaceChildren(topbar('设置', '全局挂机策略'));
    const groupIds = ['settings-run', 'settings-notice', 'settings-safety', 'settings-refresh'];
    root.append(node('div', { class: 'settings-jump' }, ['运行策略', '提醒通知', '消耗安全', '刷新频率'].map((label, index) => node('button', { type: 'button', onclick: () => document.getElementById(groupIds[index]).scrollIntoView({ behavior: 'smooth', block: 'start' }) }, label))));
    const groups = [
      ['运行策略', [['自动挂机总开关', '关闭后保留计划，不再执行动作', true], ['异常后自动暂停', '接口连续失败时暂停并提醒', true], ['仅 Wi-Fi 自动运行', '移动网络下只读状态', false]]],
      ['提醒通知', [['低库存提醒', '材料低于安全线时推送', true], ['聊天新消息', '世界、私聊和联盟消息提醒', true], ['挂机完成提醒', '每轮结束后推送摘要', false]]],
      ['消耗安全', [['允许钻石加速', '遵守账号额度和模块限额', false], ['允许接取付费订单', '需要在执行前再次确认', false], ['危险操作二次确认', '城战、切号等操作保留确认层', true]]]
    ];
    groups.forEach((group, index) => root.append(node('section', { class: 'preference-group', id: groupIds[index] }, [node('h3', {}, group[0]), node('div', { class: 'setting-list' }, group[1].map((item) => node('label', { class: 'setting-row' }, [node('span', { class: 'setting-copy' }, [node('strong', {}, item[0]), node('small', {}, item[1])]), node('input', { class: 'switch', type: 'checkbox', checked: item[2] })])))])));
    root.append(node('section', { class: 'preference-group', id: 'settings-refresh' }, [node('h3', {}, '刷新频率'), node('div', { class: 'setting-row' }, [node('span', { class: 'setting-copy' }, [node('strong', {}, '状态刷新间隔'), node('small', {}, '首页和二级页使用同一频率')]), node('span', { class: 'select-like' }, '5 秒 ▾')])]));
  }

  /** 渲染账号页，切换账号后所有页面顶部身份和区服信息同步更新。 */
  function renderAccounts() {
    const root = document.getElementById('screen-account');
    root.replaceChildren(topbar('账号', '已登录账号 · 一键切换'));
    const current = account();
    root.append(node('section', { class: 'account-current' }, [node('span', { class: 'avatar' }, current.initials), node('span', { class: 'account-copy' }, [node('strong', {}, current.name), node('span', {}, current.zone + ' · Lv.' + current.level), node('span', { class: 'account-statuses' }, [node('span', { class: 'tag good' }, '当前使用'), node('span', { class: 'tag ' + (current.connected ? 'good' : 'alert') }, current.connected ? '在线' : '未连接'), current.running ? node('span', { class: 'tag blue' }, '挂机运行中') : null])])]));
    root.append(node('div', { class: 'section-head' }, [node('h2', {}, '账号列表'), node('button', { type: 'button', onclick: () => toast('添加账号请在电脑端完成扫码') }, '+ 添加账号')]));
    root.append(node('div', { class: 'account-list' }, state.accounts.map((item, index) => node('article', { class: 'account-card' + (index === state.activeAccount ? ' active' : ''), role: 'button', tabindex: '0', onclick: () => switchAccount(index), onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchAccount(index); } } }, [node('span', { class: 'avatar' }, item.initials), node('span', { class: 'account-copy' }, [node('strong', {}, item.name), node('span', {}, item.zone + ' · Lv.' + item.level), node('span', { class: 'account-statuses' }, [node('span', { class: 'tag ' + (item.connected ? 'good' : 'alert') }, item.connected ? '在线' : '未连接'), item.running ? node('span', { class: 'tag blue' }, '挂机中') : node('span', { class: 'tag wait' }, '已暂停')])]), index === state.activeAccount ? node('span', { class: 'account-check' }, '✓') : node('span', { class: 'muted' }, '切换')] ))));
    root.append(node('section', { class: 'preference-group', style: 'margin-top:22px' }, [node('h3', {}, '账号安全'), node('div', { class: 'setting-row' }, [node('span', { class: 'setting-copy' }, [node('strong', {}, '登录凭证'), node('small', {}, '敏感凭证仍保存在电脑端，本页面只控制已登录账号')]), node('span', { class: 'tag good' }, '已保护')])]));
  }

  /** 渲染底部五个主导航，并为聊天未读消息显示红点。 */
  function renderNav() {
    const nav = document.getElementById('bottom-nav');
    const tabs = [['home', '首页', 'home'], ['chat', '聊天', 'chat'], ['idle', '挂机', 'idle'], ['settings', '设置', 'settings'], ['account', '账号', 'user']];
    const activeTab = state.detail ? 'home' : state.tab;
    nav.replaceChildren(node('div', { class: 'bottom-nav-inner' }, tabs.map((tab) => node('button', { class: 'nav-item' + (activeTab === tab[0] ? ' active' : ''), type: 'button', onclick: () => selectTab(tab[0]) }, [node('span', { html: icons[tab[2]] }), node('span', {}, tab[1]), tab[0] === 'chat' && state.unreadChat ? node('span', { class: 'nav-badge', 'aria-label': '有未读消息' }) : null]))));
  }

  /** 在主页面和二级页面之间切换，并把当前画面滚回顶部。 */
  function selectTab(tab) {
    state.tab = tab;
    state.detail = null;
    ['home', 'chat', 'idle', 'settings', 'account', 'detail'].forEach((name) => document.getElementById('screen-' + name).classList.toggle('hidden', name !== tab));
    if (tab === 'home') renderHome();
    if (tab === 'chat') { state.unreadChat = false; renderChat(); }
    if (tab === 'idle') renderIdle();
    if (tab === 'settings') renderSettings();
    if (tab === 'account') renderAccounts();
    renderNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** 打开状态卡的二级页面，详情和相关挂机设置保持在一条滚动路径内。 */
  function openDetail(id) {
    state.detail = id;
    state.tab = 'detail';
    ['home', 'chat', 'idle', 'settings', 'account', 'detail'].forEach((name) => document.getElementById('screen-' + name).classList.toggle('hidden', name !== 'detail'));
    renderDetail();
    renderNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** 保存二级页面设置，原型阶段只保留本地会话内的已保存反馈。 */
  function saveDetail() {
    state.savedSettings = true;
    renderDetail();
    toast('设置已保存，下一轮挂机生效');
  }

  /** 切换挂机运行状态，原型用真实的颜色、齿轮动画和状态文案验证交互。 */
  function toggleRun() {
    state.running = !state.running;
    renderIdle();
    renderHome();
    renderNav();
    toast(state.running ? '挂机已继续运行' : '挂机已暂停');
  }

  /** 切换当前账号并刷新所有需要显示角色身份的页面。 */
  function switchAccount(index) {
    state.activeAccount = index;
    renderAccounts();
    toast('已切换到 ' + account().name);
    state.lastSync = new Date();
    renderNav();
  }

  /** 模拟一次状态同步，验证顶部更新时间和各页面自动刷新反馈。 */
  function refreshData() {
    state.lastSync = new Date();
    if (state.tab === 'home') renderHome();
    if (state.tab === 'chat') renderChat();
    if (state.tab === 'idle') renderIdle();
    if (state.tab === 'settings') renderSettings();
    if (state.tab === 'account') renderAccounts();
    if (state.tab === 'detail') renderDetail();
    toast('状态已刷新');
  }

  /** 初始化原型并使用定时器模拟自动刷新，页面销毁前无需额外清理。 */
  function init() {
    renderHome();
    renderNav();
    window.setInterval(() => {
      state.lastSync = new Date();
      if (state.tab === 'home') renderHome();
      if (state.tab === 'detail') renderDetail();
      if (state.tab === 'idle') renderIdle();
    }, 5000);
  }

  init();
})();
</script>
</body>
</html>`;

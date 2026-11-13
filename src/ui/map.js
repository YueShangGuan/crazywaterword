// 世界地图：按真实地图坐标把世界排成城池网格，普通城一格，大城（如山景城）占多格。
// 该脚本被内联进控制台页面，与 page.mjs 的 $ / el / clear / call / current / snapshot 共享作用域。
// 顶层只声明状态和函数，不访问 DOM；首次进入标签页时才绑定事件与请求数据。

const mapTabResColors = { 1: '#4f9f6a', 2: '#3f8fbf', 3: '#bf8f3f' };
const mapTabNeutralColor = '#5c6b70';
const mapTabEmptyColor = '#112b36';
const mapTabOwnColor = '#ffd166';
const mapTabBattleColor = '#e2685f';
// 城战标记：我方宣战的进攻目标用橙色虚框，受袭城（守方是我方）加一圈防守蓝框。
const mapTabAttackColor = '#ffbd77';
const mapTabDefendColor = '#5aa9e6';
const mapTabObjectColors = { boss: '#e2685f', limitedBoss: '#e08a3f', treasure: '#d9b45f', chipMine: '#63c6c9', wreck: '#9aa9ae', merchantShip: '#00ff00' };
const mapTabObjectLabels = { boss: '世界 Boss', treasure: '宝藏', merchantShip: '搁浅货轮', limitedBoss: '限时 Boss', chipMine: '硅矿', wreck: '沉船' };

let mapTabLayout = null;
let mapTabLive = null;
let mapTabReceivedAt = 0;
let mapTabCityByCell = new Map();
let mapTabFieldsByCity = new Map();
let mapTabObjectsByCity = new Map();
let mapTabObjectByGrid = new Map();
let mapTabMerchantByGrid = new Map();
let mapTabVersion = 0;
let mapTabAccount = null;
let mapTabLoading = false;
let mapTabLastFreshAt = 0;
let mapTabTimer = null;
let mapTabRefreshTimer = null;
let mapTabFrame = null;
let mapTabDash = 0;
let mapTabStatic = { key: '', canvas: null };
let mapTabWarChoices = new Map();
let mapTabView = { scale: 1, tx: 0, ty: 0, width: 0, height: 0, userAdjusted: false };
let mapTabDrag = null;
let mapTabDragMoved = false;
let mapTabHover = null;
let mapTabSelected = null;
let mapTabLayers = {
  faction: true, fields: false,
  myFleets: true, allyFleets: true, enemyFleets: false,
  trade: true, allyTrade: true,
  objects: true, grid: true,
};

function mapTabVisible() {
  const section = $('tab-map');
  return Boolean(section) && !section.classList.contains('hidden');
}

function mapTabLayerOn(name) {
  return mapTabLayers[name] !== false;
}

function mapTabDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!value) return '已到达';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes) return minutes + ' 分';
  return value + ' 秒';
}

// 倒计时用紧凑时钟格式（mm:ss / h:mm:ss），与粗粒度的 mapTabDuration 区分。
function mapTabClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return (hours ? hours + ':' + pad(minutes) : String(minutes)) + ':' + pad(value % 60);
}

function mapTabGuildColor(guildIdx) {
  const entry = (mapTabLive?.legend ?? []).find((row) => Number(row.guildIdx) === Number(guildIdx));
  return entry?.color ?? (Number(guildIdx) > 0 ? '#8aa0a8' : mapTabNeutralColor);
}

function mapTabCityName(cityId) {
  const city = mapTabLayout?.cities?.find((row) => row.id === Number(cityId));
  return city?.name ?? ('城 #' + cityId);
}

// 连续格坐标转成游戏里的「行字母 + 列号」位置名（如 E3）；行号超出字母表时退回数字。
function mapTabCellName(cell) {
  if (!cell) return '';
  const letters = 'ABCDEFGHIJ';
  const row = Math.floor(cell.y);
  const col = Math.floor(cell.x);
  return (letters[row] ?? String(row)) + col;
}

function mapTabCityAtCell(point) {
  if (!point) return null;
  return mapTabCityByCell.get(Math.floor(point.x) + ',' + Math.floor(point.y)) ?? null;
}

function mapTabServerNow() {
  const base = Number(mapTabLive?.serverNow) || Date.now() / 1000;
  return base + (Date.now() - mapTabReceivedAt) / 1000;
}

function mapTabHead(track) {
  if (!track) return null;
  const start = Number(track.start);
  const end = Number(track.end);
  if (!(end > start) || !track.from || !track.to) return track.head ?? track.from ?? null;
  const progress = Math.min(1, Math.max(0, (mapTabServerNow() - start) / (end - start)));
  return {
    x: track.from.x + (track.to.x - track.from.x) * progress,
    y: track.from.y + (track.to.y - track.from.y) * progress,
  };
}

// 格坐标（城市格中心为 col + 0.5 / row + 0.5）到画布像素。
function mapTabScreen(point) {
  return { x: point.x * mapTabView.scale + mapTabView.tx, y: point.y * mapTabView.scale + mapTabView.ty };
}

function mapTabSetEmpty(text) {
  const node = $('map-empty');
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
}

function mapTabSetStatus(text) {
  const node = $('map-status');
  if (node) node.textContent = text || '';
}

function applyWorldMapLayout(layout) {
  mapTabLayout = layout;
  mapTabCityByCell = new Map();
  for (const city of layout?.cities ?? []) {
    if (!Number.isSafeInteger(city.col) || !Number.isSafeInteger(city.row)) continue;
    const colSpan = Math.max(1, city.colSpan || 1);
    const rowSpan = Math.max(1, city.rowSpan || 1);
    // 大城占多格：命中与悬浮时每一格都要指回同一座城。
    for (let dy = 0; dy < rowSpan; dy += 1) {
      for (let dx = 0; dx < colSpan; dx += 1) {
        mapTabCityByCell.set((city.col + dx) + ',' + (city.row + dy), city);
      }
    }
  }
  mapTabFieldsByCity = new Map();
  for (const field of layout?.fields ?? []) {
    if (!mapTabFieldsByCity.has(field.cityId)) mapTabFieldsByCity.set(field.cityId, []);
    mapTabFieldsByCity.get(field.cityId).push(field);
  }
  mapTabObjectsByCity = new Map();
  mapTabObjectByGrid = new Map();
  for (const [kind, list] of Object.entries(layout?.objects ?? {})) {
    const points = Array.isArray(list) ? list : (list ? [list] : []);
    for (const point of points) {
      // 城池详情的"世界对象"不列静态宝藏位，避免每个城都挂一条"宝藏"；
      // 舰队目标格反查仍登记宝藏，舰队列表里"目标：宝藏"的命名要靠它。
      if (kind !== 'treasure' && point?.cityId > 0) {
        if (!mapTabObjectsByCity.has(point.cityId)) mapTabObjectsByCity.set(point.cityId, []);
        mapTabObjectsByCity.get(point.cityId).push({ kind, point });
      }
      // 舰队目标格反查对象名（宝藏/货轮/Boss…），目标不是城时详情与舰队列表用它。
      if (Number.isSafeInteger(point?.gridIdx)) mapTabObjectByGrid.set(point.gridIdx, { kind, point });
    }
  }
  mapTabStatic = { key: '', canvas: null };
  mapTabView = { scale: 1, tx: 0, ty: 0, width: 0, height: 0, userAdjusted: false };
  mapTabHover = null;
  mapTabSelected = null;
}

function mapTabApplyState(state) {
  mapTabLive = state;
  mapTabReceivedAt = Date.now();
  // 当前万吨货轮的格子优先于静态宝藏位命名（舰队目标反查用）。
  mapTabMerchantByGrid = new Map();
  const ship = state?.merchantShip;
  if (ship && Number.isSafeInteger(ship.gridIdx)) {
    mapTabMerchantByGrid.set(ship.gridIdx, { kind: 'merchantShip', point: ship });
  }
  // bossData 候选位只保留今日 WorldBossInfo.gridIdx 命中的那一只：
  // 城池详情的"世界对象"和舰队目标反查都不再提其他候选位。
  const bossGrid = Number(state?.worldBoss?.gridIdx) || 0;
  for (const [cityId, list] of mapTabObjectsByCity) {
    const kept = list.filter((entry) => entry.kind !== 'boss' || Number(entry.point?.gridIdx) === bossGrid);
    if (kept.length !== list.length) mapTabObjectsByCity.set(cityId, kept);
  }
  for (const [grid, entry] of mapTabObjectByGrid) {
    if (entry.kind === 'boss' && Number(grid) !== bossGrid) mapTabObjectByGrid.delete(grid);
  }
  renderWorldMapLegend();
  renderWorldMapStatus();
  renderWorldMapFleets();
  renderWorldMapWar();
  renderWorldMapWarSettings();
}

function mapTabObjectAtGrid(gridIdx) {
  const grid = Number(gridIdx);
  if (!grid) return null;
  return mapTabMerchantByGrid.get(grid) ?? mapTabObjectByGrid.get(grid) ?? null;
}

function mapTabFleetTargetText(fleet) {
  if (fleet.state === 4 && Number(fleet.repairEndTs) > 0) {
    const remain = fleet.repairEndTs - mapTabServerNow();
    return remain > 0 ? '维修中 · 剩 ' + mapTabClock(remain) : '维修收尾';
  }
  if (fleet.track?.moving) {
    const object = mapTabObjectAtGrid(fleet.targetGridIdx);
    const target = fleet.targetCityId ? mapTabCityName(fleet.targetCityId)
      : (object ? (mapTabObjectLabels[object.kind] ?? object.kind) : mapTabCityAtCell(fleet.track.to)?.name);
    return '前往 ' + (target || '目标') + ' · ' + mapTabDuration(fleet.track.eta);
  }
  return fleet.cityId ? '在 ' + mapTabCityName(fleet.cityId) : '待命';
}

function renderWorldMapFleets() {
  const box = $('map-fleets');
  const count = $('map-fleet-count');
  if (!box) return;
  clear(box);
  const fleets = mapTabLive?.fleets ?? [];
  if (count) count.textContent = fleets.length ? `${fleets.length} 支 · ${fleets.filter((fleet) => fleet.state === 2).length} 在航` : '';
  if (!fleets.length) {
    box.appendChild(el('span', 'dim', '暂无舰队数据'));
    return;
  }
  for (const fleet of fleets) {
    const row = el('div', 'world-map-fleet-row');
    const dot = el('span', 'world-map-fleet-dot');
    dot.dataset.state = String(fleet.state);
    const body = el('div');
    body.appendChild(el('div', 'world-map-fleet-name', fleet.buildingId + ' · ' + fleet.stateText));
    body.appendChild(el('div', 'world-map-fleet-meta', '耐久 ' + fmt(fleet.durability) + ' / ' + fmt(fleet.maxDura)));
    body.appendChild(el('div', 'world-map-fleet-meta', mapTabFleetTargetText(fleet)));
    row.appendChild(dot);
    row.appendChild(body);
    box.appendChild(row);
  }
}

function mapTabWarTargetOptions(role) {
  const war = mapTabLive?.war;
  if (!war) return [];
  return role === 'defend' ? (war.defendTargets ?? []) : (war.attackTargets ?? []);
}

function mapTabWarTargetLabel(target) {
  const tags = [];
  if (target.assemble) tags.push('集结');
  if (target.underAttack) tags.push('受袭');
  if (target.recommended) tags.push('推荐');
  return target.name + (tags.length ? '（' + tags.join('、') + '）' : '');
}

function renderWorldMapWar() {
  const status = $('map-war-status');
  const box = $('map-war-targets');
  if (!box) return;
  clear(box);
  const war = mapTabLive?.war;
  const worldFleets = mapTabLive?.worldFleets ?? [];
  const allyCount = worldFleets.filter((fleet) => fleet.kind === 'ally').length;
  const enemyCount = worldFleets.filter((fleet) => fleet.kind === 'enemy').length;
  if (status) {
    if (!war || !war.ownGuildIdx) status.textContent = mapTabLive ? '未加入联盟或暂无城战数据' : '';
    else if (war.active) {
      const start = new Date(war.startTime * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const end = new Date(war.endTime * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      status.textContent = '进行中 ' + start + '–' + end +
        ' · 可进攻 ' + (war.attackTargets?.length ?? 0) + ' · 可防守 ' + (war.defendTargets?.length ?? 0) +
        (war.assembleCityId ? ' · 集结城 ' + mapTabCityName(war.assembleCityId) : '');
    } else {
      status.textContent = `未开始/已结束 · 可进攻 ${war.attackTargets?.length ?? 0} · 可防守 ${war.defendTargets?.length ?? 0}`;
    }
    if (allyCount || enemyCount) status.textContent += ` · 盟友舰队 ${allyCount} / 敌方 ${enemyCount}`;
  }

  // 受袭城市单独列出（宣战守方是我方的城），哪怕舰队数据未就绪也要可见。
  const attacked = (war?.defendTargets ?? []).filter((target) => target.underAttack);
  if (attacked.length) {
    box.appendChild(el('div', 'dim', '受袭：' + attacked.map((target) => mapTabWarTargetLabel(target)).join('、')));
  }

  const fleets = mapTabLive?.fleets ?? [];
  if (!fleets.length) {
    box.appendChild(el('span', 'dim', '连接后可按舰队设置城战目标'));
    return;
  }
  for (const fleet of fleets) {
    const key = String(fleet.buildingId);
    const choice = mapTabWarChoices.get(key) ?? { role: 'auto', cityId: 0 };
    const targets = mapTabWarTargetOptions(choice.role);
    if (choice.cityId && !targets.some((target) => target.cityId === choice.cityId)) {
      choice.cityId = 0;
      mapTabWarChoices.set(key, choice);
    }
    const row = el('div', 'world-map-war-target');
    row.appendChild(el('div', 'world-map-fleet-name', key + ' · ' + fleet.stateText));
    const line = el('div', 'world-map-war-row');

    const role = document.createElement('select');
    for (const [value, label] of [['auto', '自动化'], ['attack', '进攻'], ['defend', '防守']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      role.appendChild(option);
    }
    role.value = choice.role;
    role.setAttribute('aria-label', key + ' 城战行动');
    role.onchange = () => {
      mapTabWarChoices.set(key, { role: role.value, cityId: 0 });
      renderWorldMapWar();
    };

    const target = document.createElement('select');
    target.setAttribute('aria-label', key + ' 目标城市');
    const autoOption = document.createElement('option');
    autoOption.value = '0';
    autoOption.textContent = choice.role === 'auto' ? '自动化（不指定城市）' : '请选择目标城市';
    target.appendChild(autoOption);
    for (const item of targets) {
      const option = document.createElement('option');
      option.value = String(item.cityId);
      option.textContent = mapTabWarTargetLabel(item);
      target.appendChild(option);
    }
    target.value = String(choice.cityId || 0);
    target.disabled = choice.role === 'auto' || !targets.length;
    target.onchange = () => {
      const cityId = Number(target.value) || 0;
      mapTabWarChoices.set(key, { role: choice.role, cityId });
      const button = line.querySelector('button');
      if (button) button.disabled = !cityId || cityId === 0;
    };

    const button = el('button', 'world-map-open', '派遣');
    button.type = 'button';
    button.disabled = choice.role === 'auto' || !choice.cityId || fleet.state !== 1;
    button.onclick = () => dispatchWorldMapWarFleet(key);

    line.appendChild(role);
    line.appendChild(target);
    line.appendChild(button);
    row.appendChild(line);
    box.appendChild(row);
  }
}

function renderWorldMapWarSettings() {
  const settings = mapTabLive?.cityWarSettings;
  if (!settings) return;
  for (const [id, value] of [['map-war-enabled', settings.enabled], ['map-war-online', settings.online], ['map-war-reattack', settings.reattack]]) {
    const input = $(id);
    if (input && document.activeElement !== input) input.checked = value === true;
  }
}

function dispatchWorldMapWarFleet(buildingId) {
  const choice = mapTabWarChoices.get(String(buildingId));
  if (!choice || choice.role === 'auto' || !choice.cityId) return;
  const target = mapTabWarTargetOptions(choice.role).find((item) => item.cityId === choice.cityId);
  if (!target) return;
  const action = choice.role === 'defend' ? '驻防' : '进攻';
  openConfirm('城战派遣', [
    el('div', null, buildingId + ' ' + action + ' ' + target.name),
    el('div', 'dim', '手动派遣只执行本次；自动化仍按自己的规则运行。'),
  ], async () => {
    const result = await call('/api/map/city-war/dispatch', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, buildingId, cityId: choice.cityId, role: choice.role }),
    });
    const hint = $('map-war-hint');
    if (hint) hint.textContent = result.message || (result.confirmed ? '派遣已确认' : '派遣结果未确认');
    await refreshWorldMapState(true);
  });
}

async function saveWorldMapWarSettings() {
  const hint = $('map-war-hint');
  try {
    const result = await call('/api/map/city-war/settings', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('map-war-enabled')?.checked === true,
        online: $('map-war-online')?.checked === true,
        reattack: $('map-war-reattack')?.checked === true,
      }),
    });
    if (mapTabLive) mapTabLive.cityWarSettings = result.cityWar;
    if (hint) hint.textContent = '城战自动化开关已保存';
  } catch (error) {
    if (hint) hint.textContent = '保存失败：' + error.message;
  }
}

function mapTabStatusLine() {
  const state = mapTabLive;
  if (!state) return '';
  const parts = [];
  parts.push(state.connected ? (state.stale ? '缓存' : '已同步') : (state.paused ? '已暂停' : '未连接'));
  const stamp = state.updatedAt ? new Date(state.updatedAt) : null;
  parts.push('更新 ' + (stamp ? stamp.toLocaleTimeString('zh-CN', { hour12: false }) : '—'));
  if (state.summary) {
    parts.push('城 我方 ' + state.summary.ownCities + ' / 其他 ' + state.summary.enemyCities + ' / 中立 ' + state.summary.neutralCities);
    parts.push('舰队 ' + state.summary.fleetsMoving + '/' + (state.fleets?.length ?? 0) + ' 在航');
  }
  const cargo = state.trade?.cargo;
  if (state.trade?.open && cargo?.cityId) {
    parts.push('商船 ' + mapTabCityName(cargo.cityId) + ' → ' + mapTabCityName(cargo.moveToCityId));
  }
  if (state.warnings?.length) parts.push(state.warnings[0]);
  return parts.join(' · ');
}

function renderWorldMapStatus() {
  mapTabSetStatus(mapTabStatusLine());
}

function renderWorldMapLegend() {
  const box = $('map-legend');
  if (!box) return;
  clear(box);
  const legend = mapTabLive?.legend ?? [];
  if (!legend.length) {
    box.appendChild(el('span', 'dim', '连接后读取势力归属'));
    return;
  }
  for (const entry of legend) {
    const row = el('div', 'world-map-legend-row');
    const swatch = el('span', 'world-map-swatch');
    swatch.style.background = entry.color;
    // 势力名来自 WorldInitialForceCfg（编号→名称），编号超出势力表时只显示联盟编号。
    const name = entry.neutral
      ? '中立 / 野怪'
      : (entry.own ? '我方 · 联盟 #' + entry.guildIdx : '联盟 #' + entry.guildIdx)
        + (entry.factionName ? ' · ' + entry.factionName : '');
    row.appendChild(swatch);
    row.appendChild(el('span', 'world-map-legend-name', name));
    row.appendChild(el('span', 'dim', entry.cities + ' 城'));
    box.appendChild(row);
  }
  // 城战标记图例：只在有宣战数据时展示，避免和平时期误导。
  const war = mapTabLive?.war;
  if (war && ((war.attackTargets?.length ?? 0) || (war.defendTargets ?? []).some((target) => target.underAttack))) {
    const marks = [['world-map-swatch-ring', mapTabAttackColor, 'dashed', '我方进攻目标'], ['world-map-swatch-ring', mapTabDefendColor, 'solid', '受袭（需防守）']];
    for (const [cls, color, style, label] of marks) {
      const row = el('div', 'world-map-legend-row');
      const swatch = el('span', cls);
      swatch.style.borderColor = color;
      swatch.style.borderStyle = style === 'dashed' ? 'dashed' : 'solid';
      row.appendChild(swatch);
      row.appendChild(el('span', 'world-map-legend-name', label));
      box.appendChild(row);
    }
  }
}

function mapTabObjectText(cityId) {
  const objects = mapTabObjectsByCity.get(cityId) ?? [];
  return objects.map((entry) => mapTabObjectLabels[entry.kind] || entry.kind).join('、');
}

function renderWorldMapDetail(hit) {
  const box = $('map-detail');
  if (!box) return;
  clear(box);
  box.classList.remove('dim');
  if (!hit) {
    box.classList.add('dim');
    box.textContent = '点击城池、舰队或商船查看详情';
    return;
  }
  const lines = [];
  if (hit.kind === 'city') {
    const city = hit.city;
    const owner = mapTabLive?.cities?.find((row) => row.id === city.id);
    lines.push(city.name + ' · ' + city.level + ' 级' + (city.typeName ? ' · ' + city.typeName : ''));
    lines.push('势力：' + (Number(owner?.guildIdx) > 0 ? '联盟 #' + owner.guildIdx : '中立 / 野怪') + (owner?.own ? '（我方）' : ''));
    lines.push('资源田 ' + city.fieldCount + ' 块' + (owner?.battle ? ' · 交战中' : ''));
    if (owner?.defenceFleetNum) lines.push('守军 ' + owner.defenceFleetNum + ' 队');
    // SCity 战斗帧的交战槽位：左=攻方，右=守方（NPC 无名）。
    const fights = (owner?.battlePoints ?? []).filter((slot) => slot?.leftFighter || slot?.rightFighter);
    if (fights.length) {
      const text = fights.slice(0, 3).map((slot) => {
        const left = slot.leftFighter?.name || (slot.leftFighter ? '攻方' : '?');
        const right = slot.rightFighter?.name || (slot.rightFighter ? '守军' : '?');
        return left + ' → ' + right;
      }).join('、');
      lines.push('交战 ' + fights.length + ' 处：' + text + (fights.length > 3 ? ' 等' : ''));
    }
    const objects = mapTabObjectText(city.id);
    if (objects) lines.push('世界对象：' + objects);
  } else if (hit.kind === 'fleet') {
    const fleet = hit.fleet;
    if (fleet.kind) {
      lines.push((fleet.kind === 'ally' ? '盟友舰队' : '敌方舰队') + ' · ' + (fleet.owner?.nickname || fleet.buildingId));
      lines.push(fleet.stateText + ' · 耐久 ' + fmt(fleet.durability) + ' / ' + fmt(fleet.maxDura));
    } else {
      lines.push(fleet.buildingId + ' · ' + fleet.stateText);
      lines.push('耐久 ' + fmt(fleet.durability) + ' / ' + fmt(fleet.maxDura) + ' · 战力 ' + fmt(fleet.power));
    }
    const object = mapTabObjectAtGrid(fleet.targetGridIdx);
    const target = fleet.targetCityId ? mapTabCityName(fleet.targetCityId)
      : (object ? (mapTabObjectLabels[object.kind] ?? object.kind) : mapTabCityAtCell(fleet.track?.to)?.name);
    lines.push('目标：' + (target || '原地'));
    lines.push(fleet.track?.moving ? 'ETA ' + mapTabDuration(fleet.track.eta) : '已到达');
  } else if (hit.kind === 'object') {
    const label = mapTabObjectLabels[hit.object.kind] ?? hit.object.kind;
    lines.push(label);
    lines.push('位置 ' + mapTabCellName(hit.object.point.cell) + ' 格附近');
    if (hit.object.kind === 'merchantShip') {
      const owner = Number(hit.object.point.ownerGuildIdx) > 0
        ? '联盟 #' + hit.object.point.ownerGuildIdx
        : '无主';
      lines.push('占领方：' + owner + ' · 进度 ' + hit.object.point.progress + '%');
    }
  } else if (hit.kind === 'cargo') {
    const cargo = hit.cargo;
    lines.push(hit.own ? '我方商船 · 等级 ' + (cargo.cargoLv ?? '-') : (cargo.nickname || '其他玩家') + ' 的商船');
    lines.push('航线：' + mapTabCityName(cargo.cityId) + ' → ' + mapTabCityName(cargo.moveToCityId));
    lines.push(hit.track?.moving ? 'ETA ' + mapTabDuration(hit.track.eta) : '已停靠');
  }
  for (const line of lines) box.appendChild(el('div', null, line));
  if (hit.kind === 'city') appendWorldMapDefence(hit.city.id);
}

// 点击城池后异步拉取守军列表（CityDefenceRequest），追加在详情面板底部；过期响应按序号丢弃。
let mapTabDefenceSeq = 0;
async function appendWorldMapDefence(cityId) {
  const box = $('map-detail');
  if (!box) return;
  const seq = ++mapTabDefenceSeq;
  const holder = el('div', 'world-map-defence dim', '守军信息读取中…');
  box.appendChild(holder);
  try {
    const data = await call('/api/map/city-defence?cityId=' + encodeURIComponent(cityId));
    if (seq !== mapTabDefenceSeq) return;
    holder.classList.remove('dim');
    clear(holder);
    const fleets = data?.fleets ?? [];
    holder.appendChild(el('div', 'world-map-fleet-name', '驻防舰队 ' + fleets.length + ' 支'));
    if (!fleets.length) {
      holder.appendChild(el('div', null, '当前无驻防舰队'));
      return;
    }
    for (const fleet of fleets) {
      const label = fleet.isNpc ? '守军' : (fleet.name || '守军舰队');
      const faction = Number(fleet.guildIdx) > 0 ? ' · 联盟 #' + fleet.guildIdx : '';
      const power = fleet.power ? ' · 战力 ' + fmt(fleet.power) : '';
      const multiple = fleet.multiple ? ' · 兵力 ×' + fmt(fleet.multiple) : '';
      holder.appendChild(el('div', null, label + faction + power + multiple));
    }
  } catch (error) {
    if (seq !== mapTabDefenceSeq) return;
    holder.classList.remove('dim');
    holder.textContent = '守军信息读取失败：' + error.message;
  }
}

function mapTabTooltipText(hit) {
  if (!hit) return '';
  if (hit.kind === 'city') {
    const owner = mapTabLive?.cities?.find((row) => row.id === hit.city.id);
    const faction = Number(owner?.guildIdx) > 0 ? '联盟 #' + owner.guildIdx : '中立';
    return hit.city.name + ' · ' + hit.city.level + ' 级\n势力 ' + faction + (owner?.own ? '（我方）' : '');
  }
  if (hit.kind === 'fleet') {
    const label = hit.fleet.kind
      ? (hit.fleet.kind === 'ally' ? '盟友 ' : '敌方 ') + (hit.fleet.owner?.nickname || hit.fleet.buildingId)
      : hit.fleet.buildingId;
    return label + ' · ' + hit.fleet.stateText + '\n' +
      (hit.fleet.track?.moving ? 'ETA ' + mapTabDuration(hit.fleet.track.eta) : '已到达');
  }
  if (hit.kind === 'object') {
    const label = mapTabObjectLabels[hit.object.kind] ?? hit.object.kind;
    return label + '\n位置 ' + mapTabCellName(hit.object.point.cell) + ' 格附近';
  }
  if (hit.kind === 'cargo') {
    return (hit.own ? '我方商船' : (hit.cargo.nickname || '其他玩家')) + '\n' +
      (hit.track?.moving ? 'ETA ' + mapTabDuration(hit.track.eta) : '已停靠');
  }
  return '';
}

function positionWorldMapTooltip(px, py) {
  const tip = $('map-tooltip');
  if (!tip) return;
  const text = mapTabTooltipText(mapTabHover);
  tip.hidden = !text;
  tip.textContent = text;
  if (!text) return;
  const stage = $('map-stage');
  const width = stage?.clientWidth ?? 0;
  const height = stage?.clientHeight ?? 0;
  const left = Math.min(Math.max(8, px + 14), Math.max(8, width - 190));
  const top = Math.min(Math.max(8, py + 14), Math.max(8, height - 70));
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function fitWorldMap() {
  const canvas = $('map-canvas');
  if (!canvas || !mapTabLayout) return;
  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;
  if (!width || !height) return;
  const columns = mapTabLayout.columns || 1;
  const rows = mapTabLayout.rows || 1;
  const scale = Math.max(8, Math.min(width / columns, height / rows) * 0.94);
  mapTabView = {
    scale,
    tx: (width - columns * scale) / 2,
    ty: (height - rows * scale) / 2,
    width,
    height,
    userAdjusted: false,
  };
}

function focusWorldMapFleets() {
  const canvas = $('map-canvas');
  const heads = (mapTabLive?.fleets ?? []).map((fleet) => mapTabHead(fleet.track)).filter(Boolean);
  const cargo = mapTabLive?.trade?.cargo;
  if (cargo?.track) heads.push(mapTabHead(cargo.track));
  if (!canvas || !heads.length) {
    mapTabSetStatus('当前没有可定位的舰队或商船');
    return;
  }
  const xs = heads.map((point) => point.x);
  const ys = heads.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;
  if (!width || !height) return;
  const spanX = Math.max(3, maxX - minX + 3);
  const spanY = Math.max(3, maxY - minY + 3);
  const scale = Math.max(18, Math.min(width / spanX, height / spanY, 110));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  mapTabView = {
    scale,
    tx: width / 2 - centerX * scale,
    ty: height / 2 - centerY * scale,
    width,
    height,
    userAdjusted: true,
  };
}

function mapTabStaticKey(width, height) {
  const state = mapTabLive;
  return [
    mapTabLayout?.scenarioId, mapTabLayout?.columns, mapTabLayout?.rows, width, height,
    Math.round(mapTabView.scale * 100), Math.round(mapTabView.tx), Math.round(mapTabView.ty),
    state?.updatedAt ?? '', state?.ownCityIds?.length ?? 0,
    mapTabLayerOn('fields') ? 1 : 0, mapTabLayerOn('faction') ? 1 : 0,
    mapTabLayerOn('grid') ? 1 : 0, mapTabLayerOn('objects') ? 1 : 0,
  ].join('|');
}

function drawWorldMapStatic(width, height, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0c2631';
  ctx.fillRect(0, 0, width, height);

  const layout = mapTabLayout;
  const scale = mapTabView.scale;
  const columns = layout.columns || 1;
  const rows = layout.rows || 1;
  const ownership = new Map((mapTabLive?.cities ?? []).map((row) => [row.id, row]));
  const gap = Math.max(1, Math.min(5, scale * 0.07));

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const x = col * scale + mapTabView.tx;
      const y = row * scale + mapTabView.ty;
      ctx.fillStyle = mapTabEmptyColor;
      ctx.fillRect(x + gap / 2, y + gap / 2, scale - gap, scale - gap);
      if (mapTabLayerOn('grid')) {
        ctx.strokeStyle = 'rgba(120, 170, 185, 0.12)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(scale), Math.round(scale));
      }
    }
  }

  for (const city of layout.cities) {
    if (!Number.isSafeInteger(city.col) || !Number.isSafeInteger(city.row)) continue;
    const owner = ownership.get(city.id);
    const owned = Number(owner?.guildIdx) > 0;
    const colSpan = Math.max(1, city.colSpan || 1);
    const rowSpan = Math.max(1, city.rowSpan || 1);
    const x = city.col * scale + mapTabView.tx;
    const y = city.row * scale + mapTabView.ty;
    const blockWidth = scale * colSpan;
    const blockHeight = scale * rowSpan;
    const size = blockWidth - gap * 2;
    const sizeY = blockHeight - gap * 2;
    const color = mapTabLayerOn('faction') && owned
      ? mapTabGuildColor(owner.guildIdx)
      : (mapTabLayerOn('faction') ? mapTabNeutralColor : '#7f9aa1');
    ctx.fillStyle = color;
    ctx.fillRect(x + gap, y + gap, size, sizeY);
    if (owner?.battle) {
      ctx.strokeStyle = mapTabBattleColor;
      ctx.lineWidth = Math.max(2, scale * 0.045);
      ctx.strokeRect(x + gap + 1, y + gap + 1, size - 2, sizeY - 2);
    }
    if (owner?.own) {
      ctx.strokeStyle = mapTabOwnColor;
      ctx.lineWidth = Math.max(2, scale * 0.05);
      ctx.strokeRect(x + gap, y + gap, size, sizeY);
    }
    if (owner?.underAttack) {
      // 受袭城（宣战守方是我方）：外围一圈防守蓝框。
      ctx.strokeStyle = mapTabDefendColor;
      ctx.lineWidth = Math.max(2, scale * 0.05);
      ctx.strokeRect(x + gap - 3, y + gap - 3, size + 6, sizeY + 6);
    }
    if (owner?.attackTarget) {
      // 我方宣战的进攻目标：外围橙色虚框，与其他盟之间的交战红框区分。
      ctx.strokeStyle = mapTabAttackColor;
      ctx.lineWidth = Math.max(2, scale * 0.05);
      ctx.setLineDash([Math.max(4, scale * 0.16), Math.max(3, scale * 0.1)]);
      ctx.strokeRect(x + gap - 3, y + gap - 3, size + 6, sizeY + 6);
      ctx.setLineDash([]);
    }

    if (scale >= 34) {
      const labelGap = scale >= 48 ? Math.max(12, scale * 0.22) : 0;
      const nameY = y + blockHeight / 2 - labelGap / 2;
      ctx.fillStyle = '#f1f7f6';
      ctx.font = Math.max(10, Math.min(14, scale * 0.21)) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(city.name, x + blockWidth / 2, nameY);
      if (labelGap) {
        ctx.fillStyle = 'rgba(235, 246, 245, 0.72)';
        ctx.font = Math.max(9, Math.min(11, scale * 0.15)) + 'px system-ui, sans-serif';
        ctx.fillText(city.level + ' 级', x + blockWidth / 2, nameY + labelGap);
      }
    }

    if (mapTabLayerOn('fields')) {
      const fields = mapTabFieldsByCity.get(city.id) ?? [];
      const pip = Math.max(2, Math.min(5, scale * 0.07));
      const startX = x + gap + 3;
      const startY = y + blockHeight - gap - pip - 3;
      fields.slice(0, 7).forEach((field, index) => {
        ctx.fillStyle = mapTabResColors[field.resType] ?? '#7fa6a0';
        ctx.fillRect(startX + index * (pip + 2), startY, pip, pip);
      });
      if (fields.length > 7 && scale >= 40) {
        ctx.fillStyle = 'rgba(235, 246, 245, 0.7)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('+' + (fields.length - 7), startX + 7 * (pip + 2), startY + pip);
      }
    }
  }

  if (mapTabLayerOn('faction')) {
    // 领地边界：把大城占的多格与相邻同盟城视作连续区域，只在归属变化的格边描线。
    // 每条边向己方内侧收 1.5px，两个同盟相邻时呈平行双线，外缘则是单条领地轮廓。
    const ownerAtCell = new Map();
    for (const city of layout.cities) {
      if (!Number.isSafeInteger(city.col) || !Number.isSafeInteger(city.row)) continue;
      const guildIdx = Number(ownership.get(city.id)?.guildIdx) || 0;
      if (guildIdx <= 0) continue;
      const colSpan = Math.max(1, city.colSpan || 1);
      const rowSpan = Math.max(1, city.rowSpan || 1);
      for (let dy = 0; dy < rowSpan; dy += 1) {
        for (let dx = 0; dx < colSpan; dx += 1) {
          ownerAtCell.set((city.col + dx) + ',' + (city.row + dy), guildIdx);
        }
      }
    }
    const inset = Math.max(1.2, Math.min(2.5, scale * 0.05));
    ctx.lineWidth = Math.max(1.5, Math.min(3, scale * 0.05));
    const edge = (x1, y1, x2, y2, nx, ny) => {
      ctx.beginPath();
      ctx.moveTo(x1 + nx, y1 + ny);
      ctx.lineTo(x2 + nx, y2 + ny);
      ctx.stroke();
    };
    for (const [key, guildIdx] of ownerAtCell) {
      const [col, row] = key.split(',').map(Number);
      ctx.strokeStyle = mapTabGuildColor(guildIdx);
      const x = col * scale + mapTabView.tx;
      const y = row * scale + mapTabView.ty;
      const neighbours = [
        { key: col + ',' + (row - 1), from: [x, y], to: [x + scale, y], normal: [0, inset] },
        { key: col + ',' + (row + 1), from: [x, y + scale], to: [x + scale, y + scale], normal: [0, -inset] },
        { key: (col - 1) + ',' + row, from: [x, y], to: [x, y + scale], normal: [inset, 0] },
        { key: (col + 1) + ',' + row, from: [x + scale, y], to: [x + scale, y + scale], normal: [-inset, 0] },
      ];
      for (const side of neighbours) {
        const other = ownerAtCell.get(side.key);
        if (other === guildIdx) continue;
        edge(side.from[0], side.from[1], side.to[0], side.to[1], side.normal[0], side.normal[1]);
      }
    }
  }

  if (mapTabLayerOn('objects')) {
    // 世界对象画在真实位置（硅矿/沉船），不再挤在最近城池的角标里。
    // 静态宝藏位（treasureData）只是货轮停靠点，全部不显示，只画当前万吨货轮那格；
    // bossData 是四个候选位，今日 Boss 在动态层按 WorldBossInfo.gridIdx 画，这里全跳过。
    const size = Math.max(3.5, Math.min(7, scale * 0.14));
    for (const [kind, list] of Object.entries(layout.objects ?? {})) {
      if (kind === 'treasure' || kind === 'boss') continue;
      const points = Array.isArray(list) ? list : (list ? [list] : []);
      for (const point of points) {
        if (!point?.cell) continue;
        const screen = mapTabScreen(point.cell);
        if (screen.x < -20 || screen.y < -20 || screen.x > width + 20 || screen.y > height + 20) continue;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - size);
        ctx.lineTo(screen.x + size, screen.y);
        ctx.lineTo(screen.x, screen.y + size);
        ctx.lineTo(screen.x - size, screen.y);
        ctx.closePath();
        ctx.fillStyle = mapTabObjectColors[kind] ?? '#9aa9ae';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10, 30, 38, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 宝藏/货轮点位多（二十余个），只给其余对象标名字，宝藏悬浮可见。
        if (scale >= 42 && kind !== 'treasure') {
          ctx.fillStyle = 'rgba(235, 246, 245, 0.85)';
          ctx.font = '9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(mapTabObjectLabels[kind] ?? kind, screen.x, screen.y + size + 2);
        }
      }
    }
  }

  return canvas;
}

function drawWorldMapRoute(ctx, track, color, faded) {
  if (!track?.from || !track?.to || !track.moving) return;
  const scale = mapTabView.scale;
  const from = mapTabScreen(track.from);
  const to = mapTabScreen(track.to);
  const head = mapTabHead(track);
  const now = mapTabScreen(head);
  ctx.beginPath();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = faded;
  ctx.lineWidth = 1;
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.setLineDash([7, 6]);
  ctx.lineDashOffset = -mapTabDash;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, Math.min(3, scale * 0.035));
  ctx.moveTo(now.x, now.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function drawWorldMapMarker(ctx, point, to, color, kind) {
  if (!ctx || !point) return;
  const screen = mapTabScreen(point);
  const angle = to ? Math.atan2(to.y - point.y, to.x - point.x) : 0;
  const size = Math.max(3, Math.min(7, mapTabView.scale * 0.11));
  if (kind === 'ship') {
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(3, size * 0.8), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0d2a36';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(Number.isFinite(angle) ? angle : 0);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.6);
  ctx.lineTo(-size * 0.7, -size * 0.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#22353b';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function mapTabDrawWorld() {
  const canvas = $('map-canvas');
  if (!canvas || !mapTabLayout || typeof canvas.getContext !== 'function') return;
  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;
  if (!width || !height) return;
  if (!mapTabView.userAdjusted) fitWorldMap();

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    mapTabStatic = { key: '', canvas: null };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  mapTabDash = (Date.now() / 55) % 13;

  const key = mapTabStaticKey(width, height);
  if (mapTabStatic.key !== key || !mapTabStatic.canvas) {
    mapTabStatic = { key, canvas: drawWorldMapStatic(width, height, dpr) };
  }
  if (mapTabStatic.canvas) ctx.drawImage(mapTabStatic.canvas, 0, 0, width, height);

  if (mapTabLayerOn('objects')) {
    // 当前万吨货轮：绿色方框标出整格（同官方地图），有数据才画。
    const merchantShip = mapTabLive?.merchantShip;
    if (merchantShip?.cell) {
      const screen = mapTabScreen(merchantShip.cell);
      const half = mapTabView.scale / 2;
      ctx.strokeStyle = mapTabObjectColors.merchantShip;
      ctx.lineWidth = Math.max(1.5, Math.min(3, mapTabView.scale * 0.05));
      ctx.strokeRect(screen.x - half + 2, screen.y - half + 2, mapTabView.scale - 4, mapTabView.scale - 4);
      if (mapTabView.scale >= 34) {
        ctx.fillStyle = '#7dffa2';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(mapTabObjectLabels.merchantShip, screen.x, screen.y + half + 3);
      }
    }
    // 今日世界 Boss：静态 bossData 只是候选位，只画 WorldBossInfo.gridIdx 命中的那一只。
    const bossGrid = Number(mapTabLive?.worldBoss?.gridIdx) || 0;
    const bossPoint = bossGrid
      ? (Array.isArray(mapTabLayout.objects?.boss) ? mapTabLayout.objects.boss : [])
        .find((point) => Number(point?.gridIdx) === bossGrid)
      : null;
    if (bossPoint?.cell) {
      const screen = mapTabScreen(bossPoint.cell);
      const size = Math.max(3.5, Math.min(7, mapTabView.scale * 0.14));
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y - size);
      ctx.lineTo(screen.x + size, screen.y);
      ctx.lineTo(screen.x, screen.y + size);
      ctx.lineTo(screen.x - size, screen.y);
      ctx.closePath();
      ctx.fillStyle = mapTabObjectColors.boss;
      ctx.fill();
      ctx.strokeStyle = 'rgba(10, 30, 38, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (mapTabView.scale >= 42) {
        ctx.fillStyle = 'rgba(235, 246, 245, 0.85)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(mapTabObjectLabels.boss, screen.x, screen.y + size + 2);
      }
    }
  }

  if (mapTabLayerOn('myFleets')) {
    for (const fleet of mapTabLive?.fleets ?? []) {
      const head = mapTabHead(fleet.track);
      if (!head) continue;
      drawWorldMapRoute(ctx, fleet.track, '#ffd166', 'rgba(255, 209, 102, 0.22)');
      drawWorldMapMarker(ctx, head, fleet.track?.to, mapTabOwnColor, 'fleet');
      // 自己的舰队始终标注名称 + 耐久；行军/维修时再补一行实时倒计时。
      const serverNow = mapTabServerNow();
      const lines = [fleet.buildingId];
      if (fleet.maxDura) lines.push('耐久 ' + fmt(fleet.durability) + '/' + fmt(fleet.maxDura) +
        (fleet.state === 2 && fleet.track?.moving ? ' · ' + mapTabClock(fleet.track.end - serverNow) : ''));
      if (fleet.state === 4 && Number(fleet.repairEndTs) > serverNow) {
        lines.push('维修 ' + mapTabClock(fleet.repairEndTs - serverNow));
      }
      const screen = mapTabScreen(head);
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      lines.forEach((label, index) => {
        const textWidth = ctx.measureText(label).width;
        const top = screen.y + 14 + index * 14;
        ctx.fillStyle = 'rgba(8, 24, 30, 0.82)';
        ctx.fillRect(screen.x + 7, top, textWidth + 6, 12);
        ctx.fillStyle = index ? '#cfe0e4' : '#ffe3a3';
        ctx.fillText(label, screen.x + 10, top + 6);
      });
    }
  }

  const worldFleets = mapTabLive?.worldFleets ?? [];
  const drawWorldFleet = (fleet, color, faded) => {
    const head = mapTabHead(fleet.track);
    if (!head) return;
    drawWorldMapRoute(ctx, fleet.track, color, faded);
    drawWorldMapMarker(ctx, head, fleet.track?.to, color, 'fleet');
    if (mapTabView.scale >= 80) {
      const screen = mapTabScreen(head);
      ctx.fillStyle = '#e8f2f2';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fleet.owner?.nickname || fleet.buildingId, screen.x + 7, screen.y - 7);
    }
  };
  if (mapTabLayerOn('allyFleets')) {
    for (const fleet of worldFleets) if (fleet.kind === 'ally') drawWorldFleet(fleet, '#7ee0c8', 'rgba(126, 224, 200, 0.22)');
  }
  if (mapTabLayerOn('enemyFleets')) {
    for (const fleet of worldFleets) if (fleet.kind === 'enemy') drawWorldFleet(fleet, '#e2685f', 'rgba(226, 104, 95, 0.22)');
  }

  if (mapTabLive?.trade?.open) {
    const cargo = mapTabLive.trade.cargo;
    if (mapTabLayerOn('trade') && cargo?.track) {
      const head = mapTabHead(cargo.track);
      if (head) {
        drawWorldMapRoute(ctx, cargo.track, '#ffbd77', 'rgba(255, 189, 119, 0.22)');
        drawWorldMapMarker(ctx, head, cargo.track?.to, '#ffbd77', 'ship');
      }
    }
    if (mapTabLayerOn('allyTrade')) {
      const ownGuildIdx = Number(mapTabLive.ownGuildIdx) || 0;
      for (const ship of mapTabLive.trade.worldCargo ?? []) {
        if (!ship.track || Number(ship.guildIdx) !== ownGuildIdx || !ownGuildIdx) continue;
        const head = mapTabHead(ship.track);
        if (!head) continue;
        drawWorldMapRoute(ctx, ship.track, 'rgba(126, 224, 200, 0.7)', 'rgba(126, 224, 200, 0.12)');
        drawWorldMapMarker(ctx, head, ship.track?.to, 'rgba(126, 224, 200, 0.7)', 'ship');
      }
    }
  }

  const outline = (hit, color, width) => {
    if (!hit) return;
    let point = null;
    if (hit.kind === 'city') point = {
      x: hit.city.col + Math.max(1, hit.city.colSpan || 1) / 2,
      y: hit.city.row + Math.max(1, hit.city.rowSpan || 1) / 2,
    };
    else if (hit.kind === 'fleet') point = mapTabHead(hit.fleet.track);
    else if (hit.kind === 'cargo') point = mapTabHead(hit.track ?? hit.cargo?.track);
    if (!point) return;
    const screen = mapTabScreen(point);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(6, mapTabView.scale * 0.42), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  outline(mapTabHover, '#ffffff', 1.5);
  outline(mapTabSelected, '#ffbd77', 2);
}

function startWorldMapTimers() {
  if (!mapTabRefreshTimer) {
    mapTabRefreshTimer = setInterval(() => {
      if (!mapTabVisible() || document.hidden) return;
      const auto = $('map-auto');
      if (auto && !auto.checked) return;
      if (!current || disconnected.has(current) || snapshot.paused) return;
      if (mapTabLoading) return;
      const wantFresh = Date.now() - mapTabLastFreshAt >= 30000;
      void refreshWorldMapState(wantFresh);
    }, 5000);
  }
  if (typeof requestAnimationFrame === 'function') {
    if (!mapTabFrame) mapTabFrame = requestAnimationFrame(mapTabAnimate);
    return;
  }
  // 无 requestAnimationFrame 的环境（离线测试桩）退回低频重绘。
  if (!mapTabTimer) mapTabTimer = setInterval(() => {
    if (mapTabVisible() && !document.hidden) mapTabDrawWorld();
  }, 500);
}

function mapTabAnimate() {
  mapTabFrame = null;
  if (!mapTabVisible() || document.hidden) return;
  mapTabDrawWorld();
  mapTabFrame = requestAnimationFrame(mapTabAnimate);
}

async function refreshWorldMapState(fresh = false) {
  const account = current;
  if (!account || account !== mapTabAccount) return;
  const version = mapTabVersion;
  try {
    const data = await call('/api/map/state' + (fresh ? '?fresh=1' : ''));
    if (version !== mapTabVersion || account !== current) return;
    mapTabLastFreshAt = fresh ? Date.now() : mapTabLastFreshAt;
    mapTabApplyState(data);
    if (data.scenarioId && mapTabLayout && Number(data.scenarioId) !== Number(mapTabLayout.scenarioId)) {
      await mapTabRefresh(true);
      return;
    }
    mapTabSetEmpty('');
    mapTabDrawWorld();
  } catch (error) {
    mapTabSetStatus('地图状态读取失败：' + error.message);
  }
}

async function mapTabRefresh(force = false) {
  bindWorldMap();
  startWorldMapTimers();
  const account = current;
  if (!account) {
    mapTabSetEmpty('请先在顶部选择账号');
    mapTabSetStatus('');
    return;
  }
  if (account !== mapTabAccount) {
    mapTabAccount = account;
    mapTabLayout = null;
    mapTabLive = null;
    mapTabLastFreshAt = 0;
    mapTabWarChoices = new Map();
  }
  const version = ++mapTabVersion;
  mapTabLoading = true;
  mapTabSetEmpty('正在加载世界地图…');
  try {
    if (!mapTabLayout || force) {
      const layout = await call('/api/map/layout');
      if (version !== mapTabVersion || account !== current) return;
      applyWorldMapLayout(layout);
    }
    const fresh = force || Date.now() - mapTabLastFreshAt >= 30000;
    const data = await call('/api/map/state' + (fresh ? '?fresh=1' : ''));
    if (version !== mapTabVersion || account !== current) return;
    if (fresh) mapTabLastFreshAt = Date.now();
    mapTabApplyState(data);
    mapTabSetEmpty('');
    if (!mapTabView.userAdjusted) fitWorldMap();
    mapTabDrawWorld();
  } catch (error) {
    mapTabSetEmpty('世界地图加载失败：' + error.message);
    mapTabSetStatus('加载失败');
  } finally {
    mapTabLoading = false;
  }
}

function mapTabHitAt(px, py) {
  if (!mapTabLayout) return null;
  const scale = mapTabView.scale;
  const gx = (px - mapTabView.tx) / scale;
  const gy = (py - mapTabView.ty) / scale;
  if (gx < 0 || gy < 0 || gx >= mapTabLayout.columns || gy >= mapTabLayout.rows) return null;

  const near = (point) => {
    const screen = mapTabScreen(point);
    return Math.hypot(screen.x - px, screen.y - py) <= 12;
  };
  if (mapTabLayerOn('myFleets')) {
    for (const fleet of mapTabLive?.fleets ?? []) {
      const head = mapTabHead(fleet.track);
      if (head && near(head)) return { kind: 'fleet', fleet };
    }
  }
  if (mapTabLayerOn('allyFleets') || mapTabLayerOn('enemyFleets')) {
    for (const fleet of mapTabLive?.worldFleets ?? []) {
      if (fleet.kind === 'ally' && !mapTabLayerOn('allyFleets')) continue;
      if (fleet.kind === 'enemy' && !mapTabLayerOn('enemyFleets')) continue;
      const head = mapTabHead(fleet.track);
      if (head && near(head)) return { kind: 'fleet', fleet };
    }
  }
  const cargo = mapTabLive?.trade?.cargo;
  if (mapTabLayerOn('trade') && cargo?.track && near(mapTabHead(cargo.track))) {
    return { kind: 'cargo', cargo, track: cargo.track, own: true };
  }
  if (mapTabLayerOn('allyTrade')) {
    const ownGuildIdx = Number(mapTabLive?.ownGuildIdx) || 0;
    for (const ship of mapTabLive?.trade?.worldCargo ?? []) {
      if (!ownGuildIdx || Number(ship.guildIdx) !== ownGuildIdx) continue;
      const head = mapTabHead(ship.track);
      if (head && near(head)) return { kind: 'cargo', cargo: ship, track: ship.track, own: false };
    }
  }
  if (mapTabLayerOn('objects')) {
    const merchantShip = mapTabLive?.merchantShip;
    if (merchantShip?.cell && near(merchantShip.cell)) {
      return { kind: 'object', object: { kind: 'merchantShip', point: merchantShip } };
    }
    for (const [kind, list] of Object.entries(mapTabLayout.objects ?? {})) {
      // 静态宝藏位只是货轮停靠点，悬停也不当作对象命中；
      // boss 候选位里只有今日 gridIdx 命中的那只在地图上存在。
      if (kind === 'treasure') continue;
      const points = Array.isArray(list) ? list : (list ? [list] : []);
      for (const point of points) {
        if (kind === 'boss' && Number(point?.gridIdx) !== Number(mapTabLive?.worldBoss?.gridIdx)) continue;
        if (point?.cell && near(point.cell)) return { kind: 'object', object: { kind, point } };
      }
    }
  }
  const city = mapTabCityAtCell({ x: gx, y: gy });
  if (city) return { kind: 'city', city };
  return null;
}

function bindWorldMap() {
  const canvas = $('map-canvas');
  if (!canvas || canvas.dataset.mapTabBound === '1') return;
  canvas.dataset.mapTabBound = '1';

  for (const input of document.querySelectorAll('[data-map-layer]')) {
    mapTabLayers[input.dataset.mapLayer] = input.checked !== false;
    input.onchange = () => {
      mapTabLayers[input.dataset.mapLayer] = input.checked;
      mapTabStatic = { key: '', canvas: null };
      mapTabDrawWorld();
    };
  }

  const refresh = $('map-refresh');
  if (refresh) refresh.onclick = () => { void mapTabRefresh(true); };
  const fit = $('map-fit');
  if (fit) fit.onclick = () => { fitWorldMap(); mapTabStatic = { key: '', canvas: null }; mapTabDrawWorld(); };
  const focus = $('map-focus');
  if (focus) focus.onclick = () => { focusWorldMapFleets(); mapTabStatic = { key: '', canvas: null }; mapTabDrawWorld(); };
  const warSave = $('map-war-save');
  if (warSave) warSave.onclick = () => { void saveWorldMapWarSettings(); };

  canvas.addEventListener('wheel', (event) => {
    if (!mapTabLayout) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const before = { x: (mx - mapTabView.tx) / mapTabView.scale, y: (my - mapTabView.ty) / mapTabView.scale };
    const scale = Math.min(160, Math.max(8, mapTabView.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    mapTabView = {
      ...mapTabView, scale, userAdjusted: true,
      tx: mx - before.x * scale,
      ty: my - before.y * scale,
    };
    mapTabStatic = { key: '', canvas: null };
    mapTabDrawWorld();
  }, { passive: false });

  // Pointer Events 统一鼠标与触摸；粗指针默认放行页面滚动（pan-y），点“移动地图”后锁定画布拖拽。
  let mapTouchPan = false;
  if (matchMedia('(pointer: coarse)').matches) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = '移动地图';
    toggle.addEventListener('click', () => {
      mapTouchPan = !mapTouchPan;
      toggle.classList.toggle('active', mapTouchPan);
      toggle.textContent = mapTouchPan ? '完成移动' : '移动地图';
      canvas.classList.toggle('gs-pan', mapTouchPan);
    });
    canvas.after(toggle);
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' && !mapTouchPan) return;
    canvas.setPointerCapture(event.pointerId);
    mapTabDragMoved = false;
    mapTabDrag = { x: event.clientX, y: event.clientY, tx: mapTabView.tx, ty: mapTabView.ty };
  });
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    if (mapTabDrag) {
      const dx = event.clientX - mapTabDrag.x;
      const dy = event.clientY - mapTabDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) mapTabDragMoved = true;
      mapTabView = { ...mapTabView, tx: mapTabDrag.tx + dx, ty: mapTabDrag.ty + dy, userAdjusted: true };
      mapTabStatic = { key: '', canvas: null };
      mapTabDrawWorld();
      return;
    }
    if (event.pointerType !== 'mouse') return;
    mapTabHover = mapTabHitAt(mx, my);
    positionWorldMapTooltip(mx, my);
    mapTabDrawWorld();
  });
  const endDrag = () => { mapTabDrag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('mouseleave', () => {
    endDrag();
    mapTabHover = null;
    positionWorldMapTooltip(0, 0);
    mapTabDrawWorld();
  });
  canvas.addEventListener('click', () => {
    if (mapTabDragMoved) return;
    mapTabSelected = mapTabHover;
    renderWorldMapDetail(mapTabSelected);
    mapTabDrawWorld();
  });

  window.addEventListener('resize', () => {
    if (!mapTabVisible()) return;
    if (!mapTabView.userAdjusted) fitWorldMap();
    mapTabStatic = { key: '', canvas: null };
    mapTabDrawWorld();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mapTabVisible()) startWorldMapTimers();
  });
}

// 世界地图：按真实地图坐标把世界排成城池网格，普通城一格，大城（如山景城）占多格。
// 该脚本被内联进控制台页面，与 page.mjs 的 $ / el / clear / call / current / snapshot 共享作用域。
// 顶层只声明状态和函数，不访问 DOM；首次进入标签页时才绑定事件与请求数据。

const worldMapResColors = { 1: '#4f9f6a', 2: '#3f8fbf', 3: '#bf8f3f' };
const worldMapNeutralColor = '#5c6b70';
const worldMapEmptyColor = '#112b36';
const worldMapOwnColor = '#ffd166';
const worldMapBattleColor = '#e2685f';
// 城战标记：我方宣战的进攻目标用橙色虚框，受袭城（守方是我方）加一圈防守蓝框。
const worldMapAttackColor = '#ffbd77';
const worldMapDefendColor = '#5aa9e6';
const worldMapObjectColors = { boss: '#e2685f', limitedBoss: '#e08a3f', treasure: '#d9b45f', chipMine: '#63c6c9', wreck: '#9aa9ae', merchantShip: '#00ff00' };
const worldMapObjectLabels = { boss: '世界 Boss', treasure: '宝藏', merchantShip: '搁浅货轮', limitedBoss: '限时 Boss', chipMine: '硅矿', wreck: '沉船' };

let worldMapLayout = null;
let worldMapLive = null;
let worldMapReceivedAt = 0;
let worldMapCityByCell = new Map();
let worldMapFieldsByCity = new Map();
let worldMapObjectsByCity = new Map();
let worldMapObjectByGrid = new Map();
let worldMapMerchantByGrid = new Map();
let worldMapVersion = 0;
let worldMapAccount = null;
let worldMapLoading = false;
let worldMapLastFreshAt = 0;
let worldMapTimer = null;
let worldMapRefreshTimer = null;
let worldMapFrame = null;
let worldMapDash = 0;
let worldMapStatic = { key: '', canvas: null };
let worldMapWarChoices = new Map();
let worldMapView = { scale: 1, tx: 0, ty: 0, width: 0, height: 0, userAdjusted: false };
let worldMapDrag = null;
let worldMapDragMoved = false;
let worldMapHover = null;
let worldMapSelected = null;
let worldMapLayers = {
  faction: true, fields: false,
  myFleets: true, allyFleets: true, enemyFleets: false,
  trade: true, allyTrade: true,
  objects: true, grid: true,
};

function worldMapVisible() {
  const section = $('tab-map');
  return Boolean(section) && !section.classList.contains('hidden');
}

function worldMapLayerOn(name) {
  return worldMapLayers[name] !== false;
}

function worldMapDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!value) return '已到达';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes) return minutes + ' 分';
  return value + ' 秒';
}

// 倒计时用紧凑时钟格式（mm:ss / h:mm:ss），与粗粒度的 worldMapDuration 区分。
function worldMapClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return (hours ? hours + ':' + pad(minutes) : String(minutes)) + ':' + pad(value % 60);
}

function worldMapGuildColor(guildIdx) {
  const entry = (worldMapLive?.legend ?? []).find((row) => Number(row.guildIdx) === Number(guildIdx));
  return entry?.color ?? (Number(guildIdx) > 0 ? '#8aa0a8' : worldMapNeutralColor);
}

function worldMapCityName(cityId) {
  const city = worldMapLayout?.cities?.find((row) => row.id === Number(cityId));
  return city?.name ?? ('城 #' + cityId);
}

// 连续格坐标转成游戏里的「行字母 + 列号」位置名（如 E3）；行号超出字母表时退回数字。
function worldMapCellName(cell) {
  if (!cell) return '';
  const letters = 'ABCDEFGHIJ';
  const row = Math.floor(cell.y);
  const col = Math.floor(cell.x);
  return (letters[row] ?? String(row)) + col;
}

function worldMapCityAtCell(point) {
  if (!point) return null;
  return worldMapCityByCell.get(Math.floor(point.x) + ',' + Math.floor(point.y)) ?? null;
}

function worldMapServerNow() {
  const base = Number(worldMapLive?.serverNow) || Date.now() / 1000;
  return base + (Date.now() - worldMapReceivedAt) / 1000;
}

function worldMapHead(track) {
  if (!track) return null;
  const start = Number(track.start);
  const end = Number(track.end);
  if (!(end > start) || !track.from || !track.to) return track.head ?? track.from ?? null;
  const progress = Math.min(1, Math.max(0, (worldMapServerNow() - start) / (end - start)));
  return {
    x: track.from.x + (track.to.x - track.from.x) * progress,
    y: track.from.y + (track.to.y - track.from.y) * progress,
  };
}

// 格坐标（城市格中心为 col + 0.5 / row + 0.5）到画布像素。
function worldMapScreen(point) {
  return { x: point.x * worldMapView.scale + worldMapView.tx, y: point.y * worldMapView.scale + worldMapView.ty };
}

function worldMapSetEmpty(text) {
  const node = $('map-empty');
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
}

function worldMapSetStatus(text) {
  const node = $('map-status');
  if (node) node.textContent = text || '';
}

function applyWorldMapLayout(layout) {
  worldMapLayout = layout;
  worldMapCityByCell = new Map();
  for (const city of layout?.cities ?? []) {
    if (!Number.isSafeInteger(city.col) || !Number.isSafeInteger(city.row)) continue;
    const colSpan = Math.max(1, city.colSpan || 1);
    const rowSpan = Math.max(1, city.rowSpan || 1);
    // 大城占多格：命中与悬浮时每一格都要指回同一座城。
    for (let dy = 0; dy < rowSpan; dy += 1) {
      for (let dx = 0; dx < colSpan; dx += 1) {
        worldMapCityByCell.set((city.col + dx) + ',' + (city.row + dy), city);
      }
    }
  }
  worldMapFieldsByCity = new Map();
  for (const field of layout?.fields ?? []) {
    if (!worldMapFieldsByCity.has(field.cityId)) worldMapFieldsByCity.set(field.cityId, []);
    worldMapFieldsByCity.get(field.cityId).push(field);
  }
  worldMapObjectsByCity = new Map();
  worldMapObjectByGrid = new Map();
  for (const [kind, list] of Object.entries(layout?.objects ?? {})) {
    const points = Array.isArray(list) ? list : (list ? [list] : []);
    for (const point of points) {
      // 城池详情的"世界对象"不列静态宝藏位，避免每个城都挂一条"宝藏"；
      // 舰队目标格反查仍登记宝藏，舰队列表里"目标：宝藏"的命名要靠它。
      if (kind !== 'treasure' && point?.cityId > 0) {
        if (!worldMapObjectsByCity.has(point.cityId)) worldMapObjectsByCity.set(point.cityId, []);
        worldMapObjectsByCity.get(point.cityId).push({ kind, point });
      }
      // 舰队目标格反查对象名（宝藏/货轮/Boss…），目标不是城时详情与舰队列表用它。
      if (Number.isSafeInteger(point?.gridIdx)) worldMapObjectByGrid.set(point.gridIdx, { kind, point });
    }
  }
  worldMapStatic = { key: '', canvas: null };
  worldMapView = { scale: 1, tx: 0, ty: 0, width: 0, height: 0, userAdjusted: false };
  worldMapHover = null;
  worldMapSelected = null;
}

function worldMapApplyState(state) {
  worldMapLive = state;
  worldMapReceivedAt = Date.now();
  // 当前万吨货轮的格子优先于静态宝藏位命名（舰队目标反查用）。
  worldMapMerchantByGrid = new Map();
  const ship = state?.merchantShip;
  if (ship && Number.isSafeInteger(ship.gridIdx)) {
    worldMapMerchantByGrid.set(ship.gridIdx, { kind: 'merchantShip', point: ship });
  }
  // bossData 候选位只保留今日 WorldBossInfo.gridIdx 命中的那一只：
  // 城池详情的"世界对象"和舰队目标反查都不再提其他候选位。
  const bossGrid = Number(state?.worldBoss?.gridIdx) || 0;
  for (const [cityId, list] of worldMapObjectsByCity) {
    const kept = list.filter((entry) => entry.kind !== 'boss' || Number(entry.point?.gridIdx) === bossGrid);
    if (kept.length !== list.length) worldMapObjectsByCity.set(cityId, kept);
  }
  for (const [grid, entry] of worldMapObjectByGrid) {
    if (entry.kind === 'boss' && Number(grid) !== bossGrid) worldMapObjectByGrid.delete(grid);
  }
  renderWorldMapLegend();
  renderWorldMapStatus();
  renderWorldMapFleets();
  renderWorldMapWar();
  renderWorldMapWarSettings();
}

function worldMapObjectAtGrid(gridIdx) {
  const grid = Number(gridIdx);
  if (!grid) return null;
  return worldMapMerchantByGrid.get(grid) ?? worldMapObjectByGrid.get(grid) ?? null;
}

function worldMapFleetTargetText(fleet) {
  if (fleet.state === 4 && Number(fleet.repairEndTs) > 0) {
    const remain = fleet.repairEndTs - worldMapServerNow();
    return remain > 0 ? '维修中 · 剩 ' + worldMapClock(remain) : '维修收尾';
  }
  if (fleet.track?.moving) {
    const object = worldMapObjectAtGrid(fleet.targetGridIdx);
    const target = fleet.targetCityId ? worldMapCityName(fleet.targetCityId)
      : (object ? (worldMapObjectLabels[object.kind] ?? object.kind) : worldMapCityAtCell(fleet.track.to)?.name);
    return '前往 ' + (target || '目标') + ' · ' + worldMapDuration(fleet.track.eta);
  }
  return fleet.cityId ? '在 ' + worldMapCityName(fleet.cityId) : '待命';
}

function renderWorldMapFleets() {
  const box = $('map-fleets');
  const count = $('map-fleet-count');
  if (!box) return;
  clear(box);
  const fleets = worldMapLive?.fleets ?? [];
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
    body.appendChild(el('div', 'world-map-fleet-meta', worldMapFleetTargetText(fleet)));
    row.appendChild(dot);
    row.appendChild(body);
    box.appendChild(row);
  }
}

function worldMapWarTargetOptions(role) {
  const war = worldMapLive?.war;
  if (!war) return [];
  return role === 'defend' ? (war.defendTargets ?? []) : (war.attackTargets ?? []);
}

function worldMapWarTargetLabel(target) {
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
  const war = worldMapLive?.war;
  const worldFleets = worldMapLive?.worldFleets ?? [];
  const allyCount = worldFleets.filter((fleet) => fleet.kind === 'ally').length;
  const enemyCount = worldFleets.filter((fleet) => fleet.kind === 'enemy').length;
  if (status) {
    if (!war || !war.ownGuildIdx) status.textContent = worldMapLive ? '未加入联盟或暂无城战数据' : '';
    else if (war.active) {
      const start = new Date(war.startTime * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const end = new Date(war.endTime * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      status.textContent = '进行中 ' + start + '–' + end +
        ' · 可进攻 ' + (war.attackTargets?.length ?? 0) + ' · 可防守 ' + (war.defendTargets?.length ?? 0) +
        (war.assembleCityId ? ' · 集结城 ' + worldMapCityName(war.assembleCityId) : '');
    } else {
      status.textContent = `未开始/已结束 · 可进攻 ${war.attackTargets?.length ?? 0} · 可防守 ${war.defendTargets?.length ?? 0}`;
    }
    if (allyCount || enemyCount) status.textContent += ` · 盟友舰队 ${allyCount} / 敌方 ${enemyCount}`;
  }

  // 受袭城市单独列出（宣战守方是我方的城），哪怕舰队数据未就绪也要可见。
  const attacked = (war?.defendTargets ?? []).filter((target) => target.underAttack);
  if (attacked.length) {
    box.appendChild(el('div', 'dim', '受袭：' + attacked.map((target) => worldMapWarTargetLabel(target)).join('、')));
  }

  const fleets = worldMapLive?.fleets ?? [];
  if (!fleets.length) {
    box.appendChild(el('span', 'dim', '连接后可按舰队设置城战目标'));
    return;
  }
  for (const fleet of fleets) {
    const key = String(fleet.buildingId);
    const choice = worldMapWarChoices.get(key) ?? { role: 'auto', cityId: 0 };
    const targets = worldMapWarTargetOptions(choice.role);
    if (choice.cityId && !targets.some((target) => target.cityId === choice.cityId)) {
      choice.cityId = 0;
      worldMapWarChoices.set(key, choice);
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
      worldMapWarChoices.set(key, { role: role.value, cityId: 0 });
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
      option.textContent = worldMapWarTargetLabel(item);
      target.appendChild(option);
    }
    target.value = String(choice.cityId || 0);
    target.disabled = choice.role === 'auto' || !targets.length;
    target.onchange = () => {
      const cityId = Number(target.value) || 0;
      worldMapWarChoices.set(key, { role: choice.role, cityId });
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
  const settings = worldMapLive?.cityWarSettings;
  if (!settings) return;
  for (const [id, value] of [['map-war-enabled', settings.enabled], ['map-war-online', settings.online], ['map-war-reattack', settings.reattack]]) {
    const input = $(id);
    if (input && document.activeElement !== input) input.checked = value === true;
  }
}

function dispatchWorldMapWarFleet(buildingId) {
  const choice = worldMapWarChoices.get(String(buildingId));
  if (!choice || choice.role === 'auto' || !choice.cityId) return;
  const target = worldMapWarTargetOptions(choice.role).find((item) => item.cityId === choice.cityId);
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
    if (worldMapLive) worldMapLive.cityWarSettings = result.cityWar;
    if (hint) hint.textContent = '城战自动化开关已保存';
  } catch (error) {
    if (hint) hint.textContent = '保存失败：' + error.message;
  }
}

function worldMapStatusLine() {
  const state = worldMapLive;
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
    parts.push('商船 ' + worldMapCityName(cargo.cityId) + ' → ' + worldMapCityName(cargo.moveToCityId));
  }
  if (state.warnings?.length) parts.push(state.warnings[0]);
  return parts.join(' · ');
}

function renderWorldMapStatus() {
  worldMapSetStatus(worldMapStatusLine());
}

function renderWorldMapLegend() {
  const box = $('map-legend');
  if (!box) return;
  clear(box);
  const legend = worldMapLive?.legend ?? [];
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
  const war = worldMapLive?.war;
  if (war && ((war.attackTargets?.length ?? 0) || (war.defendTargets ?? []).some((target) => target.underAttack))) {
    const marks = [['world-map-swatch-ring', worldMapAttackColor, 'dashed', '我方进攻目标'], ['world-map-swatch-ring', worldMapDefendColor, 'solid', '受袭（需防守）']];
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

function worldMapObjectText(cityId) {
  const objects = worldMapObjectsByCity.get(cityId) ?? [];
  return objects.map((entry) => worldMapObjectLabels[entry.kind] || entry.kind).join('、');
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
    const owner = worldMapLive?.cities?.find((row) => row.id === city.id);
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
    const objects = worldMapObjectText(city.id);
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
    const object = worldMapObjectAtGrid(fleet.targetGridIdx);
    const target = fleet.targetCityId ? worldMapCityName(fleet.targetCityId)
      : (object ? (worldMapObjectLabels[object.kind] ?? object.kind) : worldMapCityAtCell(fleet.track?.to)?.name);
    lines.push('目标：' + (target || '原地'));
    lines.push(fleet.track?.moving ? 'ETA ' + worldMapDuration(fleet.track.eta) : '已到达');
  } else if (hit.kind === 'object') {
    const label = worldMapObjectLabels[hit.object.kind] ?? hit.object.kind;
    lines.push(label);
    lines.push('位置 ' + worldMapCellName(hit.object.point.cell) + ' 格附近');
    if (hit.object.kind === 'merchantShip') {
      const owner = Number(hit.object.point.ownerGuildIdx) > 0
        ? '联盟 #' + hit.object.point.ownerGuildIdx
        : '无主';
      lines.push('占领方：' + owner + ' · 进度 ' + hit.object.point.progress + '%');
    }
  } else if (hit.kind === 'cargo') {
    const cargo = hit.cargo;
    lines.push(hit.own ? '我方商船 · 等级 ' + (cargo.cargoLv ?? '-') : (cargo.nickname || '其他玩家') + ' 的商船');
    lines.push('航线：' + worldMapCityName(cargo.cityId) + ' → ' + worldMapCityName(cargo.moveToCityId));
    lines.push(hit.track?.moving ? 'ETA ' + worldMapDuration(hit.track.eta) : '已停靠');
  }
  for (const line of lines) box.appendChild(el('div', null, line));
  if (hit.kind === 'city') appendWorldMapDefence(hit.city.id);
}

// 点击城池后异步拉取守军列表（CityDefenceRequest），追加在详情面板底部；过期响应按序号丢弃。
let worldMapDefenceSeq = 0;
async function appendWorldMapDefence(cityId) {
  const box = $('map-detail');
  if (!box) return;
  const seq = ++worldMapDefenceSeq;
  const holder = el('div', 'world-map-defence dim', '守军信息读取中…');
  box.appendChild(holder);
  try {
    const data = await call('/api/map/city-defence?cityId=' + encodeURIComponent(cityId));
    if (seq !== worldMapDefenceSeq) return;
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
    if (seq !== worldMapDefenceSeq) return;
    holder.classList.remove('dim');
    holder.textContent = '守军信息读取失败：' + error.message;
  }
}

function worldMapTooltipText(hit) {
  if (!hit) return '';
  if (hit.kind === 'city') {
    const owner = worldMapLive?.cities?.find((row) => row.id === hit.city.id);
    const faction = Number(owner?.guildIdx) > 0 ? '联盟 #' + owner.guildIdx : '中立';
    return hit.city.name + ' · ' + hit.city.level + ' 级\n势力 ' + faction + (owner?.own ? '（我方）' : '');
  }
  if (hit.kind === 'fleet') {
    const label = hit.fleet.kind
      ? (hit.fleet.kind === 'ally' ? '盟友 ' : '敌方 ') + (hit.fleet.owner?.nickname || hit.fleet.buildingId)
      : hit.fleet.buildingId;
    return label + ' · ' + hit.fleet.stateText + '\n' +
      (hit.fleet.track?.moving ? 'ETA ' + worldMapDuration(hit.fleet.track.eta) : '已到达');
  }
  if (hit.kind === 'object') {
    const label = worldMapObjectLabels[hit.object.kind] ?? hit.object.kind;
    return label + '\n位置 ' + worldMapCellName(hit.object.point.cell) + ' 格附近';
  }
  if (hit.kind === 'cargo') {
    return (hit.own ? '我方商船' : (hit.cargo.nickname || '其他玩家')) + '\n' +
      (hit.track?.moving ? 'ETA ' + worldMapDuration(hit.track.eta) : '已停靠');
  }
  return '';
}

function positionWorldMapTooltip(px, py) {
  const tip = $('map-tooltip');
  if (!tip) return;
  const text = worldMapTooltipText(worldMapHover);
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
  if (!canvas || !worldMapLayout) return;
  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;
  if (!width || !height) return;
  const columns = worldMapLayout.columns || 1;
  const rows = worldMapLayout.rows || 1;
  const scale = Math.max(8, Math.min(width / columns, height / rows) * 0.94);
  worldMapView = {
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
  const heads = (worldMapLive?.fleets ?? []).map((fleet) => worldMapHead(fleet.track)).filter(Boolean);
  const cargo = worldMapLive?.trade?.cargo;
  if (cargo?.track) heads.push(worldMapHead(cargo.track));
  if (!canvas || !heads.length) {
    worldMapSetStatus('当前没有可定位的舰队或商船');
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
  worldMapView = {
    scale,
    tx: width / 2 - centerX * scale,
    ty: height / 2 - centerY * scale,
    width,
    height,
    userAdjusted: true,
  };
}

function worldMapStaticKey(width, height) {
  const state = worldMapLive;
  return [
    worldMapLayout?.scenarioId, worldMapLayout?.columns, worldMapLayout?.rows, width, height,
    Math.round(worldMapView.scale * 100), Math.round(worldMapView.tx), Math.round(worldMapView.ty),
    state?.updatedAt ?? '', state?.ownCityIds?.length ?? 0,
    worldMapLayerOn('fields') ? 1 : 0, worldMapLayerOn('faction') ? 1 : 0,
    worldMapLayerOn('grid') ? 1 : 0, worldMapLayerOn('objects') ? 1 : 0,
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

  const layout = worldMapLayout;
  const scale = worldMapView.scale;
  const columns = layout.columns || 1;
  const rows = layout.rows || 1;
  const ownership = new Map((worldMapLive?.cities ?? []).map((row) => [row.id, row]));
  const gap = Math.max(1, Math.min(5, scale * 0.07));

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const x = col * scale + worldMapView.tx;
      const y = row * scale + worldMapView.ty;
      ctx.fillStyle = worldMapEmptyColor;
      ctx.fillRect(x + gap / 2, y + gap / 2, scale - gap, scale - gap);
      if (worldMapLayerOn('grid')) {
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
    const x = city.col * scale + worldMapView.tx;
    const y = city.row * scale + worldMapView.ty;
    const blockWidth = scale * colSpan;
    const blockHeight = scale * rowSpan;
    const size = blockWidth - gap * 2;
    const sizeY = blockHeight - gap * 2;
    const color = worldMapLayerOn('faction') && owned
      ? worldMapGuildColor(owner.guildIdx)
      : (worldMapLayerOn('faction') ? worldMapNeutralColor : '#7f9aa1');
    ctx.fillStyle = color;
    ctx.fillRect(x + gap, y + gap, size, sizeY);
    if (owner?.battle) {
      ctx.strokeStyle = worldMapBattleColor;
      ctx.lineWidth = Math.max(2, scale * 0.045);
      ctx.strokeRect(x + gap + 1, y + gap + 1, size - 2, sizeY - 2);
    }
    if (owner?.own) {
      ctx.strokeStyle = worldMapOwnColor;
      ctx.lineWidth = Math.max(2, scale * 0.05);
      ctx.strokeRect(x + gap, y + gap, size, sizeY);
    }
    if (owner?.underAttack) {
      // 受袭城（宣战守方是我方）：外围一圈防守蓝框。
      ctx.strokeStyle = worldMapDefendColor;
      ctx.lineWidth = Math.max(2, scale * 0.05);
      ctx.strokeRect(x + gap - 3, y + gap - 3, size + 6, sizeY + 6);
    }
    if (owner?.attackTarget) {
      // 我方宣战的进攻目标：外围橙色虚框，与其他盟之间的交战红框区分。
      ctx.strokeStyle = worldMapAttackColor;
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

    if (worldMapLayerOn('fields')) {
      const fields = worldMapFieldsByCity.get(city.id) ?? [];
      const pip = Math.max(2, Math.min(5, scale * 0.07));
      const startX = x + gap + 3;
      const startY = y + blockHeight - gap - pip - 3;
      fields.slice(0, 7).forEach((field, index) => {
        ctx.fillStyle = worldMapResColors[field.resType] ?? '#7fa6a0';
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

  if (worldMapLayerOn('objects')) {
    // 世界对象画在真实位置（硅矿/沉船），不再挤在最近城池的角标里。
    // 静态宝藏位（treasureData）只是货轮停靠点，全部不显示，只画当前万吨货轮那格；
    // bossData 是四个候选位，今日 Boss 在动态层按 WorldBossInfo.gridIdx 画，这里全跳过。
    const size = Math.max(3.5, Math.min(7, scale * 0.14));
    for (const [kind, list] of Object.entries(layout.objects ?? {})) {
      if (kind === 'treasure' || kind === 'boss') continue;
      const points = Array.isArray(list) ? list : (list ? [list] : []);
      for (const point of points) {
        if (!point?.cell) continue;
        const screen = worldMapScreen(point.cell);
        if (screen.x < -20 || screen.y < -20 || screen.x > width + 20 || screen.y > height + 20) continue;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - size);
        ctx.lineTo(screen.x + size, screen.y);
        ctx.lineTo(screen.x, screen.y + size);
        ctx.lineTo(screen.x - size, screen.y);
        ctx.closePath();
        ctx.fillStyle = worldMapObjectColors[kind] ?? '#9aa9ae';
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
          ctx.fillText(worldMapObjectLabels[kind] ?? kind, screen.x, screen.y + size + 2);
        }
      }
    }
  }

  return canvas;
}

function drawWorldMapRoute(ctx, track, color, faded) {
  if (!track?.from || !track?.to || !track.moving) return;
  const scale = worldMapView.scale;
  const from = worldMapScreen(track.from);
  const to = worldMapScreen(track.to);
  const head = worldMapHead(track);
  const now = worldMapScreen(head);
  ctx.beginPath();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = faded;
  ctx.lineWidth = 1;
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.setLineDash([7, 6]);
  ctx.lineDashOffset = -worldMapDash;
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
  const screen = worldMapScreen(point);
  const angle = to ? Math.atan2(to.y - point.y, to.x - point.x) : 0;
  const size = Math.max(3, Math.min(7, worldMapView.scale * 0.11));
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

function drawWorldMap() {
  const canvas = $('map-canvas');
  if (!canvas || !worldMapLayout || typeof canvas.getContext !== 'function') return;
  const width = canvas.clientWidth || 0;
  const height = canvas.clientHeight || 0;
  if (!width || !height) return;
  if (!worldMapView.userAdjusted) fitWorldMap();

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    worldMapStatic = { key: '', canvas: null };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  worldMapDash = (Date.now() / 55) % 13;

  const key = worldMapStaticKey(width, height);
  if (worldMapStatic.key !== key || !worldMapStatic.canvas) {
    worldMapStatic = { key, canvas: drawWorldMapStatic(width, height, dpr) };
  }
  if (worldMapStatic.canvas) ctx.drawImage(worldMapStatic.canvas, 0, 0, width, height);

  if (worldMapLayerOn('objects')) {
    // 当前万吨货轮：绿色方框标出整格（同官方地图），有数据才画。
    const merchantShip = worldMapLive?.merchantShip;
    if (merchantShip?.cell) {
      const screen = worldMapScreen(merchantShip.cell);
      const half = worldMapView.scale / 2;
      ctx.strokeStyle = worldMapObjectColors.merchantShip;
      ctx.lineWidth = Math.max(1.5, Math.min(3, worldMapView.scale * 0.05));
      ctx.strokeRect(screen.x - half + 2, screen.y - half + 2, worldMapView.scale - 4, worldMapView.scale - 4);
      if (worldMapView.scale >= 34) {
        ctx.fillStyle = '#7dffa2';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(worldMapObjectLabels.merchantShip, screen.x, screen.y + half + 3);
      }
    }
    // 今日世界 Boss：静态 bossData 只是候选位，只画 WorldBossInfo.gridIdx 命中的那一只。
    const bossGrid = Number(worldMapLive?.worldBoss?.gridIdx) || 0;
    const bossPoint = bossGrid
      ? (Array.isArray(worldMapLayout.objects?.boss) ? worldMapLayout.objects.boss : [])
        .find((point) => Number(point?.gridIdx) === bossGrid)
      : null;
    if (bossPoint?.cell) {
      const screen = worldMapScreen(bossPoint.cell);
      const size = Math.max(3.5, Math.min(7, worldMapView.scale * 0.14));
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y - size);
      ctx.lineTo(screen.x + size, screen.y);
      ctx.lineTo(screen.x, screen.y + size);
      ctx.lineTo(screen.x - size, screen.y);
      ctx.closePath();
      ctx.fillStyle = worldMapObjectColors.boss;
      ctx.fill();
      ctx.strokeStyle = 'rgba(10, 30, 38, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (worldMapView.scale >= 42) {
        ctx.fillStyle = 'rgba(235, 246, 245, 0.85)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(worldMapObjectLabels.boss, screen.x, screen.y + size + 2);
      }
    }
  }

  if (worldMapLayerOn('myFleets')) {
    for (const fleet of worldMapLive?.fleets ?? []) {
      const head = worldMapHead(fleet.track);
      if (!head) continue;
      drawWorldMapRoute(ctx, fleet.track, '#ffd166', 'rgba(255, 209, 102, 0.22)');
      drawWorldMapMarker(ctx, head, fleet.track?.to, worldMapOwnColor, 'fleet');
      // 自己的舰队始终标注名称 + 耐久；行军/维修时再补一行实时倒计时。
      const serverNow = worldMapServerNow();
      const lines = [fleet.buildingId];
      if (fleet.maxDura) lines.push('耐久 ' + fmt(fleet.durability) + '/' + fmt(fleet.maxDura) +
        (fleet.state === 2 && fleet.track?.moving ? ' · ' + worldMapClock(fleet.track.end - serverNow) : ''));
      if (fleet.state === 4 && Number(fleet.repairEndTs) > serverNow) {
        lines.push('维修 ' + worldMapClock(fleet.repairEndTs - serverNow));
      }
      const screen = worldMapScreen(head);
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

  const worldFleets = worldMapLive?.worldFleets ?? [];
  const drawWorldFleet = (fleet, color, faded) => {
    const head = worldMapHead(fleet.track);
    if (!head) return;
    drawWorldMapRoute(ctx, fleet.track, color, faded);
    drawWorldMapMarker(ctx, head, fleet.track?.to, color, 'fleet');
    if (worldMapView.scale >= 80) {
      const screen = worldMapScreen(head);
      ctx.fillStyle = '#e8f2f2';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fleet.owner?.nickname || fleet.buildingId, screen.x + 7, screen.y - 7);
    }
  };
  if (worldMapLayerOn('allyFleets')) {
    for (const fleet of worldFleets) if (fleet.kind === 'ally') drawWorldFleet(fleet, '#7ee0c8', 'rgba(126, 224, 200, 0.22)');
  }
  if (worldMapLayerOn('enemyFleets')) {
    for (const fleet of worldFleets) if (fleet.kind === 'enemy') drawWorldFleet(fleet, '#e2685f', 'rgba(226, 104, 95, 0.22)');
  }

  if (worldMapLive?.trade?.open) {
    const cargo = worldMapLive.trade.cargo;
    if (worldMapLayerOn('trade') && cargo?.track) {
      const head = worldMapHead(cargo.track);
      if (head) {
        drawWorldMapRoute(ctx, cargo.track, '#ffbd77', 'rgba(255, 189, 119, 0.22)');
        drawWorldMapMarker(ctx, head, cargo.track?.to, '#ffbd77', 'ship');
      }
    }
    if (worldMapLayerOn('allyTrade')) {
      const ownGuildIdx = Number(worldMapLive.ownGuildIdx) || 0;
      for (const ship of worldMapLive.trade.worldCargo ?? []) {
        if (!ship.track || Number(ship.guildIdx) !== ownGuildIdx || !ownGuildIdx) continue;
        const head = worldMapHead(ship.track);
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
    else if (hit.kind === 'fleet') point = worldMapHead(hit.fleet.track);
    else if (hit.kind === 'cargo') point = worldMapHead(hit.track ?? hit.cargo?.track);
    if (!point) return;
    const screen = worldMapScreen(point);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(6, worldMapView.scale * 0.42), 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  outline(worldMapHover, '#ffffff', 1.5);
  outline(worldMapSelected, '#ffbd77', 2);
}

function startWorldMapTimers() {
  if (!worldMapRefreshTimer) {
    worldMapRefreshTimer = setInterval(() => {
      if (!worldMapVisible() || document.hidden) return;
      const auto = $('map-auto');
      if (auto && !auto.checked) return;
      if (!current || disconnected.has(current) || snapshot.paused) return;
      if (worldMapLoading) return;
      const wantFresh = Date.now() - worldMapLastFreshAt >= 30000;
      void refreshWorldMapState(wantFresh);
    }, 5000);
  }
  if (typeof requestAnimationFrame === 'function') {
    if (!worldMapFrame) worldMapFrame = requestAnimationFrame(worldMapAnimate);
    return;
  }
  // 无 requestAnimationFrame 的环境（离线测试桩）退回低频重绘。
  if (!worldMapTimer) worldMapTimer = setInterval(() => {
    if (worldMapVisible() && !document.hidden) drawWorldMap();
  }, 500);
}

function worldMapAnimate() {
  worldMapFrame = null;
  if (!worldMapVisible() || document.hidden) return;
  drawWorldMap();
  worldMapFrame = requestAnimationFrame(worldMapAnimate);
}

async function refreshWorldMapState(fresh = false) {
  const account = current;
  if (!account || account !== worldMapAccount) return;
  const version = worldMapVersion;
  try {
    const data = await call('/api/map/state' + (fresh ? '?fresh=1' : ''));
    if (version !== worldMapVersion || account !== current) return;
    worldMapLastFreshAt = fresh ? Date.now() : worldMapLastFreshAt;
    worldMapApplyState(data);
    if (data.scenarioId && worldMapLayout && Number(data.scenarioId) !== Number(worldMapLayout.scenarioId)) {
      await refreshWorldMap(true);
      return;
    }
    worldMapSetEmpty('');
    drawWorldMap();
  } catch (error) {
    worldMapSetStatus('地图状态读取失败：' + error.message);
  }
}

async function refreshWorldMap(force = false) {
  bindWorldMap();
  startWorldMapTimers();
  const account = current;
  if (!account) {
    worldMapSetEmpty('请先在顶部选择账号');
    worldMapSetStatus('');
    return;
  }
  if (account !== worldMapAccount) {
    worldMapAccount = account;
    worldMapLayout = null;
    worldMapLive = null;
    worldMapLastFreshAt = 0;
    worldMapWarChoices = new Map();
  }
  const version = ++worldMapVersion;
  worldMapLoading = true;
  worldMapSetEmpty('正在加载世界地图…');
  try {
    if (!worldMapLayout || force) {
      const layout = await call('/api/map/layout');
      if (version !== worldMapVersion || account !== current) return;
      applyWorldMapLayout(layout);
    }
    const fresh = force || Date.now() - worldMapLastFreshAt >= 30000;
    const data = await call('/api/map/state' + (fresh ? '?fresh=1' : ''));
    if (version !== worldMapVersion || account !== current) return;
    if (fresh) worldMapLastFreshAt = Date.now();
    worldMapApplyState(data);
    worldMapSetEmpty('');
    if (!worldMapView.userAdjusted) fitWorldMap();
    drawWorldMap();
  } catch (error) {
    worldMapSetEmpty('世界地图加载失败：' + error.message);
    worldMapSetStatus('加载失败');
  } finally {
    worldMapLoading = false;
  }
}

function worldMapHitAt(px, py) {
  if (!worldMapLayout) return null;
  const scale = worldMapView.scale;
  const gx = (px - worldMapView.tx) / scale;
  const gy = (py - worldMapView.ty) / scale;
  if (gx < 0 || gy < 0 || gx >= worldMapLayout.columns || gy >= worldMapLayout.rows) return null;

  const near = (point) => {
    const screen = worldMapScreen(point);
    return Math.hypot(screen.x - px, screen.y - py) <= 12;
  };
  if (worldMapLayerOn('myFleets')) {
    for (const fleet of worldMapLive?.fleets ?? []) {
      const head = worldMapHead(fleet.track);
      if (head && near(head)) return { kind: 'fleet', fleet };
    }
  }
  if (worldMapLayerOn('allyFleets') || worldMapLayerOn('enemyFleets')) {
    for (const fleet of worldMapLive?.worldFleets ?? []) {
      if (fleet.kind === 'ally' && !worldMapLayerOn('allyFleets')) continue;
      if (fleet.kind === 'enemy' && !worldMapLayerOn('enemyFleets')) continue;
      const head = worldMapHead(fleet.track);
      if (head && near(head)) return { kind: 'fleet', fleet };
    }
  }
  const cargo = worldMapLive?.trade?.cargo;
  if (worldMapLayerOn('trade') && cargo?.track && near(worldMapHead(cargo.track))) {
    return { kind: 'cargo', cargo, track: cargo.track, own: true };
  }
  if (worldMapLayerOn('allyTrade')) {
    const ownGuildIdx = Number(worldMapLive?.ownGuildIdx) || 0;
    for (const ship of worldMapLive?.trade?.worldCargo ?? []) {
      if (!ownGuildIdx || Number(ship.guildIdx) !== ownGuildIdx) continue;
      const head = worldMapHead(ship.track);
      if (head && near(head)) return { kind: 'cargo', cargo: ship, track: ship.track, own: false };
    }
  }
  if (worldMapLayerOn('objects')) {
    const merchantShip = worldMapLive?.merchantShip;
    if (merchantShip?.cell && near(merchantShip.cell)) {
      return { kind: 'object', object: { kind: 'merchantShip', point: merchantShip } };
    }
    for (const [kind, list] of Object.entries(worldMapLayout.objects ?? {})) {
      // 静态宝藏位只是货轮停靠点，悬停也不当作对象命中；
      // boss 候选位里只有今日 gridIdx 命中的那只在地图上存在。
      if (kind === 'treasure') continue;
      const points = Array.isArray(list) ? list : (list ? [list] : []);
      for (const point of points) {
        if (kind === 'boss' && Number(point?.gridIdx) !== Number(worldMapLive?.worldBoss?.gridIdx)) continue;
        if (point?.cell && near(point.cell)) return { kind: 'object', object: { kind, point } };
      }
    }
  }
  const city = worldMapCityAtCell({ x: gx, y: gy });
  if (city) return { kind: 'city', city };
  return null;
}

function bindWorldMap() {
  const canvas = $('map-canvas');
  if (!canvas || canvas.dataset.worldMapBound === '1') return;
  canvas.dataset.worldMapBound = '1';

  for (const input of document.querySelectorAll('[data-map-layer]')) {
    worldMapLayers[input.dataset.mapLayer] = input.checked !== false;
    input.onchange = () => {
      worldMapLayers[input.dataset.mapLayer] = input.checked;
      worldMapStatic = { key: '', canvas: null };
      drawWorldMap();
    };
  }

  const refresh = $('map-refresh');
  if (refresh) refresh.onclick = () => { void refreshWorldMap(true); };
  const fit = $('map-fit');
  if (fit) fit.onclick = () => { fitWorldMap(); worldMapStatic = { key: '', canvas: null }; drawWorldMap(); };
  const focus = $('map-focus');
  if (focus) focus.onclick = () => { focusWorldMapFleets(); worldMapStatic = { key: '', canvas: null }; drawWorldMap(); };
  const warSave = $('map-war-save');
  if (warSave) warSave.onclick = () => { void saveWorldMapWarSettings(); };

  canvas.addEventListener('wheel', (event) => {
    if (!worldMapLayout) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const before = { x: (mx - worldMapView.tx) / worldMapView.scale, y: (my - worldMapView.ty) / worldMapView.scale };
    const scale = Math.min(160, Math.max(8, worldMapView.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    worldMapView = {
      ...worldMapView, scale, userAdjusted: true,
      tx: mx - before.x * scale,
      ty: my - before.y * scale,
    };
    worldMapStatic = { key: '', canvas: null };
    drawWorldMap();
  }, { passive: false });

  canvas.addEventListener('mousedown', (event) => {
    worldMapDragMoved = false;
    worldMapDrag = { x: event.clientX, y: event.clientY, tx: worldMapView.tx, ty: worldMapView.ty };
  });
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    if (worldMapDrag) {
      const dx = event.clientX - worldMapDrag.x;
      const dy = event.clientY - worldMapDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) worldMapDragMoved = true;
      worldMapView = { ...worldMapView, tx: worldMapDrag.tx + dx, ty: worldMapDrag.ty + dy, userAdjusted: true };
      worldMapStatic = { key: '', canvas: null };
      drawWorldMap();
      return;
    }
    worldMapHover = worldMapHitAt(mx, my);
    positionWorldMapTooltip(mx, my);
    drawWorldMap();
  });
  const endDrag = () => { worldMapDrag = null; };
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', () => {
    endDrag();
    worldMapHover = null;
    positionWorldMapTooltip(0, 0);
    drawWorldMap();
  });
  canvas.addEventListener('click', () => {
    if (worldMapDragMoved) return;
    worldMapSelected = worldMapHover;
    renderWorldMapDetail(worldMapSelected);
    drawWorldMap();
  });

  window.addEventListener('resize', () => {
    if (!worldMapVisible()) return;
    if (!worldMapView.userAdjusted) fitWorldMap();
    worldMapStatic = { key: '', canvas: null };
    drawWorldMap();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && worldMapVisible()) startWorldMapTimers();
  });
}

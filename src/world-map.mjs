// 世界地图数据层：把静态地图包、世界归属和舰队/商船状态压成前端可直接绘制的结构。
//
// 数据边界（见 docs/gameplay.md 3.7 / 12.4）：
// - 地图包只记录“哪些格是资源田、属于哪座城”，没有逐格归属；海面空格保持中性。
// - 城市归属来自 WorldInfoResponse.cities[].guildIdx（或 SCity 推送）；我方城市只按
//   GuildCityInfoResponse.cities[].cityId 判定，不猜 guildIdx 与联盟 ID 的映射。
// - 舰队和商船只有起终点与时间戳，没有寻路数据，所以航线是直线示意。
//
// 本文件不读磁盘、不依赖 server.mjs，全部函数可以直接单测。

import { normalize } from './worlds.mjs';

export const WORLD_MAP_POLL_MS = 5000;
export const WORLD_MAP_FRESH_MS = 30000;
export const WORLD_INFO_TIMEOUT_MS = 8000;
export const WORLD_CARGO_LIMIT = 300;
// 万吨货轮在 TreasureLootListResponse.treasure 里的固定色号；位置只有列表回包的 gridIdx 有。
export const MERCHANT_SHIP_COLOR = 5;
export const NEUTRAL_COLOR = '#6b7f86';
// 势力回退配色（黄/棕/青/紫，按 guildIdx 1-4 顺序取用）。实际配色优先读
// WorldInitialForceCfg.forceColor（见 forceInfoMap），本表只在配置缺失或编号超出势力表时兜底；
// 超出四个编号的势力按金色角生成，保证不与回退色重复。
export const GUILD_PALETTE = ['#aa943c', '#885755', '#5d8b96', '#936bb2'];

const FLEET_STATE_TEXT = { 1: '闲置', 2: '移动中', 3: '战斗中', 4: '维修中', 5: '排队中' };

function rows(config, name) {
  const data = config?.tables?.[name]?.data;
  return Array.isArray(data) ? data : [];
}

// 协议里的 int64 在本项目里是 { low, high }，也可能是普通数字或字符串。
function numberOf(value) {
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return (value.low >>> 0) + (value.high >>> 0) * 4294967296;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value) {
  const number = numberOf(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function gridPoint(gridIdx, width) {
  const idx = numberOf(gridIdx);
  const columns = numberOf(width);
  if (!Number.isSafeInteger(idx) || idx < 0 || !Number.isSafeInteger(columns) || columns <= 0) return null;
  return { x: idx % columns, y: Math.floor(idx / columns) };
}

// 势力颜色按 guildIdx 稳定分配：1-4 用官方地图四色，更多势力按金色角生成；
// 0 和未知值没有颜色，由调用方使用中立灰。
export function guildColor(guildIdx) {
  const index = numberOf(guildIdx);
  if (!Number.isSafeInteger(index) || index <= 0) return null;
  return GUILD_PALETTE[index - 1] ?? `hsl(${Math.round((index * 137.508) % 360)}, 58%, 52%)`;
}

/**
 * 读取世界初始势力表（X_WorldInitialForceCfg，按赛季分表）：
 * 势力编号 → 名称与官方区域色。聊天消息里的联盟编号翻译和地图配色都以这张表为准；
 * 换赛季名称和色号会整体变化，不能依赖硬编码。
 *
 * @param {object|null} config 游戏配置表。
 * @param {number} scenarioId 场景编号。
 * @returns {Record<number, {name: string, color: string|null}>} 势力对照。
 */
export function forceInfoMap(config, scenarioId = 1) {
  const info = {};
  for (const table of [`${positiveInteger(scenarioId) || 1}_WorldInitialForceCfg`, 'WorldInitialForceCfg']) {
    for (const row of rows(config, table)) {
      const id = numberOf(row.id);
      const name = String(row.name ?? '').trim();
      if (id <= 0 || !name) continue;
      const color = String(row.forceColor ?? '').trim().replace(/^#/, '');
      info[id] = { name, color: color ? `#${color}` : null };
    }
    if (Object.keys(info).length) break;
  }
  return info;
}

function firstRow(config, names, match) {
  for (const name of names) {
    const found = rows(config, name).find(match);
    if (found) return found;
  }
  return null;
}

function resTypeName(config, scenarioId, resType) {
  const names = [`${scenarioId}_ResFieldTypeCfg`, 'ResFieldTypeCfg'];
  const match = (row) => numberOf(row.type) === numberOf(resType);
  const levels = [];
  for (const name of names) for (const row of rows(config, name)) if (match(row)) levels.push(row);
  const row = levels.sort((a, b) => numberOf(a.level) - numberOf(b.level))[0];
  const product = Array.isArray(row?.product) ? row.product[0] : null;
  return product || { 1: '公会科技点', 2: '种子', 3: '汽油' }[numberOf(resType)] || `资源 ${numberOf(resType)}`;
}

function pointList(gridIndices, width, positions = [], toCell = null) {
  const out = [];
  for (const gridIdx of gridIndices ?? []) {
    const point = gridPoint(gridIdx, width);
    if (point) out.push({
      gridIdx: numberOf(gridIdx),
      ...point,
      cityId: nearestCityId(positions, point),
      cell: toCell ? toCell(point) : null,
    });
  }
  return out;
}

// 城池在真实地图上按固定间距排成粗网格：普通城占一格，中心落在格子中心；
// 大城（如 2×2 的山景城）中心落在两格交界处，占四格。这里从真实坐标还原网格，
// 而不是按顺序把城平铺成正方形，否则大城会挤掉别的城的格子，相邻关系也会错位。
function axisGrid(values) {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (!unique.length) return { origin: 0, spacing: 1 };
  if (unique.length === 1) return { origin: unique[0] - 0.5, spacing: 1 };
  const gaps = new Map();
  for (let i = 1; i < unique.length; i += 1) {
    const gap = unique[i] - unique[i - 1];
    if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  // 大城与相邻城的坐标差是半个格宽，取出现次数最多的间距作为格宽。
  const spacing = [...gaps.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  // 单格城的中心在 origin + (n + 0.5) * spacing；减半格后对间距取模、投票选左/上边界。
  const votes = new Map();
  for (const value of unique) {
    const offset = ((value - spacing / 2) % spacing + spacing) % spacing;
    const key = Math.round(offset * 1000) / 1000;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const origin = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  return { origin, spacing };
}

// 坐标吸附到最近的半格：整数表示中心落在两格交界，占两格；半格表示单格中心。
function cellSpan(value, axis) {
  const half = Math.round(((value - axis.origin) / axis.spacing) * 2) / 2;
  if (Math.abs(half - Math.round(half)) < 0.25) {
    return { start: Math.max(0, Math.round(half) - 1), span: 2 };
  }
  return { start: Math.max(0, Math.floor(half)), span: 1 };
}

/**
 * 按真实地图坐标还原城池粗网格。普通城占一格，大城占多格（目前见到的都是 2×2）。
 *
 * @param {object} map loadMapAsset 返回值。
 * @returns {{columns:number, rows:number, cells:Map<number,{col:number,row:number,colSpan:number,rowSpan:number,index:number}>, positions:Array<{id:number,x:number,y:number}>}} 城市格布局。
 */
export function cityCellLayout(map) {
  const width = numberOf(map?.width);
  const entries = [];
  for (const [idText, info] of Object.entries(map?.cityInfo ?? {})) {
    const id = numberOf(idText);
    const point = gridPoint(info?.gridIdx, width);
    if (id > 0 && point) entries.push({ id, x: point.x, y: point.y });
  }
  if (!entries.length) return { columns: 1, rows: 1, cells: new Map(), positions: [] };

  const columnsAxis = axisGrid(entries.map((city) => city.x));
  const rowsAxis = axisGrid(entries.map((city) => city.y));
  const placed = entries.map((city) => {
    const col = cellSpan(city.x, columnsAxis);
    const row = cellSpan(city.y, rowsAxis);
    return { ...city, col: col.start, row: row.start, colSpan: col.span, rowSpan: row.span };
  });
  placed.sort((a, b) => a.row - b.row || a.col - b.col || a.id - b.id);

  const columns = Math.max(1, ...placed.map((city) => city.col + city.colSpan));
  const rows = Math.max(1, ...placed.map((city) => city.row + city.rowSpan));
  const cells = new Map();
  placed.forEach((city, index) => cells.set(city.id, {
    col: city.col,
    row: city.row,
    colSpan: city.colSpan,
    rowSpan: city.rowSpan,
    index,
  }));
  const positions = entries.map((city) => ({ id: city.id, x: city.x, y: city.y }));
  return { columns, rows, cells, positions };
}

function cellCenter(cell) {
  return cell
    ? { x: cell.col + (cell.colSpan ?? 1) / 2, y: cell.row + (cell.rowSpan ?? 1) / 2 }
    : null;
}

function nearestCityId(positions, point) {
  if (!point) return 0;
  let best = 0;
  let distance = Infinity;
  for (const city of positions ?? []) {
    const next = (city.x - point.x) ** 2 + (city.y - point.y) ** 2;
    if (next < distance) { distance = next; best = city.id; }
  }
  return best;
}

/**
 * 从配置表建立城市编号到名称的映射，供城战目标列表使用。
 *
 * @param {object|null} config 游戏配置表。
 * @param {number} scenarioId 场景编号。
 * @returns {Map<number,string>} 城市名称。
 */
export function cityNameMap(config, scenarioId = 1) {
  const names = new Map();
  for (const table of [`${positiveInteger(scenarioId) || 1}_CityCfg`, 'CityCfg']) {
    for (const row of rows(config, table)) names.set(numberOf(row.id), row.name);
    if (names.size) break;
  }
  return names;
}

/**
 * 整理城战目标：只列当前宣战状态里可进攻的城，以及本盟可防守的城，不把所有城市倒出来。
 *
 * @param {object} options 城战原始状态与当前归属。
 * @returns {object} 城战状态、可进攻/可防守目标。
 */
export function buildCityWarView({
  war = null, ownCityIds = [], ownGuildIdx = 0, guildCities = null,
  cityNames = null, now = Date.now() / 1000,
} = {}) {
  const current = numberOf(now) || Date.now() / 1000;
  const startTime = numberOf(war?.startTime);
  const endTime = numberOf(war?.endTime);
  const assembleCityId = numberOf(war?.assembleCityId);
  const active = startTime > 0 && endTime > 0 && startTime <= current && current < endTime;
  const nameOf = (cityId) => cityNames?.get(numberOf(cityId)) ?? `城 #${cityId}`;
  const declarations = (war?.declarations ?? [])
    .map((row) => ({
      cityId: numberOf(row.cityId),
      attackGuildIdx: numberOf(row.attackGuildIdx),
      defenceGuildIdx: numberOf(row.defenceGuildIdx),
    }))
    .filter((row) => row.cityId > 0);

  const attack = new Map();
  if (ownGuildIdx > 0) {
    for (const row of declarations) {
      if (row.attackGuildIdx !== ownGuildIdx) continue;
      attack.set(row.cityId, {
        cityId: row.cityId,
        name: nameOf(row.cityId),
        assemble: row.cityId === assembleCityId,
      });
    }
  }

  const ownDetails = new Map((guildCities?.cities ?? []).map((city) => [numberOf(city.cityId), city]));
  const defend = new Map();
  const addDefend = (cityId, underAttack) => {
    if (!(cityId > 0) || defend.has(cityId)) return;
    const detail = ownDetails.get(cityId);
    defend.set(cityId, {
      cityId,
      name: nameOf(cityId),
      recommended: detail?.recommended === true,
      defenceNum: numberOf(detail?.defenceNum),
      underAttack,
      assemble: cityId === assembleCityId,
    });
  };
  for (const cityId of ownCityIds ?? []) {
    addDefend(numberOf(cityId), declarations.some((row) => row.cityId === numberOf(cityId) && row.defenceGuildIdx === ownGuildIdx));
  }
  for (const row of declarations) {
    if (ownGuildIdx > 0 && row.defenceGuildIdx === ownGuildIdx) addDefend(row.cityId, true);
  }

  return {
    active,
    startTime,
    endTime,
    assembleCityId,
    ownGuildIdx,
    declarations,
    attackTargets: [...attack.values()].sort((a, b) => a.cityId - b.cityId),
    defendTargets: [...defend.values()].sort((a, b) => Number(b.underAttack) - Number(a.underAttack)
      || Number(b.assemble) - Number(a.assemble)
      || Number(b.recommended) - Number(a.recommended)
      || a.cityId - b.cityId),
  };
}

/**
 * 把 loadMapAsset() 的结果压成前端一次性使用的静态布局。
 *
 * @param {object} map loadMapAsset 返回值，需包含 width/height/mapData/cityInfo 与新暴露的点位。
 * @param {object|null} config 游戏配置表；缺失时使用 `城 #id` 之类的兜底名称。
 * @param {number} scenarioId 场景编号，1 为世界地图，2 为黑潮侵袭。
 * @returns {object} 前端绘制所需的城市、资源田和固定点位。
 */
export function buildMapLayout(map, config, scenarioId = 1) {
  if (!map || !Array.isArray(map.mapData)) throw new Error('地图格子数据不可用');
  const scenario = positiveInteger(scenarioId) || 1;
  const width = positiveInteger(map.width) || 0;
  const height = positiveInteger(map.height) || 0;
  const cityRows = rows(config, `${scenario}_CityCfg`);
  const fallbackRows = cityRows.length ? cityRows : rows(config, 'CityCfg');
  const cityById = new Map(fallbackRows.map((row) => [numberOf(row.id), row]));
  const typeNames = new Map(rows(config, 'CityTypeCfg').map((row) => [numberOf(row.id), row.name]));
  const cellLayout = cityCellLayout(map);
  // 世界对象（货轮/宝藏/Boss/硅矿/沉船）不在城池网格里，按真实点位换算成连续格坐标，
  // 地图才能画在真实位置；宽度或行数缺失时保留 null，前端跳过绘制。
  const tileToCell = width > 0 && height > 0
    ? (point) => ({ x: (point.x * cellLayout.columns) / width, y: (point.y * cellLayout.rows) / height })
    : null;

  const cities = [];
  for (const [idText, info] of Object.entries(map.cityInfo ?? {})) {
    const id = numberOf(idText);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const point = gridPoint(info?.gridIdx, width);
    if (!point) continue;
    const row = cityById.get(id) ?? null;
    const type = numberOf(row?.type);
    const cell = cellLayout.cells.get(id) ?? null;
    cities.push({
      id,
      gridIdx: numberOf(info.gridIdx),
      x: point.x,
      y: point.y,
      col: cell?.col ?? null,
      row: cell?.row ?? null,
      colSpan: cell?.colSpan ?? 1,
      rowSpan: cell?.rowSpan ?? 1,
      name: row?.name || `城 #${id}`,
      level: numberOf(row?.level),
      type,
      typeName: typeNames.get(type) ?? null,
      fieldCount: Array.isArray(info?.res) ? info.res.length : 0,
      fort: Number.isSafeInteger(info?.fort) ? info.fort : null,
    });
  }
  cities.sort((a, b) => a.id - b.id);
  const cityLevel = new Map(cities.map((city) => [city.id, city.level]));

  const fields = [];
  for (let gridIdx = 0; gridIdx < map.mapData.length; gridIdx += 1) {
    const value = numberOf(map.mapData[gridIdx]);
    const resType = Math.floor(value / 10000) % 10;
    if (!resType) continue;
    const point = gridPoint(gridIdx, width);
    if (!point) continue;
    const cityId = value % 1000;
    fields.push({
      gridIdx,
      x: point.x,
      y: point.y,
      resType,
      cityId,
      resName: resTypeName(config, scenario, resType),
      level: cityLevel.get(cityId) ?? 0,
    });
  }

  return {
    scenarioId: scenario,
    width,
    height,
    tileWidth: numberOf(map.tileWidth) || 0,
    tileHeight: numberOf(map.tileHeight) || 0,
    columns: cellLayout.columns,
    rows: cellLayout.rows,
    cities,
    fields,
    objects: {
      // key 统一用单数（boss/treasure/chipMine），与前端 worldMapObjectColors/Labels 一致；
      // 复数 key（bosses/treasures/chipMines）会让前端标签回退成英文 key 名画上地图。
      boss: pointList(map.bosses, width, cellLayout.positions, tileToCell),
      treasure: pointList(map.treasures, width, cellLayout.positions, tileToCell),
      limitedBoss: pointList(map.limitedBoss, width, cellLayout.positions, tileToCell),
      chipMine: pointList(map.chipMines, width, cellLayout.positions, tileToCell),
      wreck: pointList([map.wreckPos], width, cellLayout.positions, tileToCell)[0] ?? null,
    },
    source: map.file ? String(map.file).split(/[\\/]/).pop() : null,
  };
}

// WorldInfoRequest 的 screenCenter 是必填字段。协议没有说明坐标系，先按地图像素中心发送；
// 该值集中在这里，实测需要调整时只改这一处。
export function worldInfoBody(map) {
  const width = numberOf(map?.width) || 240;
  const height = numberOf(map?.height) || 640;
  const tileWidth = numberOf(map?.tileWidth) || 100;
  const tileHeight = numberOf(map?.tileHeight) || 75;
  return { screenCenter: { x: Math.round((width * tileWidth) / 2), y: Math.round((height * tileHeight) / 2) } };
}

function stationary(point, start = 0, end = 0) {
  return { from: point, to: point, head: { ...point }, start, end, eta: 0, moving: false };
}

/**
 * 在起点和终点之间按时间线性插值。没有有效时间段时退化为静止点。
 *
 * @param {{x:number,y:number}} from 起点格坐标。
 * @param {{x:number,y:number}} to 终点格坐标。
 * @param {number} start 开始时间（秒）。
 * @param {number} end 结束时间（秒）。
 * @param {number} now 当前服务器时间（秒）。
 * @returns {object} 含 from/to/head/start/end/eta/moving 的航线。
 */
export function interpolateTrack(from, to, start, end, now) {
  const begin = numberOf(start);
  const finish = numberOf(end);
  const current = numberOf(now);
  if (!(finish > begin)) return stationary(from, begin, 0);
  const progress = Math.min(1, Math.max(0, (current - begin) / (finish - begin)));
  const head = {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
  return {
    from, to, head, start: begin, end: finish,
    eta: Math.max(0, Math.round(finish - current)),
    moving: progress < 1,
  };
}

/**
 * 舰队航线：在地图格上找起点城和终点城，再按时间插值。
 * 目标不是城（资源田/海盗/首领）时，取目标格最近的城作为示意终点。
 *
 * @param {object} fleet MyFleetsResponse.fleets 的元素。
 * @param {object} layout cityCellLayout 结果，需带 width。
 * @param {number} now 服务器时间（秒）。
 * @returns {object|null} 格坐标航线；没有可用城市时返回 null。
 */
export function trackForFleet(fleet, layout, now = Date.now() / 1000) {
  const cells = layout?.cells;
  if (!cells) return null;
  const width = numberOf(layout.width);
  const positions = layout.positions ?? [];
  const state = numberOf(fleet?.state);
  const moving = state === 2 && numberOf(fleet?.moveEndTs) > numberOf(fleet?.moveStartTs);
  const cityId = numberOf(fleet?.cityId);
  const targetCityId = numberOf(fleet?.targetCityId);
  const nearestFor = (gridIdx) => {
    const index = positiveInteger(gridIdx);
    return index ? nearestCityId(positions, gridPoint(index, width)) : 0;
  };
  const originId = (cells.has(cityId) ? cityId : 0)
    || nearestFor(moving ? fleet?.startGridIdx : fleet?.curGridIdx)
    || nearestFor(fleet?.curGridIdx)
    || nearestFor(fleet?.startGridIdx);
  const from = cellCenter(cells.get(originId));
  // 目标是城时停靠城池格中心；是宝藏/货轮/Boss/资源田等非城格时，
  // 航线指向真实格点换算出的格坐标，不能吸到最近的城，否则看起来像去攻城。
  let to = cells.has(targetCityId) ? cellCenter(cells.get(targetCityId)) : null;
  if (!to) {
    const columns = numberOf(layout.columns);
    const rowLines = numberOf(layout.rows);
    const height = numberOf(layout.height);
    const tile = gridPoint(fleet?.targetGridIdx, width);
    if (tile && columns > 0 && rowLines > 0 && width > 0 && height > 0) {
      to = { x: (tile.x * columns) / width, y: (tile.y * rowLines) / height };
    } else {
      to = cellCenter(cells.get(nearestFor(fleet?.targetGridIdx)));
    }
  }
  if (!from) return null;
  if (!moving || !to) return stationary(from);
  return interpolateTrack(from, to, numberOf(fleet.moveStartTs), numberOf(fleet.moveEndTs), now);
}

/**
 * 商船航线：城市编号直接映射到城池格。
 *
 * @param {object} cargo TradeInfoResponse.cargo 的元素。
 * @param {object} layout cityCellLayout 结果。
 * @param {number} now 服务器时间（秒）。
 * @returns {object|null} 格坐标航线；缺少当前城市时返回 null。
 */
export function trackForTrade(cargo, layout, now = Date.now() / 1000) {
  const cells = layout?.cells;
  const from = cellCenter(cells?.get(numberOf(cargo?.cityId)));
  if (!from) return null;
  const to = cellCenter(cells?.get(numberOf(cargo?.moveToCityId)));
  const start = numberOf(cargo?.moveStartTime);
  const end = numberOf(cargo?.moveEndTime);
  if (!to || !(end > start)) return stationary(from, start, end);
  return interpolateTrack(from, to, start, end, now);
}


/**
 * 合并静态地图与实时状态，生成前端绘制用的地图状态。
 *
 * @param {object} options 状态来源。
 * @param {object|null} options.map loadMapAsset 返回值。
 * @param {object[]|null} options.cities WorldCity 数组（WorldInfoResponse 或 SCity 推送）。
 * @param {object[]|null} options.fleets WorldFleet 数组。
 * @param {object|null} options.trade TradeInfoResponse。
 * @param {number[]|null} options.ownCityIds 本盟城市编号（GuildCityInfoResponse）。
 * @param {number} options.now 服务器时间（秒）。
 * @param {string[]} options.warnings 读取失败等提示，原样带到前端。
 * @returns {object} 城市归属、图例、舰队与商船轨迹。
 */
export function buildWorldMapState({
  map = null, cities = null, fleets = null, trade = null, ownCityIds = null,
  player = null, worldFleets = null, war = null, guildCities = null, cityNames = null,
  forceInfo = null, treasureLoot = null, worldBoss = null, cityBattles = null,
  now = Date.now() / 1000, warnings = [],
} = {}) {
  const cellLayout = cityCellLayout(map);
  cellLayout.width = numberOf(map?.width);
  cellLayout.height = numberOf(map?.height);
  const current = numberOf(now) || Date.now() / 1000;

  // 城战宣战先于城市行生成：受袭/进攻标记需要本盟序号，而本盟序号又来自归属行，
  // 所以先用 cities 粗算 ownGuildIdx，再回头补标记。
  const preliminaryOwn = new Set((ownCityIds ?? guildCities?.cities?.map((city) => city?.cityId) ?? [])
    .map(numberOf).filter((id) => id > 0));
  let ownGuildIdxEarly = 0;
  for (const city of cities ?? []) {
    const id = numberOf(city?.id);
    if (!preliminaryOwn.has(id)) continue;
    const guildIdx = numberOf(city?.guildIdx);
    if (!(guildIdx > 0)) continue;
    if (!ownGuildIdxEarly) ownGuildIdxEarly = guildIdx;
    else if (ownGuildIdxEarly !== guildIdx) { ownGuildIdxEarly = -1; break; }
  }
  if (ownGuildIdxEarly < 0) ownGuildIdxEarly = 0;
  const attackCityIds = new Set((war?.declarations ?? [])
    .filter((row) => ownGuildIdxEarly > 0 && numberOf(row.attackGuildIdx) === ownGuildIdxEarly)
    .map((row) => numberOf(row.cityId)));
  const defenceCityIds = new Set((war?.declarations ?? [])
    .filter((row) => ownGuildIdxEarly > 0 && numberOf(row.defenceGuildIdx) === ownGuildIdxEarly)
    .map((row) => numberOf(row.cityId)));

  const ownership = new Map();
  const cityRows = [];
  for (const city of cities ?? []) {
    const id = numberOf(city?.id);
    if (!(id > 0)) continue;
    const guildIdx = numberOf(city?.guildIdx);
    ownership.set(id, guildIdx);
    cityRows.push({
      id,
      state: numberOf(city?.state),
      guildIdx,
      battle: numberOf(city?.state) === 2,
      defenceFleetNum: numberOf(city?.defenceFleetNum),
      attackFleetNum: numberOf(city?.attackFleetNum),
      priorityDefFleetNum: numberOf(city?.priorityDefFleetNum),
      priorityAtkFleetNum: numberOf(city?.priorityAtkFleetNum),
      attackTarget: attackCityIds.has(id),
      underAttack: defenceCityIds.has(id),
      battlePoints: cityBattles?.get(id) ?? [],
    });
  }

  const ownSet = new Set((ownCityIds ?? guildCities?.cities?.map((city) => city?.cityId) ?? [])
    .map(numberOf).filter((id) => id > 0));
  // 本盟序号在城战标记阶段已按同一规则推出，这里直接复用，避免两处判定漂移。
  const ownGuildIdx = ownGuildIdxEarly;

  const byGuild = new Map();
  for (const city of cityRows) {
    city.own = ownSet.has(city.id) || (ownGuildIdx > 0 && city.guildIdx === ownGuildIdx);
    const bucket = byGuild.get(city.guildIdx) ?? { guildIdx: city.guildIdx, cities: 0, own: false };
    bucket.cities += 1;
    bucket.own ||= city.own;
    byGuild.set(city.guildIdx, bucket);
  }

  const legend = [...byGuild.values()]
    .map((entry) => ({
      ...entry,
      neutral: entry.guildIdx === 0,
      // 势力色优先取 WorldInitialForceCfg 的官方区域色，配置缺失才用回退调色板。
      color: entry.guildIdx === 0
        ? NEUTRAL_COLOR
        : (forceInfo?.[entry.guildIdx]?.color ?? guildColor(entry.guildIdx)),
      factionName: forceInfo?.[entry.guildIdx]?.name ?? null,
    }))
    .sort((a, b) => Number(b.own) - Number(a.own) || Number(a.neutral) - Number(b.neutral) || b.cities - a.cities);

  const fleetRows = [];
  for (const fleet of fleets ?? []) {
    const track = trackForFleet(fleet, cellLayout, current);
    if (!track) continue;
    fleetRows.push({
      buildingId: String(fleet?.buildingId ?? ''),
      state: numberOf(fleet?.state),
      stateText: FLEET_STATE_TEXT[numberOf(fleet?.state)] ?? `状态 ${numberOf(fleet?.state)}`,
      durability: numberOf(fleet?.durability),
      maxDura: numberOf(fleet?.maxDura),
      power: numberOf(fleet?.power),
      cityId: numberOf(fleet?.cityId),
      targetCityId: numberOf(fleet?.targetCityId),
      targetGridIdx: numberOf(fleet?.targetGridIdx),
      // 维修结束时间（服务器秒），前端用来显示维修倒计时；不在维修时为 0。
      repairEndTs: numberOf(fleet?.repairing?.endTs),
      track,
    });
  }

  const period = numberOf(trade?.period);
  const ownCargo = trade?.cargo ? trackForTrade(trade.cargo, cellLayout, current) : null;
  const tradeView = {
    open: period > 0,
    period,
    cargo: trade?.cargo ? {
      cityId: numberOf(trade.cargo.cityId),
      moveToCityId: numberOf(trade.cargo.moveToCityId),
      cargoLv: numberOf(trade.cargo.cargoLv),
      track: ownCargo,
    } : null,
    worldCargo: (trade?.worldCargo ?? []).slice(0, WORLD_CARGO_LIMIT).map((entry) => ({
      playerId: String(entry?.playerId ?? ''),
      nickname: entry?.nickname ?? '',
      guildIdx: numberOf(entry?.guildIdx),
      title: numberOf(entry?.title),
      cityId: numberOf(entry?.cargo?.cityId),
      moveToCityId: numberOf(entry?.cargo?.moveToCityId),
      track: entry?.cargo ? trackForTrade(entry.cargo, cellLayout, current) : null,
    })).filter((entry) => entry.track),
  };

  const cityWar = buildCityWarView({
    war, ownCityIds: [...ownSet], ownGuildIdx, guildCities, cityNames, now: current,
  });

  // 万吨货轮（color 5）是动态事件，位置只在列表回包的 gridIdx 里；静态 treasureData
  // 宝藏位全部不显示，只标当前货轮这一格。没有进行中的货轮时为 null。
  const shipEntry = (treasureLoot?.treasure ?? []).find((row) => numberOf(row?.color) === MERCHANT_SHIP_COLOR);
  const shipGridIdx = positiveInteger(shipEntry?.gridIdx);
  const shipTile = shipGridIdx ? gridPoint(shipGridIdx, numberOf(map?.width)) : null;
  const merchantShip = shipTile && cellLayout.columns > 0 && cellLayout.rows > 0
    ? {
        uid: numberOf(shipEntry.uid),
        gridIdx: shipGridIdx,
        x: shipTile.x,
        y: shipTile.y,
        cell: {
          x: (shipTile.x * cellLayout.columns) / numberOf(map?.width),
          y: (shipTile.y * cellLayout.rows) / numberOf(map?.height),
        },
        ownerGuildIdx: numberOf(shipEntry.ownerGuildIdx),
        ownerFleetNum: numberOf(shipEntry.ownerFleetNum),
        progress: numberOf(shipEntry.progress),
      }
    : null;

  const ownPlayerId = numberOf(player?.playerId);
  const ownGuildId = numberOf(player?.guildId);
  const ownBuildingIds = new Set(fleetRows.map((fleet) => fleet.buildingId));
  const worldFleetRows = [];
  for (const fleet of worldFleets ?? []) {
    const owner = fleet?.owner ?? {};
    const playerId = numberOf(owner.playerId);
    const guildId = numberOf(owner.guildId);
    if ((ownPlayerId && playerId === ownPlayerId) || ownBuildingIds.has(String(fleet?.buildingId ?? ''))) continue;
    if (!(playerId > 0) && !(guildId > 0)) continue;
    const track = trackForFleet(fleet, cellLayout, current);
    if (!track) continue;
    worldFleetRows.push({
      buildingId: String(fleet?.buildingId ?? ''),
      kind: ownGuildId > 0 && guildId === ownGuildId ? 'ally' : 'enemy',
      owner: {
        playerId: String(owner.playerId ?? ''),
        nickname: owner.nickname ?? '',
        guildId: String(owner.guildId ?? ''),
        title: numberOf(owner.title),
      },
      state: numberOf(fleet?.state),
      stateText: FLEET_STATE_TEXT[numberOf(fleet?.state)] ?? `状态 ${numberOf(fleet?.state)}`,
      durability: numberOf(fleet?.durability),
      maxDura: numberOf(fleet?.maxDura),
      cityId: numberOf(fleet?.cityId),
      targetCityId: numberOf(fleet?.targetCityId),
      track,
    });
    if (worldFleetRows.length >= 200) break;
  }

  return {
    serverNow: current,
    cities: cityRows,
    ownCityIds: [...ownSet],
    ownGuildIdx,
    legend,
    fleets: fleetRows,
    worldFleets: worldFleetRows,
    war: cityWar,
    trade: tradeView,
    merchantShip,
    // 今日世界 Boss（gridIdx 为 0/缺失时表示当前没有可显示的 Boss）。
    worldBoss: numberOf(worldBoss?.gridIdx) > 0
      ? { bossId: numberOf(worldBoss.bossId), gridIdx: numberOf(worldBoss.gridIdx) }
      : null,
    summary: {
      ownCities: cityRows.filter((city) => city.own).length,
      enemyCities: cityRows.filter((city) => city.guildIdx > 0 && !city.own).length,
      neutralCities: cityRows.filter((city) => city.guildIdx === 0).length,
      fleetsMoving: fleetRows.filter((fleet) => fleet.state === 2).length,
    },
    warnings: [...warnings],
  };
}

/**
 * 总览「世界态势」卡片使用的精简摘要，只依赖总览缓存里的数据。
 *
 * @param {object} options 总览数据。
 * @param {object[]} options.fleets 舰队列表。
 * @param {object|null} options.trade TradeInfoResponse。
 * @param {object|null} options.resFields 已占资源田信息。
 * @param {number} options.now 服务器时间（秒）。
 * @returns {object} 卡片文本所需的计数与航线。
 */
export function summarizeOverviewWorldMap({ fleets = [], trade = null, resFields = null, now = Date.now() / 1000 } = {}) {
  const cargo = trade?.cargo ?? null;
  const open = numberOf(trade?.period) > 0;
  const end = numberOf(cargo?.moveEndTime);
  return {
    fleetCount: fleets.length,
    movingFleets: fleets.filter((fleet) => numberOf(fleet?.state) === 2).length,
    tradeOpen: open,
    tradeRoute: open && numberOf(cargo?.cityId) > 0 ? {
      cityId: numberOf(cargo.cityId),
      moveToCityId: numberOf(cargo.moveToCityId),
      eta: end > now ? Math.round(end - now) : 0,
    } : null,
    fieldsOwned: Array.isArray(resFields?.fields) ? resFields.fields.length : 0,
    fieldsMax: numberOf(resFields?.maxNum) || null,
  };
}

/**
 * 只读读取世界信息、舰队、商船与本盟城市。任何一项失败都只记警告，不中断其他数据。
 *
 * @param {object} client GameClient 或测试替身。
 * @param {object} protocol 协议表。
 * @param {object} options 当前角色与地图。
 * @returns {Promise<object>} 原始响应与 warnings。
 */
export async function readWorldMapState(client, protocol, { player = null, map = null, timeout = WORLD_INFO_TIMEOUT_MS } = {}) {
  const warnings = [];
  const read = async (name, body, response) => {
    if (!protocol?.[name] || !protocol?.[response]) {
      warnings.push(`协议缺少 ${name}/${response}`);
      return null;
    }
    try {
      return normalize(await client.request(name, body, response, timeout));
    } catch (error) {
      warnings.push(`${name} 读取失败：${error.message}`);
      return null;
    }
  };

  const fleets = await read('MyFleetsRequest', {}, 'MyFleetsResponse');
  const worldInfo = await read('WorldInfoRequest', worldInfoBody(map), 'WorldInfoResponse');
  const trade = await read('TradeInfoRequest', {}, 'TradeInfoResponse');
  const war = await read('WarDeclarationRequest', {}, 'WarDeclarationResponse');
  const treasureLoot = await read('TreasureLootListRequest', {}, 'TreasureLootListResponse');
  // 今日世界 Boss：info.gridIdx 是它真实所在格，地图只显示这一只。
  const worldBoss = await read('WorldBossInfoRequest', {}, 'WorldBossInfoResponse');
  const guildCities = numberOf(player?.guildId) > 0
    ? await read('GuildCityInfoRequest', {}, 'GuildCityInfoResponse')
    : null;

  return {
    fleets: Array.isArray(fleets?.fleets) ? fleets.fleets : null,
    worldInfo,
    trade,
    war,
    treasureLoot,
    worldBoss: worldBoss?.info ?? null,
    guildCities,
    readAt: Date.now(),
    warnings,
  };
}

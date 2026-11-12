import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadProtocol } from '../src/proto.mjs';
import {
  buildCityWarView, buildMapLayout, buildWorldMapState, cityCellLayout, gridPoint, guildColor,
  interpolateTrack, readWorldMapState, summarizeOverviewWorldMap, trackForFleet, trackForTrade,
  worldInfoBody, GUILD_PALETTE, NEUTRAL_COLOR,
} from '../src/world-map.mjs';
import { dispatchCityWarFleet } from '../src/city-war.mjs';
import { registerFleetReservations } from '../src/fleet-reservations.mjs';
import { PAGE } from '../src/page.mjs';

const protocol = loadProtocol();

function configFixture() {
  const tables = {
    '1_CityCfg': [
      { id: 1, name: '测试城', level: 10, type: 2 },
      { id: 2, name: '二号城', level: 5, type: 1 },
    ],
    CityTypeCfg: [{ id: 1, name: '浮木岛' }, { id: 2, name: '石头孤岛' }],
    '1_ResFieldTypeCfg': [
      { type: 1, level: 1, product: ['公会科技点', 360] },
      { type: 1, level: 2, product: ['公会科技点', 420] },
      { type: 2, level: 1, product: ['种子', 360] },
      { type: 3, level: 1, product: ['汽油', 360] },
    ],
  };
  return { tables: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, { data }])) };
}

function mapFixture() {
  const mapData = new Array(12).fill(0);
  mapData[6] = 10001;   // 类型 1，城 1
  mapData[7] = 20001;   // 类型 2，城 1
  mapData[10] = 30002;  // 类型 3，城 2
  return {
    file: 'world_map.world_map1.json',
    scenarioId: 1,
    width: 4,
    height: 3,
    tileWidth: 100,
    tileHeight: 75,
    cityInfo: {
      1: { gridIdx: 1, fort: 2, res: [6, 7] },
      2: { gridIdx: 2, fort: 8, res: [10] },
    },
    mapData,
    wreckPos: 5,
    bosses: [2],
    treasures: [3],
    limitedBoss: [11],
    chipMines: [8],
  };
}

async function testLayout() {
  const layout = buildMapLayout(mapFixture(), configFixture(), 1);
  assert.equal(layout.scenarioId, 1);
  assert.equal(layout.width, 4);
  assert.equal(layout.height, 3);
  assert.equal(layout.columns, 2, '横向相邻的两座城应排成两列');
  assert.equal(layout.rows, 1);
  assert.equal(layout.cities.length, 2);
  assert.deepEqual(layout.cities[0], {
    id: 1, gridIdx: 1, x: 1, y: 0, col: 0, row: 0, colSpan: 1, rowSpan: 1,
    name: '测试城', level: 10, type: 2, typeName: '石头孤岛', fieldCount: 2, fort: 2,
  });
  assert.deepEqual(layout.cities[1].col, 1);
  assert.equal(layout.cities[1].name, '二号城');
  assert.equal(layout.fields.length, 3);
  assert.deepEqual(layout.fields[0], {
    gridIdx: 6, x: 2, y: 1, resType: 1, cityId: 1, resName: '公会科技点', level: 10,
  });
  assert.equal(layout.fields[2].resName, '汽油');
  assert.deepEqual(layout.objects.boss, [{ gridIdx: 2, x: 2, y: 0, cityId: 2, cell: { x: 1, y: 0 } }]);
  assert.deepEqual(layout.objects.wreck, { gridIdx: 5, x: 1, y: 1, cityId: 1, cell: { x: 0.5, y: 1 / 3 } });
  assert.equal(layout.objects.treasure.length, 1);
  assert.equal(layout.objects.limitedBoss.length, 1);
  assert.equal(layout.objects.chipMine.length, 1);

  // 配置丢失时名称要可读，不能抛错。
  const bare = buildMapLayout(mapFixture(), null, 1);
  assert.equal(bare.cities[0].name, '城 #1');
  assert.equal(bare.cities[0].typeName, null);
  assert.equal(bare.fields[0].resName, '公会科技点');
}

// 还原真实地图：10 列 × 10 行，坐标为 12+24*col / 32+64*row；
// 2×2 的山景城中心落在 E/F 与 4/5 列的交界处，占 E4、E5、F4、F5 四格。
function gridFixture() {
  const width = 240;
  const height = 640;
  const letters = 'ABCDEFGHIJ';
  const cityInfo = {};
  const names = new Map();
  let id = 1;
  for (let row = 0; row < letters.length; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      if (row >= 4 && row <= 5 && col >= 4 && col <= 5) continue;
      const x = 12 + col * 24;
      const y = 32 + row * 64;
      cityInfo[id] = { gridIdx: y * width + x, fort: 0, res: [] };
      names.set(id, '城' + letters[row] + col);
      id += 1;
    }
  }
  cityInfo[101] = { gridIdx: 320 * width + 120, fort: 0, res: [] };
  names.set(101, '山景城');
  return {
    file: 'world_map.world_map1.json', scenarioId: 1, width, height,
    tileWidth: 100, tileHeight: 75, cityInfo, names, mapData: new Array(width * height).fill(0),
    // 沉船在 tile (110,327)，与真实地图一致，用来验证世界对象的格坐标换算。
    wreckPos: 327 * width + 110,
  };
}

async function testRealGrid() {
  const map = gridFixture();
  const config = {
    tables: {
      '1_CityCfg': {
        data: [...map.names.entries()].map(([id, name]) => ({ id, name, level: 10, type: 1 })),
      },
    },
  };
  const layout = buildMapLayout(map, config, 1);
  assert.equal(layout.columns, 10, '真实地图是 10 列');
  assert.equal(layout.rows, 10, '真实地图是 10 行');
  assert.equal(layout.cities.length, 97);

  const byName = new Map(layout.cities.map((city) => [city.name, city]));
  const mount = byName.get('山景城');
  assert.equal(mount.col, 4, '山景城从左数第 5 格开始');
  assert.equal(mount.row, 4, '山景城在 E 行');
  assert.deepEqual([mount.colSpan, mount.rowSpan], [2, 2], '山景城一个单位占四格');

  // E3 与 F3 的右侧不再直接接 E6/F6，中间是山景城占的两格。
  assert.equal(byName.get('城E3').col, 3);
  assert.equal(byName.get('城E6').col, 6);
  assert.equal(byName.get('城F3').col, 3);
  assert.equal(byName.get('城F6').col, 6);
  assert.equal(byName.get('城E3').row, 4);
  assert.equal(byName.get('城F3').row, 5);

  // 名字里的行列必须与还原出来的格坐标一致，否则说明整体错位。
  for (const city of layout.cities) {
    const match = /^城([A-J])(\d)$/.exec(city.name);
    if (!match) continue;
    assert.equal(city.row, 'ABCDEFGHIJ'.indexOf(match[1]), city.name + ' 的所在行');
    assert.equal(city.col, Number(match[2]), city.name + ' 的所在列');
    assert.deepEqual([city.colSpan, city.rowSpan], [1, 1], city.name + ' 应占一格');
  }

  // 100 个格子恰好被 97 座城覆盖：山景城占四格，其余各占一格，不允许重叠。
  const occupied = new Map();
  for (const city of layout.cities) {
    for (let dy = 0; dy < city.rowSpan; dy += 1) {
      for (let dx = 0; dx < city.colSpan; dx += 1) {
        const key = (city.col + dx) + ',' + (city.row + dy);
        assert.equal(occupied.has(key), false, '格子 ' + key + ' 被重复占用');
        occupied.set(key, city.id);
      }
    }
  }
  assert.equal(occupied.size, 100);
  for (const key of ['4,4', '5,4', '4,5', '5,5']) assert.equal(occupied.get(key), 101);

  // 舰队停靠在山景城时，点位应落在这四格的正中间。
  const cells = cityCellLayout(map);
  assert.deepEqual(cells.cells.get(101), { col: 4, row: 4, colSpan: 2, rowSpan: 2, index: 44 });

  // 沉船不在城池网格里，按真实点位换算：tile (110,327) → (110×10/240, 327×10/640)。
  assert.ok(layout.objects.wreck, '应有沉船点位');
  assert.ok(Math.abs(layout.objects.wreck.cell.x - 110 * 10 / 240) < 1e-9, '沉船格 x 按真实宽度换算');
  assert.ok(Math.abs(layout.objects.wreck.cell.y - 327 * 10 / 640) < 1e-9, '沉船格 y 按真实高度换算');
}

async function testGeometry() {
  assert.deepEqual(gridPoint(0, 240), { x: 0, y: 0 });
  assert.deepEqual(gridPoint(239, 240), { x: 239, y: 0 });
  assert.deepEqual(gridPoint(7692, 240), { x: 12, y: 32 });
  assert.equal(gridPoint(-1, 240), null);
  assert.equal(gridPoint(1, 0), null);
  assert.equal(worldInfoBody({ width: 4, height: 3, tileWidth: 100, tileHeight: 75 }).screenCenter.x, 200);
  assert.equal(worldInfoBody({ width: 4, height: 3, tileWidth: 100, tileHeight: 75 }).screenCenter.y, 113);
}

async function testColors() {
  assert.equal(guildColor(0), null);
  assert.equal(guildColor(undefined), null);
  // 四大势力固定用官方世界地图配色：黄、棕、紫、青（按 guildIdx 1-4 顺序）。
  assert.deepEqual([guildColor(1), guildColor(2), guildColor(3), guildColor(4)], GUILD_PALETTE);
  const colors = new Set(GUILD_PALETTE);
  for (let index = 5; index <= 12; index += 1) colors.add(guildColor(index));
  assert.equal(colors.size, 12, '势力颜色在同一批编号内必须互不相同');
  assert.equal(guildColor(3), guildColor(3), '同一势力编号颜色必须稳定');
  assert.notEqual(guildColor(0) ?? NEUTRAL_COLOR, guildColor(1));
}

async function testTracks() {
  const cells = new Map([
    [1, { col: 0, row: 0, index: 0 }],
    [2, { col: 1, row: 0, index: 1 }],
  ]);
  const layout = { cells, width: 4, positions: [{ id: 1, x: 1, y: 1 }, { id: 2, x: 1, y: 2 }] };
  const moving = {
    buildingId: '1舰队', state: 2, durability: 1800, maxDura: 2000,
    cityId: 1, targetCityId: 2, moveStartTs: 100, moveEndTs: 200,
  };
  const mid = trackForFleet(moving, layout, 150);
  assert.equal(mid.moving, true);
  assert.deepEqual(mid.head, { x: 1, y: 0.5 });
  assert.equal(mid.eta, 50);
  const arrived = trackForFleet(moving, layout, 250);
  assert.equal(arrived.moving, false);
  assert.deepEqual(arrived.head, { x: 1.5, y: 0.5 });
  assert.equal(arrived.eta, 0);

  const idle = trackForFleet({ buildingId: '2舰队', state: 1, cityId: 1 }, layout, 150);
  assert.equal(idle.moving, false);
  assert.deepEqual(idle.head, { x: 0.5, y: 0.5 });

  // 没有城市编号时按格坐标找最近的城，仍落在城池格里。
  const fallback = trackForFleet({ buildingId: '3舰队', state: 1, curGridIdx: 5 }, layout, 150);
  assert.deepEqual(fallback.head, { x: 0.5, y: 0.5 });
  assert.equal(trackForFleet({ buildingId: '4舰队', state: 1 }, layout, 150), null);

  const route = interpolateTrack({ x: 0, y: 0 }, { x: 10, y: 20 }, 100, 200, 150);
  assert.deepEqual(route.head, { x: 5, y: 10 });
  assert.equal(route.eta, 50);
  const invalid = interpolateTrack({ x: 1, y: 2 }, { x: 3, y: 4 }, 200, 100, 150);
  assert.equal(invalid.moving, false);
  assert.deepEqual(invalid.head, { x: 1, y: 2 });

  // 目标是宝藏/货轮等非城格时，航线指向真实格点换算的格坐标，而不是最近的城。
  const world = { cells, width: 240, height: 640, columns: 10, rows: 10, positions: layout.positions };
  const toObject = trackForFleet({
    buildingId: '5舰队', state: 2, cityId: 1, targetGridIdx: 320 * 240 + 120,
    moveStartTs: 100, moveEndTs: 200,
  }, world, 150);
  assert.equal(toObject.moving, true);
  assert.deepEqual(toObject.to, { x: 5, y: 5 }, '非城目标按真实格点换算');
  assert.deepEqual(toObject.head, { x: 2.75, y: 2.75 });
  // 缺少行列元数据时退回最近城池中心，保持旧行为。
  const legacyTarget = trackForFleet({
    buildingId: '6舰队', state: 2, cityId: 1, targetGridIdx: 5,
    moveStartTs: 100, moveEndTs: 200,
  }, layout, 150);
  assert.deepEqual(legacyTarget.to, { x: 0.5, y: 0.5 });

  const sailing = trackForTrade({ cityId: 1, moveToCityId: 2, moveStartTime: 100, moveEndTime: 200 }, layout, 150);
  assert.equal(sailing.moving, true);
  assert.deepEqual(sailing.head, { x: 1, y: 0.5 });
  const harbor = trackForTrade({ cityId: 1 }, layout, 150);
  assert.equal(harbor.moving, false);
  assert.deepEqual(harbor.head, { x: 0.5, y: 0.5 });
  assert.equal(trackForTrade({ cityId: 9 }, layout, 150), null);
}

async function testState() {
  const map = mapFixture();
  const cities = [
    { id: 1, guildIdx: 3, state: 1, defenceFleetNum: 2 },
    { id: 2, guildIdx: 3, state: 2, attackFleetNum: 4 },
    { id: 3, guildIdx: 0, state: 1 },
  ];
  const fleets = [{
    buildingId: '1舰队', state: 2, durability: 1800, maxDura: 2000, power: 120000,
    cityId: 1, targetCityId: 2, moveStartTs: 100, moveEndTs: 200,
  }, {
    buildingId: '2舰队', state: 1, durability: 900, maxDura: 2000, cityId: 2, curGridIdx: 3,
  }];
  const trade = {
    period: 3,
    cargo: { cityId: 1, moveToCityId: 2, cargoLv: 2, moveStartTime: 100, moveEndTime: 300 },
    worldCargo: [
      { playerId: '9', nickname: '路人', guildIdx: 2, title: 1, cargo: { cityId: 2, moveToCityId: 1, moveStartTime: 100, moveEndTime: 200 } },
      { playerId: '10', nickname: '无坐标', guildIdx: 2, cargo: { cityId: 99 } },
    ],
  };
  const state = buildWorldMapState({
    map, cities, fleets, trade, ownCityIds: [2], now: 150,
    player: { playerId: 1, guildId: { low: 7, high: 0 } },
    worldFleets: [
      { buildingId: '9舰队', owner: { playerId: '99', guildId: '7', nickname: '盟友甲' }, state: 1, cityId: 1 },
      { buildingId: '8舰队', owner: { playerId: '98', guildId: '8', nickname: '敌人乙' }, state: 2, cityId: 1, targetCityId: 2, moveStartTs: 100, moveEndTs: 200 },
    ],
    guildCities: { cities: [{ cityId: 2, recommended: true }] },
    treasureLoot: { treasure: [
      { uid: 12, color: 5, gridIdx: 5, ownerGuildIdx: 3, ownerFleetNum: 1, progress: 45 },
      { uid: 13, color: 3, gridIdx: 9, ownerGuildIdx: 0, progress: 0 },
    ] },
    war: {
      startTime: 100, endTime: 200, assembleCityId: 2,
      declarations: [
        { cityId: 9, attackGuildIdx: 3, defenceGuildIdx: 5 },
        { cityId: 1, attackGuildIdx: 5, defenceGuildIdx: 3 },
      ],
    },
    worldBoss: { bossId: 7, gridIdx: 2 },
    cityNames: new Map([[1, '一号城'], [2, '二号城'], [9, '敌方城']]),
  });
  assert.equal(state.ownGuildIdx, 3);
  assert.deepEqual(state.cities.map((city) => city.own), [true, true, false]);
  assert.equal(state.cities[1].battle, true);
  assert.equal(state.legend[0].guildIdx, 3);
  assert.equal(state.legend[0].own, true);
  assert.equal(state.legend[0].cities, 2);
  assert.ok(state.legend.some((entry) => entry.neutral && entry.color === NEUTRAL_COLOR));
  assert.equal(state.fleets.length, 2);
  assert.equal(state.fleets[0].stateText, '移动中');
  assert.deepEqual(state.fleets[0].track.head, { x: 1, y: 0.5 });
  assert.equal(state.fleets[1].stateText, '闲置');
  assert.equal(state.trade.open, true);
  assert.deepEqual(state.trade.cargo.track.head, { x: 0.75, y: 0.5 });
  assert.equal(state.trade.worldCargo.length, 1, '没有坐标的商船不进绘制列表');
  assert.deepEqual(state.summary, { ownCities: 2, enemyCities: 0, neutralCities: 1, fleetsMoving: 1 });
  assert.equal(state.war.active, true);
  assert.equal(state.war.assembleCityId, 2);
  assert.deepEqual(state.war.attackTargets.map((target) => target.cityId), [9]);
  assert.equal(state.war.attackTargets[0].name, '敌方城');
  assert.deepEqual(state.war.defendTargets.map((target) => target.cityId), [1, 2]);
  assert.equal(state.war.defendTargets[0].underAttack, true);
  assert.equal(state.war.defendTargets[1].recommended, true);
  assert.deepEqual(state.worldFleets.map((fleet) => fleet.kind), ['ally', 'enemy']);
  // 万吨货轮（color 5）取 gridIdx 换算格坐标；其它颜色的宝藏位不进地图状态。
  assert.deepEqual(state.merchantShip, {
    uid: 12, gridIdx: 5, x: 1, y: 1, cell: { x: 0.5, y: 1 / 3 },
    ownerGuildIdx: 3, ownerFleetNum: 1, progress: 45,
  });
  assert.equal(buildWorldMapState({ map }).merchantShip, null, '没有进行中的货轮时不应有标记');
  // 今日世界 Boss：带 gridIdx 才进状态，缺省或 gridIdx 为 0 都不显示。
  assert.deepEqual(state.worldBoss, { bossId: 7, gridIdx: 2 });
  assert.equal(buildWorldMapState({ map }).worldBoss, null, '没有 Boss 信息时不应有标记');
  assert.equal(buildWorldMapState({ map, worldBoss: { bossId: 7 } }).worldBoss, null, 'gridIdx 缺失时不应有标记');
  assert.equal(buildWorldMapState({ map, worldBoss: { bossId: 7, gridIdx: 0 } }).worldBoss, null, 'gridIdx 为 0 时不应有标记');

  const summary = summarizeOverviewWorldMap({ fleets, trade, resFields: { fields: [1, 2], maxNum: 10 }, now: 150 });
  assert.equal(summary.fleetCount, 2);
  assert.equal(summary.movingFleets, 1);
  assert.equal(summary.tradeRoute.cityId, 1);
  assert.equal(summary.tradeRoute.moveToCityId, 2);
  assert.equal(summary.tradeRoute.eta, 150);
  assert.equal(summary.fieldsOwned, 2);
  assert.equal(summary.fieldsMax, 10);
}

async function testReader() {
  for (const name of ['WorldInfoRequest', 'WorldInfoResponse', 'TradeInfoRequest', 'TradeInfoResponse',
    'MyFleetsRequest', 'MyFleetsResponse', 'GuildCityInfoRequest', 'GuildCityInfoResponse',
    'TreasureLootListRequest', 'TreasureLootListResponse', 'WorldBossInfoRequest', 'WorldBossInfoResponse']) {
    assert.ok(protocol[name], '离线协议应包含 ' + name);
  }
  const calls = [];
  const client = {
    async request(name, body, response, timeout) {
      calls.push({ name, body, response, timeout });
      if (name === 'WorldInfoRequest') throw new Error('not in world map');
      if (name === 'MyFleetsRequest') return { fleets: [{ buildingId: '1舰队', state: 1, curGridIdx: 1 }] };
      if (name === 'TradeInfoRequest') return { period: 1, cargo: { cityId: 1 } };
      if (name === 'WarDeclarationRequest') return { startTime: 0, endTime: 0, declarations: [] };
      if (name === 'TreasureLootListRequest') return { treasure: [{ uid: 12, color: 5, gridIdx: 6, ownerGuildIdx: 1, progress: 30 }] };
      if (name === 'WorldBossInfoRequest') return { info: { bossId: 3, gridIdx: 6, bestDamage: { low: 1, high: 0 }, gotRewardLevel: 0 } };
      if (name === 'GuildCityInfoRequest') return { cities: [{ cityId: 1 }] };
      throw new Error('unexpected request ' + name);
    },
    sendWatch() { throw new Error('地图读取不能发送写请求'); },
  };
  const result = await readWorldMapState(client, protocol, {
    player: { guildId: { low: 7, high: 2097152 } },
    map: mapFixture(),
  });
  assert.deepEqual(calls.map((call) => call.name), ['MyFleetsRequest', 'WorldInfoRequest', 'TradeInfoRequest', 'WarDeclarationRequest', 'TreasureLootListRequest', 'WorldBossInfoRequest', 'GuildCityInfoRequest']);
  assert.equal(calls[1].body.screenCenter.x, 200);
  assert.equal(calls[1].body.screenCenter.y, 113);
  assert.equal(result.fleets.length, 1);
  assert.equal(result.worldInfo, null);
  assert.equal(result.trade.period, 1);
  assert.deepEqual(result.worldBoss, { bossId: 3, gridIdx: 6, bestDamage: 1, gotRewardLevel: 0 });
  assert.equal(result.treasureLoot.treasure.length, 1, '应读取万吨货轮列表');
  assert.deepEqual(result.guildCities.cities, [{ cityId: 1 }]);
  assert.match(result.warnings[0], /WorldInfoRequest 读取失败/);

  const offline = {
    async request() { return {}; },
    sendWatch() { throw new Error('地图读取不能发送写请求'); },
  };
  const noGuild = await readWorldMapState(offline, protocol, { player: { guildId: 0 }, map: mapFixture() });
  assert.equal(noGuild.guildCities, null);
}

async function testDispatch() {
  assert.ok(protocol.MoveFleetsToCityRequest, '真实协议应包含 MoveFleetsToCityRequest');
  const fleet = { buildingId: '1舰队', state: 1, durability: 1000, cityId: 1 };
  const sends = [];
  let reads = 0;
  const client = {
    connected: true,
    async request(name) {
      assert.equal(name, 'MyFleetsRequest');
      reads += 1;
      return { fleets: reads === 1 ? [fleet] : [{ ...fleet, state: 2, targetCityId: 2 }] };
    },
    async sendWatch(name, body) {
      assert.equal(name, 'MoveFleetsToCityRequest');
      sends.push(body);
    },
  };
  const result = await dispatchCityWarFleet(client, protocol, { buildingId: '1舰队', cityId: 2, role: 'attack' });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(sends, [{ buildingId: ['1舰队'], cityId: 2 }]);

  const busy = {
    connected: true,
    async request() { return { fleets: [{ ...fleet, state: 3 }] }; },
    async sendWatch() { throw new Error('不应发送'); },
  };
  await assert.rejects(() => dispatchCityWarFleet(busy, protocol, { buildingId: '1舰队', cityId: 2 }), /交战/);

  const reserved = {
    connected: true,
    async request() { return { fleets: [fleet] }; },
    async sendWatch() { throw new Error('不应发送'); },
  };
  registerFleetReservations(reserved, 'auto', (id) => id === '1舰队');
  await assert.rejects(() => dispatchCityWarFleet(reserved, protocol, { buildingId: '1舰队', cityId: 2 }), /占用/);
}

async function testPageWiring() {
  assert.match(PAGE, /id="tab-map"/);
  assert.match(PAGE, /data-tab="map"/);
  assert.match(PAGE, /id="map-canvas"/);
  assert.match(PAGE, /id="map-legend"/);
  assert.match(PAGE, /id="map-fleets"/);
  assert.match(PAGE, /id="map-war-targets"/);
  assert.match(PAGE, /id="map-war-enabled"/);
  assert.match(PAGE, /data-map-layer="myFleets"/);
  assert.match(PAGE, /data-map-layer="allyFleets"/);
  assert.match(PAGE, /data-map-layer="enemyFleets"/);
  assert.match(PAGE, /data-map-layer="allyTrade"/);
  const fieldsLayer = PAGE.match(/<input[^>]*data-map-layer="fields"[^>]*>/);
  assert.ok(fieldsLayer, '资源田图层开关应存在');
  assert.doesNotMatch(fieldsLayer[0], /checked/, '资源田默认关闭');
  assert.match(PAGE, /按真实坐标/);
  assert.doesNotMatch(PAGE, /一城一格/);
  assert.match(PAGE, /世界地图/, '页面标题使用「世界地图」');
  assert.doesNotMatch(PAGE, /攻势图/, '旧名「攻势图」不应再出现在页面上');
  const script = fs.readFileSync(new URL('../src/ui/map.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [] },
    console,
  });
  vm.runInContext(script + '\n;globalThis.__mapApi = typeof refreshWorldMap === "function";', context);
  assert.equal(context.__mapApi, true, 'map.js 必须定义 refreshWorldMap 且加载时不访问 DOM');
  assert.match(script, /worldMapRefreshTimer/);
  assert.match(script, /colSpan/, '世界地图要按大城占的格数绘制');
  assert.match(script, /rowSpan/);
  assert.match(script, /worldMapObjectByGrid/, '舰队目标要能反查世界对象名');
  assert.match(script, /merchantShip/, '万吨货轮要有独立绘制与命名');
}

await testLayout();
await testRealGrid();
await testGeometry();
await testColors();
await testTracks();
await testState();
await testReader();
await testDispatch();
await testPageWiring();
console.log('world map ok: 静态布局、势力配色、舰队/商船航线、只读读取与页面接线');

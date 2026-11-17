import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 状态文件与额度账本必须落在临时目录：静态读取真实 data/ 会污染账号数据（CW_DATA_DIR 隔离）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-team-test-'));
process.env.CW_DATA_DIR = dataDir;

const { defaultSettings, importAutomationSettings, validateSettings, settingsCatalog, createUsageLedger } = await import('../src/automation-settings.mjs');
const { planBossTeams, applyBossTeams, recoverBossTeams, pendingBossTeamRestore } = await import('../src/boss-team.mjs');
const { runWorldBoss, readWorldBoss } = await import('../src/world-boss.mjs');

const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] },
  FormationTypePositionCfg: { data: [{ id: 1, position: [1, 3] }, { id: 1, position: [4, 4] }] },
  FormationHeroNumCfg: { data: [{ heroNum: 1, mainlineStage: 0 }, { heroNum: 2, mainlineStage: 10 }] },
  HeroCfg: ['坦克A', '坦克B', '坦克C', '战士A', '战士B'].map(id => ({ id, name: '英雄·' + id, career: id.startsWith('坦克') ? '坦克' : '战士', quality: 'BLUE' })),
  BuildingUnlockCfg: { data: [1, 2, 3].map(number => ({ buildingType: '远征船', buildingId: number + '远征船' })) },
  WorldParamCfg: { data: [{ paramName: '进攻首领消耗汽油', paramValue: 100 }] },
} };
const player = { level: 16, mainlineStage: 11, worldId: 2001001001 };
const nowSeconds = Math.floor(Date.now() / 1000);

/** 当前编队快照：1队[坦克A,战士A] 2队[坦克B,战士B] 3队[坦克C]。 */
function teamDocks() {
  return [
    { buildingId: '1远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克A', pos: { x: 1, y: 3 } }, { heroId: '战士A', pos: { x: 4, y: 4 } }] } } },
    { buildingId: '2远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克B', pos: { x: 1, y: 3 } }, { heroId: '战士B', pos: { x: 4, y: 4 } }] } } },
    { buildingId: '3远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克C', pos: { x: 1, y: 3 } }] } } },
  ];
}
const idleFleets = () => teamDocks().map(dock => ({ buildingId: dock.buildingId, state: 1, curGridIdx: 0, maxDura: 100, durability: 100 }));
/** 互换名单：1队要2队的坦克B，2队要1队的战士A（日常城战用默认编队、打Boss互换的场景）。 */
const swapTeams = () => [
  { buildingId: '1远征船', heroes: ['坦克A', '坦克B'] },
  { buildingId: '2远征船', heroes: ['战士B', '战士A'] },
];

function bossFixture({ rejectBuildingId = null } = {}) {
  const client = {
    water: teamDocks(), fleets: idleFleets(),
    heroes: ['坦克A', '坦克B', '坦克C', '战士A', '战士B'].map(heroId => ({ heroId })),
    counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: 0, updateTime: nowSeconds }],
    items: [{ itemId: '汽油', num: 1000 }],
    writes: [], challenged: [], rejectBuildingId,
    async request(name, body, response) {
      if (name === 'OnWaterRequest') return { building: structuredClone(this.water) };
      if (name === 'MyFleetsRequest') return { fleets: structuredClone(this.fleets) };
      if (name === 'AllHeroRequest') return { heroes: structuredClone(this.heroes) };
      if (name === 'CounterInfoRequest') return { counters: structuredClone(this.counters) };
      if (name === 'AllItemRequest') return { items: structuredClone(this.items) };
      if (name === 'WorldBossInfoRequest') return { info: { bossId: 7, gridIdx: 55, bestDamage: 0, gotRewardLevel: 0 } };
      if (name === 'ChallengeWorldBossRequest') {
        assert.equal(response, 'OkResponse');
        assert.equal(body.fleetBuildingIds.length, 1, '逐队单发挑战，不一次发多队');
        const [buildingId] = body.fleetBuildingIds;
        if (this.rejectBuildingId === buildingId) {
          const error = new Error('product not enough');
          error.prompt = 'product not enough';
          error.request = 'ChallengeWorldBossRequest';
          throw error;
        }
        this.challenged.push(buildingId);
        const fleet = this.fleets.find(row => row.buildingId === buildingId);
        fleet.state = 2; fleet.targetGridIdx = 55;
        const counter = this.counters.find(row => row.type === 'DAILY_WORLD_BOSS_TIMES');
        counter.num += 1; counter.updateTime = Math.floor(Date.now() / 1000);
        return {};
      }
      assert.fail('意外请求 ' + name);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'FleetSaveFormationRequest');
      this.writes.push(structuredClone(body));
      const dock = this.water.find(row => row.buildingId === body.buildingId);
      dock.fleet = { ...(dock.fleet ?? {}), formation: structuredClone(body.formation) };
      return {};
    },
  };
  return client;
}

const teamSettings = ({ enabled = true, teamsEnabled = true, teams = swapTeams() } = {}) => {
  const settings = defaultSettings();
  settings.worldBoss.enabled = enabled;
  settings.worldBoss.teamsEnabled = teamsEnabled;
  settings.worldBoss.teams = structuredClone(teams);
  return settings;
};

async function testSettingsValidation() {
  const settings = teamSettings();
  assert.deepEqual(validateSettings(settings).worldBoss.teams, settings.worldBoss.teams);
  const catalog = settingsCatalog(config);
  const duplicateDock = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克A'] }, { buildingId: '1远征船', heroes: ['坦克B'] }] });
  assert.throws(() => validateSettings(duplicateDock), /不重复的远征舰队/);
  const badDock = teamSettings({ teams: [{ buildingId: '1船', heroes: ['坦克A'] }] });
  assert.throws(() => validateSettings(badDock), /不重复的远征舰队/);
  const emptyHeroes = teamSettings({ teams: [{ buildingId: '1远征船', heroes: [] }] });
  assert.throws(() => validateSettings(emptyHeroes), /非空列表/);
  const duplicateHero = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克A', '坦克A'] }] });
  assert.throws(() => validateSettings(duplicateHero), /非空列表/);
  const unknownDock = teamSettings({ teams: [{ buildingId: '9远征船', heroes: ['坦克A'] }] });
  assert.throws(() => validateSettings(unknownDock, { catalog }), /不存在的舰队/);
  const unknownHero = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克Z'] }] });
  assert.throws(() => validateSettings(unknownHero, { catalog }), /不存在的英雄/);
  // 开启名单但一条舰队都没配：保存时直接拦截，避免挂机被空名单卡住。
  assert.throws(() => validateSettings(teamSettings({ teams: [] })), /至少添加一支舰队/);
  // 旧导出文件没有队伍字段：导入时补默认值，不破坏历史配置。
  const legacy = defaultSettings();
  delete legacy.worldBoss.teamsEnabled;
  delete legacy.worldBoss.teams;
  const imported = importAutomationSettings({ format: 'crazywaterworld-automation', version: 1, settings: legacy }, { catalog });
  assert.equal(imported.worldBoss.teamsEnabled, false);
  assert.deepEqual(imported.worldBoss.teams, []);
}

async function testPlanner() {
  // 用户场景：1队⇄2队互换英雄 —— 先下阵再上阵，共 3 次保存。
  const plan = planBossTeams(config, player, swapTeams(), teamDocks(), { fleets: idleFleets() });
  assert.ok(plan.ok, plan.reason);
  assert.deepEqual(plan.saves.map(save => save.buildingId), ['1远征船', '2远征船', '1远征船']);
  assert.deepEqual(plan.saves[0].formation.heroPositions, [{ heroId: '坦克A', pos: { x: 1, y: 3 } }], '第一步先从1队下阵战士A');
  assert.deepEqual(plan.saves[1].formation.heroPositions, [{ heroId: '战士A', pos: { x: 4, y: 4 } }, { heroId: '战士B', pos: { x: 1, y: 3 } }]);
  assert.deepEqual(plan.saves[2].formation.heroPositions, [{ heroId: '坦克A', pos: { x: 4, y: 4 } }, { heroId: '坦克B', pos: { x: 1, y: 3 } }]);
  assert.deepEqual(plan.touched.map(row => row.buildingId).sort(), ['1远征船', '2远征船']);
  // 名单英雄在非名单舰队：先去该队下阵，再上阵名单舰队；下阵位也记录原编队。
  const occupierDocks = [
    { buildingId: '1远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克A', pos: { x: 1, y: 3 } }] } } },
    { buildingId: '3远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克C', pos: { x: 1, y: 3 } }, { heroId: '战士B', pos: { x: 4, y: 4 } }] } } },
  ];
  const plan2 = planBossTeams(config, player, [{ buildingId: '1远征船', heroes: ['坦克A', '战士B'] }], occupierDocks,
    { fleets: [{ buildingId: '1远征船', state: 1 }, { buildingId: '3远征船', state: 1 }] });
  assert.ok(plan2.ok, plan2.reason);
  assert.deepEqual(plan2.saves[0], { buildingId: '3远征船', formation: { presetId: 1, heroPositions: [{ heroId: '坦克C', pos: { x: 1, y: 3 } }] } });
  assert.equal(plan2.saves[1].buildingId, '1远征船');
  assert.ok(plan2.touched.find(row => row.buildingId === '3远征船').formation.heroPositions.some(p => p.heroId === '战士B'), '下阵位保留原编队快照');
  // 下阵会清空编队：拒绝，不允许保存空编队。
  const singleDocks = [
    { buildingId: '1远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '坦克A', pos: { x: 1, y: 3 } }] } } },
    { buildingId: '3远征船', level: 1, fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '战士B', pos: { x: 4, y: 4 } }] } } },
  ];
  const plan3 = planBossTeams(config, player, [{ buildingId: '1远征船', heroes: ['坦克A', '战士B'] }], singleDocks,
    { fleets: [{ buildingId: '1远征船', state: 1 }, { buildingId: '3远征船', state: 1 }] });
  assert.equal(plan3.ok, false);
  assert.match(plan3.reason, /无法腾位/);
  // 校验：跨名单重复、超员、忙碌、未拥有、空名单。
  assert.match(planBossTeams(config, player, [{ buildingId: '1远征船', heroes: ['坦克A', '坦克B'] }, { buildingId: '2远征船', heroes: ['坦克B'] }], teamDocks(), { fleets: idleFleets() }).reason, /同时出现在/);
  assert.match(planBossTeams(config, player, [{ buildingId: '1远征船', heroes: ['坦克A', '坦克B', '战士A'] }], teamDocks(), { fleets: idleFleets() }).reason, /超过当前解锁的编队位/);
  const busy = idleFleets(); busy[0].state = 2;
  assert.match(planBossTeams(config, player, swapTeams(), teamDocks(), { fleets: busy }).reason, /正在执行其他任务/);
  assert.match(planBossTeams(config, player, swapTeams(), teamDocks(), { owned: new Set(['坦克A']), fleets: idleFleets() }).reason, /不存在或未拥有/);
  assert.match(planBossTeams(config, player, [], teamDocks()).reason, /请先在队伍名单中选择舰队和英雄/);
  // 名单已就位（目标与现行编队一致）时排序器不再产生保存动作。
  const appliedDocks = structuredClone(teamDocks());
  appliedDocks[0].fleet.formation.heroPositions = [{ heroId: '坦克A', pos: { x: 4, y: 4 } }, { heroId: '坦克B', pos: { x: 1, y: 3 } }];
  appliedDocks[1].fleet.formation.heroPositions = [{ heroId: '战士A', pos: { x: 4, y: 4 } }, { heroId: '战士B', pos: { x: 1, y: 3 } }];
  const noopPlan = planBossTeams(config, player, swapTeams(), appliedDocks, { fleets: idleFleets() });
  assert.ok(noopPlan.ok, noopPlan.reason);
  assert.deepEqual(noopPlan.saves, [], '已就位的名单不产生重复保存');
}

async function testApplyAndRestore() {
  const client = bossFixture();
  const settings = teamSettings();
  const reports = [];
  const applied = await applyBossTeams(client, config, player, settings, { report: entry => reports.push(entry) });
  assert.ok(applied.ok, applied.reason);
  assert.equal(client.writes.length, 3);
  // 中途重复应用：名单已就位时不再发写请求，也不覆盖待恢复快照（保留真正原编队）。
  const recordBeforeApply = structuredClone(pendingBossTeamRestore('2001001001'));
  const again = await applyBossTeams(client, config, player, settings, { report: () => {} });
  assert.ok(again.ok && again.already, '重复应用应识别为已就位');
  assert.equal(client.writes.length, 3, '已就位时不重复保存');
  assert.deepEqual(pendingBossTeamRestore('2001001001'), recordBeforeApply, '待恢复快照保持首轮原编队');
  // 换一份不同名单时，上一份尚未恢复前拒绝再次应用。
  const other = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克A', '战士A'] }, { buildingId: '2远征船', heroes: ['坦克B', '战士B'] }] });
  const refused = await applyBossTeams(client, config, player, other, { report: () => {} });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /尚未恢复/);
  assert.deepEqual(client.water.find(dock => dock.buildingId === '1远征船').fleet.formation.heroPositions.map(p => p.heroId), ['坦克A', '坦克B']);
  assert.deepEqual(client.water.find(dock => dock.buildingId === '2远征船').fleet.formation.heroPositions.map(p => p.heroId), ['战士A', '战士B']);
  assert.ok(reports.some(entry => entry.ok), '应用成功要上报');
  const record = pendingBossTeamRestore('2001001001');
  assert.ok(record, '应用后落盘待恢复记录');
  assert.deepEqual(record.fleets.map(row => row.buildingId).sort(), ['1远征船', '2远征船']);
  // 打完Boss舰队在途：恢复等待，不改编队。
  const writesAfterApply = client.writes.length;
  for (const fleet of client.fleets) { fleet.state = 2; fleet.targetGridIdx = 55; }
  await recoverBossTeams(client, config, player, { report: () => {} });
  assert.equal(client.writes.length, writesAfterApply, '舰队在途时不换阵');
  assert.ok(pendingBossTeamRestore('2001001001'));
  // 回港空闲：互换回位并清除记录。
  for (const fleet of client.fleets) { fleet.state = 1; delete fleet.targetGridIdx; }
  const restoreReports = [];
  await recoverBossTeams(client, config, player, { report: entry => restoreReports.push(entry) });
  assert.equal(client.writes.length, writesAfterApply + 3, '互换恢复同样需要下阵腾位');
  const dock1 = client.water.find(dock => dock.buildingId === '1远征船');
  assert.deepEqual(dock1.fleet.formation.heroPositions, [{ heroId: '坦克A', pos: { x: 1, y: 3 } }, { heroId: '战士A', pos: { x: 4, y: 4 } }], '1队恢复原编队');
  const dock2 = client.water.find(dock => dock.buildingId === '2远征船');
  assert.deepEqual(dock2.fleet.formation.heroPositions, [{ heroId: '坦克B', pos: { x: 1, y: 3 } }, { heroId: '战士B', pos: { x: 4, y: 4 } }], '2队恢复原编队');
  assert.equal(pendingBossTeamRestore('2001001001'), null, '全部恢复后清除记录');
  assert.ok(restoreReports.some(entry => entry.ok));
}

async function testRunWorldBossWithTeams() {
  const client = bossFixture();
  const settings = teamSettings();
  const usageFile = path.join(dataDir, 'usage-run.json');
  const ledger = createUsageLedger('boss-team-run', { file: usageFile });
  const reports = [];
  const fresh = await runWorldBoss(client, config, player, {
    getSettings: () => settings, ledger, enabled: () => true,
    report: entry => reports.push(entry),
  });
  assert.ok(fresh);
  // 全部合格舰队逐队出征：名单舰队换过编队，未配名单的3队原编队直接出征。
  assert.deepEqual(client.challenged, ['1远征船', '2远征船', '3远征船']);
  assert.equal(client.writes.length, 3, '只有名单舰队换编队');
  const confirmed = Object.entries(ledger.keyRecords());
  assert.equal(confirmed.length, 3);
  assert.ok(confirmed.every(([key, record]) => record.confirmed && /^world-boss:2001001001:\d+:[123]$/.test(key)));
  assert.equal(ledger.confirmedCounters().worldBossPetrol, 300, '每队各预留一份汽油');
  assert.equal(reports.filter(entry => entry.ok).length, 4, '三次派遣确认 + 一次队伍名单应用');
  assert.ok(reports.some(entry => entry.ok && entry.label === '世界Boss队伍名单'));
  // 打完当天：重复运行不再派遣。
  const secondReports = [];
  await runWorldBoss(client, config, player, {
    getSettings: () => settings, ledger, enabled: () => true,
    report: entry => secondReports.push(entry),
  });
  assert.equal(client.challenged.length, 3, '当日首战已完成后不再重复派遣');
  assert.ok(secondReports.some(entry => entry.skipped && /已完成派遣/.test(entry.reason)));
  // 舰队回港后恢复原编队。
  for (const fleet of client.fleets) { fleet.state = 1; delete fleet.targetGridIdx; }
  await recoverBossTeams(client, config, player, { report: () => {} });
  assert.deepEqual(client.water.find(dock => dock.buildingId === '2远征船').fleet.formation.heroPositions.map(p => p.heroId), ['坦克B', '战士B']);
  assert.equal(pendingBossTeamRestore('2001001001'), null);
}

async function testDispatchIsolationAndPreview() {
  // 一队被服务器拒绝不影响其余舰队出征；被拒队的额度记录回滚。
  const client = bossFixture({ rejectBuildingId: '2远征船' });
  const settings = teamSettings({ teamsEnabled: false, teams: [] });
  const ledger = createUsageLedger('boss-team-isolation', { file: path.join(dataDir, 'usage-isolation.json') });
  const reports = [];
  await runWorldBoss(client, config, player, {
    getSettings: () => settings, ledger, enabled: () => true,
    report: entry => reports.push(entry),
  });
  assert.deepEqual(client.challenged, ['1远征船', '3远征船']);
  assert.equal(client.writes.length, 0, '未开启名单不改编队');
  const keys = ledger.keyRecords();
  assert.ok(keys['world-boss:2001001001:' + Object.keys(keys)[0].split(':')[2] + ':1']?.confirmed);
  assert.ok(!Object.keys(keys).some(key => key.endsWith(':2')), '被拒舰队不保留派遣记录');
  assert.equal(ledger.confirmedCounters().worldBossPetrol, 200);
  assert.ok(reports.some(entry => entry.status === 'rejected' && entry.label.includes('2远征船')));
  // 预览：名单校验失败直接给出原因，不出兵。
  const previewClient = bossFixture();
  const previewLedger = createUsageLedger('boss-team-preview', { file: path.join(dataDir, 'usage-preview.json') });
  const previewSettings = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克A', '坦克B', '战士A'] }] });
  const state = await readWorldBoss(previewClient, config, player, previewSettings, previewLedger);
  assert.match(state.reason, /超过当前解锁的编队位/);
  // 名单舰队没有已保存编队也允许出征（名单会提供编队）。
  const bareClient = bossFixture();
  bareClient.water[0].fleet = {}; // 1队没有编队
  const bareLedger = createUsageLedger('boss-team-bare', { file: path.join(dataDir, 'usage-bare.json') });
  const bareSettings = teamSettings({ teams: [{ buildingId: '1远征船', heroes: ['坦克A', '战士A'] }] });
  const bareState = await readWorldBoss(bareClient, config, player, bareSettings, bareLedger);
  assert.equal(bareState.reason, '', bareState.reason);
  assert.ok(bareState.fleets.find(fleet => fleet.buildingId === '1远征船').reason === '');
}

async function testBossTeam() {
  await testSettingsValidation();
  await testPlanner();
  await testApplyAndRestore();
  await testRunWorldBossWithTeams();
  await testDispatchIsolationAndPreview();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await testBossTeam();
  console.log('boss team ok: settings validation, swap planner, apply/restore, multi-fleet dispatch, isolation and preview');
}

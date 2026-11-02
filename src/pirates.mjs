import { displayMaterial } from './config.mjs';
import { normalize } from './worlds.mjs';

// WorldIdRule.getSeason in the game client.
export async function pirateTracker(client, config, player) {
  const worldId = normalize(player?.worldId);
  if (!(worldId > 0)) throw new Error('未取得角色世界编号');
  const season = Math.floor(worldId / 1e6) % 1000;
  const required = config?.tables.ModuleOpenCfg?.data.find(row => row.moduleId === '世界')?.playerLevel;
  const rows = config?.tables.WorldPirateCfg?.data.filter(r => Number(r.season) === season);
  if (!required || !rows?.length) throw new Error('缺少本赛季海盗配置');
  const locked = player.level < required;
  let records, pirates;
  const errors = [];
  if (!locked) {
    for (const [req, field] of [['PirateKillRecord', 'records'], ['AllPirate', 'pirates']]) {
      try {
        const reply = await client.request(req + 'Request', {}, req + 'Response');
        if (field === 'records') records = reply.records ?? [];
        else pirates = reply.pirates ?? [];
      } catch (error) { errors.push(error.message); }
    }
  }
  const targets = [];
  for (const type of new Set(rows.map(r => r.type))) {
    const cleared = records ? records.find(r => r.type === type)?.maxKilledLevel ?? 0 : null;
    const levels = rows.filter(r => r.type === type).sort((a, b) => a.level - b.level);
    const row = levels.find(r => r.level > (cleared ?? 0)) ?? levels.at(-1);
    targets.push({ name: row.showName, level: row.level, cleared, finished: cleared !== null && cleared >= row.level,
      power: row.power, soil: row.firstKillReward.find(([id]) => id === '有机土壤')?.[1] ?? 0,
      materials: row.firstKillReward.map(([id, n]) => displayMaterial(config, id) + ' ×' + n).join('、'),
      visible: pirates ? pirates.filter(p => p.type === type && p.level === row.level).length : null });
  }
  return { season, required, locked, targets, errors };
}

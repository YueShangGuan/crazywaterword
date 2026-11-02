async function readRaid(client, raidId) {
  const { raid } = await client.request('TrialRaidInfoRequest', { raidId });
  if (!raid || raid.raidId !== raidId) throw new Error('无法确认试炼副本进度');
  return raid;
}

export async function challengeTrial(client, config, level, raidId) {
  const raid = config?.tables.TrialRaidCfg.data.find(row => row.raidId === raidId);
  if (!raid) throw new Error('未知试炼副本');
  const stages = config.tables.TrialRaidStageCfg.data.filter(row => row.raidId === raidId).sort((a, b) => a.stageLevel - b.stageLevel);
  if (!stages.length) throw new Error(raid.title + '缺少关卡配置');
  if (level < stages[0].openLevel) throw new Error(raid.title + '需要角色 ' + stages[0].openLevel + ' 级');
  const info = await readRaid(client, raidId);
  const next = stages.find(row => row.stageId > (info.passedStage ?? 0));
  if (!next) return raid.title + '已全部通关';
  if (level < next.openLevel) throw new Error(raid.title + '第 ' + next.stageLevel + ' 关需要角色 ' + next.openLevel + ' 级');
  await client.request('TrialRaidChallengeRequest', { raidId, stageId: next.stageId });
  const after = await readRaid(client, raidId);
  return raid.title + '第 ' + next.stageLevel + ' 关' + (after.passedStage >= next.stageId ? '已通关' : '未通关');
}

export async function sweepTrials(client, config, level, enabled, log) {
  const prices = config?.tables.TrialRaidBuySweepCfg?.data ?? [];
  for (const raid of config?.tables.TrialRaidCfg?.data ?? []) {
    const stages = config.tables.TrialRaidStageCfg.data.filter(row => row.raidId === raid.raidId);
    if (!enabled() || !stages.some(row => row.openLevel <= level)) continue;
    try {
      let info = await readRaid(client, raid.raidId);
      while (enabled() && stages.some(row => row.stageId === info.passedStage)) {
        const next = (info.buySweepTimes ?? 0) + 1;
        if (!prices.some(row => row.buyTimes === next && row.costRuby === 0)) break;
        await client.sendWatch('TrialRaidBuySweepRequest', { raidId: raid.raidId, useAdvCard: false });
        info = await readRaid(client, raid.raidId);
        if (!(info.buySweepTimes >= next)) throw new Error('服务端未确认扫荡次数，本轮停止');
        log({ title: raid.title + '已免费扫荡', ok: true });
      }
    } catch (error) {
      log({ title: raid.title + '免费扫荡', ok: false, error: error.message });
    }
  }
}

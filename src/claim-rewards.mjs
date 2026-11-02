import { runAction } from './actions.mjs';
import { claimDailies } from './dailies.mjs';
import { claimHeroShowRewards } from './hero-show-rewards.mjs';
import { surveyTasks, runTasks } from './tasks.mjs';

export async function claimRewards(client, protocol, config, onResult, enabled = () => true, onAfkDeadline, scheduler, player) {
  const results = [];
  const ready = key => enabled(key) && (!scheduler || scheduler.due(key));
  const report = (label, ok, error) => {
    const entry = { label, ok, error };
    results.push(entry);
    onResult?.(entry);
  };
  async function group(label, work) {
    try { await work(); }
    catch (error) { report(label, false, error.message); }
  }
  async function draw(key, label, action, params = {}) {
    if (!ready(key)) return;
    await group(label, async () => {
      const reply = await runAction(client, protocol, action, params, { allowMutate: true });
      report(label, true);
      if (action === 'afkDraw') setDeadline(reply.body?.afkFinishTime);
    });
  }
  function setDeadline(finishTime) {
    const deadline = finishTime * 1000 - (client.serverClockOffsetMs || 0);
    if (finishTime > 0) onAfkDeadline?.(deadline > Date.now() ? deadline : Date.now() + 60_000);
  }

  if (ready('tasks')) await group('任务与成就', async () => {
    const survey = await surveyTasks(client, protocol, { config, scheduler, player });
    if (survey.orderError) report('每日订单', false, survey.orderError);
    await runTasks(client, protocol, survey, { allowMutate: true, enabled: () => enabled('tasks'),
      onStep: (entry) => report(entry.step.label, entry.ok, entry.error) });
  });
  if (['dailyRewards', 'chests', 'gift'].some(ready)) await group('日常与赠礼', () => claimDailies(client, protocol, { config, enabled, scheduler,
    onStep: (entry) => report(entry.note || entry.title, entry.ok, entry.error) }));
  if (ready('mail')) await group('邮件', async () => {
    const inbox = await client.request('EmailBoxRequest', { pageNo: 0 }, 'EmailBoxResponse');
    if (inbox.email?.some((mail) => !mail.got)) await draw('mail', '已读邮件附件', 'emailQuickGet');
    else if (scheduler) scheduler.defer('mail', scheduler.now() + 180);
  });
  if (ready('afk')) await group('挂机收益', async () => {
    const { afkInfo } = await client.request('AfkInfoRequest', {}, 'AfkInfoResponse');
    if (!afkInfo) return;
    setDeadline(afkInfo.afkFinishTime);
    if (afkInfo.afkFinishTime > 0 && afkInfo.afkFinishTime * 1000 <= Date.now() + (client.serverClockOffsetMs || 0)) {
      await draw('afk', '闯关挂机收益已满，领取本段收益', 'afkDraw');
    }
    const level = config?.nextAfkRewardLevel(afkInfo.rewardedLevel ?? 0);
    if (level != null && level <= afkInfo.level) await draw('afk', `挂机等级 ${level} 奖励`, 'afkLevelDraw', { level });
  });
  if (ready('heroShowRewards')) await group('英雄技能展示奖励', () => claimHeroShowRewards(client, config, report));
  return results;
}

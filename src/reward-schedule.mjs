// A new game connection always verifies the server again. Stopping and starting
// idle on the same connection keeps its confirmed cooldowns.
const schedules = new WeakMap();
const day = 86400;
const beijing = 8 * 3600;

export function rewardSchedule(client) {
  if (schedules.has(client)) return schedules.get(client);
  const deadlines = new Map();
  const now = () => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  function clearTask(key) {
    for (const saved of deadlines.keys()) {
      if (saved === key || saved.startsWith(key + ':')) deadlines.delete(saved);
    }
  }
  const schedule = {
    now,
    nextCheck: key => deadlines.get(key) > now() ? deadlines.get(key) : null,
    nextDay: () => (Math.floor((now() + beijing) / day) + 1) * day - beijing,
    due(key) {
      if (deadlines.get(key) > now()) return false;
      deadlines.delete(key);
      return true;
    },
    defer(key, until) {
      if (Number.isFinite(until) && until > now()) deadlines.set(key, Math.ceil(until));
    },
    clear: key => deadlines.delete(key),
    clearTask,
  };
  client.on?.('message', ({ name, body }) => {
    switch (name) {
      case 'SCServerTimeChanged':
      case 'SCDailyTaskReset':
        deadlines.clear();
        break;
      case 'SCDailyTaskUpdate':
        if (!body?.task || body.task.rewardClaimed || body.task.progress >= body.task.targetProgress) {
          clearTask('dailyRewards');
          clearTask('chests');
        }
        break;
      case 'SCDailyWeeklyReset':
        clearTask('chests');
        clearTask('weekGift');
        break;
      case 'SCNewEmail': clearTask('mail'); break;
      case 'SCJoinGuild':
      case 'SCLeaveGuild':
        clearTask('guildOrders');
        clearTask('radarAuto');
        clearTask('radarRepair');
        clearTask('guildWelfare');
        break;
      case 'SCNewGuildWelfarePack': clearTask('guildWelfare'); break;
      case 'SCOrderOfTheDay': clearTask('orderDaily'); break;
      case 'SCActivityActiveScoreUpdate': clearTask('festivalActive'); break;
      case 'SCNewCampaignReport': clearTask('campaignReports'); break;
      case 'SCOpenRankRedDot': clearTask('openRankRewards'); break;
      case 'SCAllActivity':
        for (const key of ['festivalSign', 'festivalActive', 'festivalGifts', 'snowballFree', 'compassSpin']) clearTask(key);
        clearTask('weekGift');
        clearTask('weekTimes');
        clearTask('weekPass');
        clearTask('newbieLogin');
        break;
      case 'SCNewbieActivityUpdate': clearTask('newbieLogin'); break;
      case 'SCTrialRaidUpdate':
        schedule.clear('trialSweep');
        if (body?.raid?.raidId) schedule.clear('trialSweep:' + body.raid.raidId);
        break;
      case 'SCVipUpdate':
      case 'SCActivityPaidMoneyUpdate':
        clearTask('adShop');
        break;
    }
  });
  schedules.set(client, schedule);
  return schedule;
}

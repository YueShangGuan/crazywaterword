// Persist only overrides in each account. Older accounts have no automatic
// schedule until they start one; new captured accounts use the defaults.
export const automationTasks = [
  ['diveEnhance', '潜水船坞强化与升级', '船只', false],
  ['autoDive', '潜水打捞原料', '船只', false],
  ['salvageEnhance', '拾荒船强化与升级', '船只', false],
  ['autoSalvage', '拾荒船自动拾荒', '船只', false],
  ['cargo', '贸易港交货与收货', '海面', true],
  ['farm', '农田种植与收获', '海面', true],
  ['weekTimes', '周抽奖次数奖励', '活动', true],
  ['evilExpel', '驱邪除祟与累计奖励', '活动', false],
  ['edict', '酆都法旨自动解符（每轮最多使用 1 份贡品）', '活动', false],
  ['compassReward', '风水罗盘已达标奖励', '活动', false],
  ['floaters', '海面漂浮物拾取', '海面', true],
  ['fishBook', '钓鱼图鉴奖励', '领奖', true],
  ['newbieLogin', '新手七日登录奖励', '领奖', true],
  ['weekPass', '周战令奖励', '活动', false],
  ['weekGift', '周抽奖免费礼包', '活动', false],
  ['tasks', '任务与成就奖励', '领奖', true],
  ['dailyRewards', '每日任务奖励', '领奖', true],
  ['chests', '活跃宝箱', '领奖', true],
  ['gift', '每日免费赠礼', '领奖', true],
  ['mail', '邮件附件', '领奖', true],
  ['afk', '闯关挂机收益（满额领取）', '领奖', true],
  ['freeRecruit', '免费招募', '日常', true],
  ['freeGold', '免费点金', '日常', true],
  ['ticketRecruit', '使用招募券', '日常', false],
  ['arena', '竞技场挑战', '日常', false],
  ['trialSweep', '试炼副本免费扫荡', '挑战', true],
  ['pirate', '讨伐野怪', '日常', false],
  ['paidGold', '钻石点金', '日常', false],
  ['shop', '折扣店购买', '日常', false],
  ['collect', '收取产物', '海面', true],
  ['finishUpgrade', '建筑竣工', '海面', true],
  ['build', '空位建造', '海面', true],
  ['finishOrder', '交居民订单', '海面', true],
  ['startProduce', '工厂排产', '海面', true],
  ['weekFactory', '周订单工厂建设', '海面', true],
  ['upgrade', '余料升级建筑', '海面', false],
  ['speedUp', '使用加速器', '海面', false],
  ['denyOrder', '拒单重刷', '海面', false],
].map(([key, label, group, initial]) => ({ key, label, group, initial }));

export function taskSettings(saved = {}) {
  return Object.fromEntries(automationTasks.map(({ key, initial }) =>
    [key, typeof saved?.[key] === 'boolean' ? saved[key] : initial]));
}

export function worldTaskKey(kind) {
  if (kind === 'gainFactory' || kind === 'collectProduct') return 'collect';
  if (kind === 'speedUpUpgrade' || kind === 'speedUpProduce') return 'speedUp';
  return kind;
}

export function dailyTaskKey(id, action) {
  switch (id) {
    case 1002: return action.body.way === 1 ? 'freeRecruit' : 'ticketRecruit';
    case 1005: return 'arena';
    case 1006: return action.body.free ? 'freeGold' : 'paidGold';
    case 1007: return 'shop';
    case 1010: return 'pirate';
    default: return null;
  }
}

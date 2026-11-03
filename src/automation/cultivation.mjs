import { planHeroes } from '../heroes.mjs';
import { makeTypeResolver } from '../world.mjs';
import { amount, idString } from './context.mjs';
import { costs, mutate, repeat, succeeded, skip, referencedIds } from './common.mjs';

const COLOR_COST = { BLUE: 'consumeBlue', PURPLE: 'consumePur', ORANGE: 'consumeOra', RED: 'consumeRed' };

/** 单次升级只消耗下一等级经验；规划器的累计经验不能作为单次价格。 */
function heroStepCosts(ctx, step) {
  if (step.kind === 'level') return [['英雄经验', ctx.rows('HeroUpgradeCfg').find(r => r.level === step.from + 1)?.exp]];
  if (step.kind === 'skill') return [[step.item, step.num]];
  const expenses = [[`${step.heroId}碎片`, step.own]];
  if (step.fragments > step.own) {
    const item = ctx.rows('HeroCfg').find(r => r.id === step.heroId)?.universalItemId;
    expenses.push([item, step.fragments - step.own]);
  }
  return expenses;
}

/** 只培养显式选中的英雄，每一步重新读取资源及英雄状态。 */
export async function hero(ctx, options) {
  const selected = options.heroes;
  const consuming = ['levelUp', 'starUp', 'skillLevelUp', 'skillAdvance', 'exclusiveLevelUp', 'exclusiveStarUp', 'equipEnhance', 'badgeEnhance', 'appoint', 'fragRecruit'].some(k => options[k]);
  if (consuming && !selected.length) skip(ctx, '请先选择英雄；培养、碎片招募与委任未执行');
  if (selected.length) {
    if (options.fragRecruit) {
      const owned = new Set((await ctx.query('AllHeroRequest')).heroes?.map(h => h.heroId));
      for (const id of selected) if (!owned.has(id)) {
        const row = ctx.rows('HeroCfg').find(r => r.id === id);
        if (row?.recruitFrag > 0) await mutate(ctx, 'HeroRecruitRequest', { heroId: id }, 'AllHeroRequest', s => s.heroes, { expenses: [[`${id}碎片`, row.recruitFrag]] });
        else skip(ctx, `${id} 缺少招募所需碎片配置`);
      }
    }
    await repeat(ctx, Math.max(options.levelUpMaxActions, 1), async index => {
      let progressed = false;
      for (const kind of ['star', 'level', 'skill']) {
        if (!({ star: options.starUp, level: options.levelUp && index < options.levelUpMaxActions, skill: options.skillLevelUp })[kind]) continue;
        // 升星会改变技能上限，前一步也可能耗尽共享材料；每类操作重新规划。
        const fresh = planHeroes({ config: ctx.config, heroes: (await ctx.query('AllHeroRequest')).heroes ?? [], itemNum: id => ctx.stock.get(id) ?? 0, playerLevel: ctx.player.level, allowUniversal: options.universal, heroIds: selected });
        for (const step of fresh.steps.filter(s => s.kind === kind).filter((s, i, a) => a.findIndex(x => x.heroId === s.heroId && x.slot === s.slot) === i)) {
          const request = { star: 'HeroStarUpRequest', level: 'HeroLevelUpRequest', skill: 'HeroSkillLevelUpRequest' }[kind];
          const body = kind === 'star' ? { heroId: step.heroId, universal: step.universal } : kind === 'skill' ? { heroId: step.heroId, skillIdx: step.slot + 1 } : { heroId: step.heroId };
          const expenses = heroStepCosts(ctx, step);
          const result = await mutate(ctx, request, body, 'AllHeroRequest', s => s.heroes?.find(h => h.heroId === step.heroId), { expenses });
          if (!succeeded(result)) return false;
          progressed = true;
        }
      }
      return progressed;
    });
    for (const id of selected) {
      let current = (await ctx.query('AllHeroRequest')).heroes?.find(h => h.heroId === id);
      if (!current) continue;
      for (const [on, table, property, request] of [[options.exclusiveLevelUp, 'ExclusiveUpgradeCfg', 'level', 'HeroExclusiveLevelUpRequest'], [options.exclusiveStarUp, 'ExclusiveStarCfg', 'star', 'HeroExclusiveStarUpRequest']]) {
        if (!on) continue;
        current = (await ctx.query('AllHeroRequest')).heroes?.find(h => h.heroId === id);
        if (!current) break;
        const cfg = ctx.rows(table).find(r => r[property] === (current.exclusive?.[property] ?? 0) + 1);
        if (!cfg || current.star < cfg.heroStar) continue;
        if (property === 'level') {
          // 当前专武星级决定等级上限；不能拿下一星的解锁等级提前升级。
          const cap = ctx.rows('ExclusiveStarCfg').find(r => r.star === (current.exclusive?.star ?? 0))?.unlockLv;
          if (!(cap > 0)) { skip(ctx, `${id} 缺少当前专武星级的等级上限`); continue; }
          if ((current.exclusive?.level ?? 0) >= cap) continue;
        }
        const heroCfg = ctx.rows('HeroCfg').find(r => r.id === id);
        // 升星配置列出各品质螺丝的可选价格，按物品表品质匹配当前英雄。
        const expenses = property === 'star' ? cfg.cost.filter(([item]) => ctx.rows('ItemCfg').find(r => r.id === item)?.quality === heroCfg?.quality) : [...cfg.cost];
        if (property === 'star') {
          if (!expenses.length) { skip(ctx, `${id} 缺少对应品质的专武升星材料`); continue; }
          const item = `${id}碎片`;
          const own = Math.min(ctx.stock.get(item) ?? 0, cfg.piece);
          if (cfg.piece > 0) expenses.push([item, own]);
          if (cfg.piece > own) {
            if (!options.universal || !heroCfg?.universalItemId) continue;
            expenses.push([heroCfg.universalItemId, cfg.piece - own]);
          }
        }
        await mutate(ctx, request, property === 'star' ? { heroId: id, universal: options.universal } : { heroId: id }, 'AllHeroRequest', s => s.heroes?.find(h => h.heroId === id)?.exclusive, { expenses, response: 'HeroExclusiveNextUpResponse' });
      }
      current = (await ctx.query('AllHeroRequest')).heroes?.find(h => h.heroId === id);
      if (options.skillAdvance) {
        const level = Math.max(0, ...(current.skillUpgrades ?? []));
        const rule = ctx.rows('HeroSkillAdvanceCfg').find(r => r.heroId === id && r.skillLv === level + 1 && r.season <= ctx.season);
        const cfg = ctx.rows('HeroSkillAdvanceCostCfg').find(r => r.level === level + 1);
        if (rule && cfg) await mutate(ctx, 'HeroSkillUpgradeRequest', { heroId: id }, 'AllHeroRequest', s => s.heroes?.find(h => h.heroId === id)?.skillUpgrades, { expenses: cfg.advanceCosts });
      }
      if (options.equipEnhance) for (const equip of current.equips ?? []) {
        const cap = ctx.rows('EquipAttrCfg').find(r => r.id === equip.equipId && Number(r.star) === equip.star)?.maxLv;
        const price = ctx.rows('EquipUpDecomposeCfg').find(r => r.level === equip.level + 1)?.upgradeCost;
        if (!cap || equip.level >= cap || price === undefined) continue;
        await mutate(ctx, 'EnhanceEquipRequest', { uid: idString(equip.uid) }, 'EquipsRequest', s => s.equip?.find(e => idString(e.uid) === idString(equip.uid)), { expenses: [['精铁', price]] });
      }
      if (options.badgeEnhance) for (const badge of current.badges ?? []) {
        if (options.badgeExpItemNum <= 0) break;
        const cap = ctx.rows('HeroBadgeAttrCfg').find(r => r.id === badge.badgeId && r.star === badge.star)?.maxLevel;
        if (!cap || badge.level >= cap) continue;
        await mutate(ctx, 'EnhanceBadgeRequest', { uid: idString(badge.uid), decomposeUid: [], expItemNum: options.badgeExpItemNum }, 'BadgesRequest', s => s.badge?.find(b => idString(b.uid) === idString(badge.uid)), { expenses: [['徽章经验', options.badgeExpItemNum]] });
      }
    }
    if (options.appoint) {
      // 逐位置指定已选择英雄，避免自动委任替用户消耗未选择英雄的资源。
      for (const [index, posId] of options.positions.entries()) {
        if (!selected[index]) break;
        await mutate(ctx, 'AppointHeroRequest', { heroId: selected[index], posId }, 'AppointInfoRequest', s => s.heroes);
      }
    }
  }
  if (options.watchSkillVideo) {
    // 当前生成协议没有导出 EAdvEffectId；客户端英雄广告业务 ID 为 4，并核对本版本配置。
    const type = ctx.protocol.AdvType?.ADV_EFFECT, id = 4;
    if (type === undefined || !ctx.rows('AdvEffectCfg').some(r => r.id === id)) skip(ctx, '缺少英雄广告配置');
    else {
      const before = JSON.stringify((await ctx.query('OnWaterRequest')).adv);
      await ctx.action('WatchAdvRequest', { type, id }, { confirm: async () => JSON.stringify((await ctx.query('OnWaterRequest')).adv) !== before });
    }
  }
  await recruits(ctx, options.recruit, false);
}

/** 招募仅使用免费次数或现有券，不把缺券自动转成钻石购买。 */
async function recruits(ctx, options, antique) {
  if (!options.free && !options.tickets && !options.points && !options.watchVideo) return;
  const group = antique ? 'antique' : 'hero';
  const info = (await ctx.query('RecruitInfoRequest'))[group];
  if (!info) return skip(ctx, '招募尚未开放');
  const request = antique ? 'AntiqueRecruitRequest' : 'RecruitStartRequest';
  const body = antique ? { type: ctx.protocol.AntiqueRecruitType.RECRUIT_ANTIQUE } : {};
  if (options.watchVideo) {
    // 广告收益 ID 是当前客户端业务枚举：招募英雄 2、藏品 7，不探测其他 ID。
    const id = antique ? 7 : 2, type = ctx.protocol.AdvType.ADV_EFFECT;
    const rule = ctx.rows('AdvEffectCfg').find(r => r.id === id);
    const status = (await ctx.query('OnWaterRequest')).adv?.find(a => a.id === id);
    if (rule && status && status.gotTimes < rule.dailyLimit) await mutate(ctx, 'WatchAdvRequest', { type, id }, 'OnWaterRequest', s => s.adv?.find(a => a.id === id));
  }
  if (options.free && info.freeEndTimeSeconds <= ctx.now() / 1000) await ctx.action(request, { ...body, way: ctx.protocol.RecruitWay.RECRUIT_FREE });
  if (options.tickets) await repeat(ctx, options.maxDraws, async () => {
    const item = antique ? '藏品券' : '抽卡券';
    if ((ctx.stock.get(item) ?? 0) < 1) return false;
    return succeeded(await ctx.action(request, { ...body, way: ctx.protocol.RecruitWay.RECRUIT_SINGLE }, { expenses: [[item, 1]] }));
  });
  if (options.points) await repeat(ctx, options.maxDraws, async () => {
    const data = (await ctx.query('RecruitInfoRequest'))[group];
    const cfg = ctx.rows(antique ? 'AntiqueRecruitTaskCfg' : 'HeroRecruitTaskCfg').find(r => r.season === ctx.season && r.id === (data.task?.gotId ?? 0) + 1);
    if (!cfg || !data.task || data.task.times < cfg.times) return false;
    return succeeded(await mutate(ctx, antique ? 'GotAntiqueRecruitTaskRequest' : 'GotHeroRecruitTaskRequest', {}, 'RecruitInfoRequest', s => s[group]?.task));
  });
}

/** 藏品激活、升星和套装分别校验当前碎片、成员与大师等级上限。 */
export async function antique(ctx, options) {
  if (options.activate) for (const row of ctx.rows('AntiqueBaseCfg')) {
    const state = await ctx.query('AllAntiqueRequest');
    if (state.antiques?.some(a => a.id === row.antiqueId) || !(row.activeFrag > 0)) continue;
    if (ctx.enough([[`${row.antiqueId}碎片`, row.activeFrag]])) await mutate(ctx, 'ActivateAntiqueRequest', { id: row.antiqueId }, 'AllAntiqueRequest', s => s.antiques, { expenses: [[`${row.antiqueId}碎片`, row.activeFrag]] });
  }
  if (options.upgrade) await repeat(ctx, 50, async () => {
    let progressed = false;
    for (const entry of (await ctx.query('AllAntiqueRequest')).antiques ?? []) {
      const base = ctx.rows('AntiqueBaseCfg').find(r => r.antiqueId === entry.id);
      const star = ctx.rows('AntiqueStarCfg').find(r => r.star === entry.star + 1);
      const need = star?.[COLOR_COST[base?.color]], own = ctx.stock.get(`${entry.id}碎片`) ?? 0;
      if (!(need > 0)) continue;
      const expenses = [[`${entry.id}碎片`, Math.min(own, need)]];
      if (own < need) { if (!options.universal || !base.universalItemId) continue; expenses.push([base.universalItemId, need - own]); }
      if (!ctx.enough(expenses)) continue;
      const result = await mutate(ctx, 'AntiqueStarUpRequest', { id: entry.id, universal: own < need }, 'AllAntiqueRequest', s => s.antiques?.find(a => a.id === entry.id), { expenses });
      if (!succeeded(result)) return false;
      progressed = true;
    }
    return progressed;
  });
  if (options.suit.activate || options.suit.levelUp) for (const row of ctx.rows('AntiqueSuitCfg')) await repeat(ctx, 50, async () => {
    const state = await ctx.query('AllAntiqueRequest');
    const suit = state.suits?.find(s => s.id === row.suitId);
    let expenses = [];
    if (!suit) {
      if (!options.suit.activate) return false;
      const members = ctx.rows('AntiqueBaseCfg').filter(r => r.suitId === row.suitId);
      const owned = members.filter(m => state.antiques?.some(a => a.id === m.antiqueId)).length;
      if (!members.length || owned < (row.colorIndex >= 4 ? 2 : members.length)) return false;
    } else {
      if (!options.suit.levelUp) return false;
      const cap = ctx.rows('AntiqueMasterLvCfg').find(r => r.level === state.masterLv)?.maxSuitLv;
      const cfg = ctx.rows('AntiqueSuitLvCfg').filter(r => r.color === row.color && r.maxLevel >= suit.level + 1).sort((a, b) => a.maxLevel - b.maxLevel)[0];
      if (!cap || suit.level >= cap || !cfg) return false;
      expenses = cfg.costArr;
      if (!ctx.enough(expenses)) return false;
    }
    return succeeded(await mutate(ctx, 'AntiqueSuitLevelUpRequest', { id: row.suitId }, 'AllAntiqueRequest', s => s.suits, { expenses }));
  });
  await recruits(ctx, options.recruit, true);
}

/** 宠物培育、喂养和战备室培养只操作服务端给出的队列及材料需求。 */
export async function pet(ctx, options) {
  let water = await ctx.query('OnWaterRequest');
  if (options.claim && water.building?.some(b => b.petBreed?.maturePets?.length)) await mutate(ctx, 'GetMaturePetRequest', {}, 'OnWaterRequest', s => s.building?.map(b => b.petBreed));
  water = await ctx.query('OnWaterRequest');
  const petBuildingTypes = new Set(ctx.rows('BuildingCfg').filter(row => row.name === '宠物').map(row => row.buildingType));
  const resolveBuildingType = makeTypeResolver(ctx.config);
  if (options.breed && !petBuildingTypes.size) skip(ctx, '缺少宠物建筑配置，跳过培育');
  for (const building of water.building ?? []) {
    const breed = building.petBreed;
    if (breed && options.feed) for (const job of breed.breedQ ?? []) {
      if (job.feedRequirements?.length && ctx.enough(costs(job.feedRequirements, ctx.protocol))) await mutate(ctx, 'PetFeedRequest', { jobIdx: job.idx }, 'OnWaterRequest', s => s.building?.find(b => b.buildingId === building.buildingId)?.petBreed, { expenses: costs(job.feedRequirements, ctx.protocol) });
    }
    // OnWater 会给普通建筑下发默认 petBreed；培育请求不带 buildingId，只能读取真实宠物建筑的全局队列。
    if (breed && options.breed && petBuildingTypes.has(resolveBuildingType(building.buildingId))) {
      const quality = ctx.rows('PetBreedCfg').find(r => r.quality === options.breedMinQuality)?.qualityIndex;
      const species = ctx.rows('PetSpeciesCfg').filter(r => options.breedSpecies.includes(r.name)).map(r => r.spId);
      if (options.breedMinQuality && quality === undefined) { skip(ctx, '宠物培育品质无效'); continue; }
      const candidates = ctx.rows('PetBreedCfg').filter(r => (!options.breedSpecies.length || species.includes(r.spId)) && (quality === undefined || r.qualityIndex <= quality) && r.season <= ctx.season).sort((a, b) => b.qualityIndex - a.qualityIndex);
      const availableSlots = Math.max(0, breed.maxQLength - (breed.breedQ?.length ?? 0));
      if (!availableSlots) { skip(ctx, '宠物培育队列已满'); continue; }
      await repeat(ctx, availableSlots, async () => {
        const row = candidates.find(r => ctx.enough(r.cost));
        if (!row) return false;
        return succeeded(await mutate(ctx, 'PetBreedRequest', { petId: row.petId, universal: options.universal }, 'OnWaterRequest', s => s.building?.find(b => b.buildingId === building.buildingId)?.petBreed, { expenses: row.cost }));
      });
    }
    if (!amount(building.petServe?.petUid)) continue;
    if (options.levelUp) await repeat(ctx, 100, async () => {
      const current = (await ctx.query('AllPetRequest')).pets?.find(p => idString(p.uid) === idString(building.petServe.petUid));
      if (!current || current.level >= options.levelUpTargetLevel) return false;
      const cfg = ctx.rows('PetLevelCfg').find(r => r.level === current.level + 1);
      if (!cfg || cfg.playerLevel > ctx.player.level || !ctx.enough([cfg.cost])) return false;
      return succeeded(await mutate(ctx, 'PetLevelUpRequest', { buildingId: building.buildingId }, 'AllPetRequest', s => s.pets, { expenses: [cfg.cost] }));
    });
    if (options.advance && (!options.advanceRooms.length || options.advanceRooms.includes(building.buildingId))) {
      await repeat(ctx, 20, async () => {
        const serve = (await ctx.query('OnWaterRequest')).building?.find(b => b.buildingId === building.buildingId)?.petServe;
        const expenses = costs(serve?.upgradeRequirements, ctx.protocol);
        if (!expenses.length || !ctx.enough(expenses)) return false;
        return succeeded(await mutate(ctx, 'PetUpgradeFeedRequest', { buildingId: building.buildingId }, 'AllPetRequest', s => s.pets, { expenses }));
      });
      const serve = (await ctx.query('OnWaterRequest')).building?.find(b => b.buildingId === building.buildingId)?.petServe;
      if (serve && !serve.upgradeRequirements?.length) await mutate(ctx, 'PetUpgradeRequest', { buildingId: building.buildingId }, 'AllPetRequest', s => s.pets);
      else skip(ctx, '宠物进阶所需喂养尚未完成');
    }
  }
  if (options.decompose) await destroy(ctx, options, true);
}

/** 破坏性操作需要明确品质阈值，排除用户保护、穿戴、驻守和编队中的对象。 */
async function destroy(ctx, options, pets) {
  const table = pets ? 'PetBreedCfg' : 'EquipCfg', key = pets ? 'petId' : 'id';
  const threshold = ctx.rows(table).find(r => r.quality === options.decomposeBelowQuality)?.qualityIndex;
  if (!(threshold > 0)) return skip(ctx, '放生/分解必须配置有效品质阈值');
  const heroes = await ctx.query('AllHeroRequest');
  const water = await ctx.query('OnWaterRequest');
  const protectedIds = new Set(options.protectedUids.map(String));
  const references = pets ? referencedIds(water, 'petUid') : referencedIds(heroes, 'uid');
  if (pets) {
    // 海面建筑包含舰队实例编队；世界舰队只含 petId，不能据此保护实例。
    const fleets = (await ctx.query('MyFleetsRequest')).fleets ?? [];
    const formations = water.building?.filter(b => b.fleet?.formation) ?? [];
    if (fleets.some(f => f.petId && !formations.some(b => b.buildingId === f.buildingId))) return skip(ctx, '舰队宠物编队不完整，暂停放生');
    const form = await ctx.query('GetFormationRequest', { module: ctx.protocol.FormationModule.MAINLINE });
    referencedIds(form, 'petUid', references);
    referencedIds((await ctx.query('LeagueInfoRequest')).ownFormations, 'petUid', references);
    referencedIds((await ctx.query('ExpeditionInfoRequest')).formation, 'petUid', references);
    referencedIds((await ctx.query('TournamentFormationRequest')).team, 'petUid', references);
    referencedIds(await ctx.query('UltraInfoRequest'), 'petUid', references);
  }
  const query = pets ? 'AllPetRequest' : 'EquipsRequest', field = pets ? 'pets' : 'equip';
  const entries = (await ctx.query(query))[field] ?? [];
  const ids = entries.filter(item => {
    const quality = ctx.rows(table).find(r => r[key] === item[pets ? 'petId' : 'equipId'])?.qualityIndex;
    return quality !== undefined && quality < threshold && !references.has(idString(item.uid)) && !protectedIds.has(idString(item.uid));
  }).map(item => idString(item.uid));
  if (ids.length) await mutate(ctx, pets ? 'FreePetRequest' : 'DecomposeEquipRequest', pets ? { petUid: ids } : { uid: ids }, query, s => s[field]);
}

/** 装备领取后刷新制造状态，只有用户选择且材料足够的配方才开工。 */
export async function equip(ctx, options) {
  const water = await ctx.query('OnWaterRequest');
  for (const b of water.building ?? []) {
    if (!b.equipMaking) continue;
    let making = b.equipMaking;
    if (options.speedUp && making.makeId && making.finishTime - ctx.now() / 1000 >= options.speedUpMinRemainSecs && (ctx.stock.get('加速器') ?? 0) > 0) await ctx.action('SpeedMakeEquipRequest', { buildingId: b.buildingId, speedUp: { type: 2, useNum: 1 } }, { expenses: [['加速器', 1]] });
    making = (await ctx.query('OnWaterRequest')).building?.find(r => r.buildingId === b.buildingId)?.equipMaking;
    if (options.collect && making?.makeId && making.finishTime <= ctx.now() / 1000) await ctx.action('PickMadeEquipRequest', { buildingId: b.buildingId });
    making = (await ctx.query('OnWaterRequest')).building?.find(r => r.buildingId === b.buildingId)?.equipMaking;
    if (options.make && !making?.makeId) {
      const row = ctx.rows('BuildingEquipMakeCfg').find(r => options.makeIds.includes(r.makeId) && r.season <= ctx.season && ctx.enough(r.costItem));
      if (row) await mutate(ctx, 'MakeEquipRequest', { buildingId: b.buildingId, makeId: row.makeId, universal: options.universal }, 'OnWaterRequest', s => s.building?.find(r => r.buildingId === b.buildingId)?.equipMaking, { expenses: row.costItem });
    }
  }
  if (options.decompose) await destroy(ctx, options, false);
}

/** 根据远征对象解析服务端已经下发的博物馆条件；空闲关卡没有条件时返回 null。 */
function museumCondition(ctx, expedition) {
  const conditionId = amount(expedition?.conditionId);
  if (!(conditionId > 0)) return null;
  return ctx.rows('MuseumExpeditionConditionCfg').find(row => amount(row.conditionId) === conditionId) ?? null;
}

/** 读取英雄配置并合并运行时状态，供博物馆条件匹配使用。 */
function museumHeroEntries(ctx, heroes, preferredHeroIds) {
  const heroRows = ctx.rows('HeroCfg');
  const byId = new Map(heroRows.map(row => [idString(row.id), row]));
  const preferred = new Map(preferredHeroIds.map((heroId, index) => [heroId, index]));
  const entries = (heroes ?? []).map(hero => {
    const heroId = idString(hero.heroId);
    const config = byId.get(heroId) ?? {};
    return { heroId, hero, config, preferred: preferred.get(heroId) ?? Number.MAX_SAFE_INTEGER };
  }).filter((entry, index, all) => entry.heroId && all.findIndex(item => item.heroId === entry.heroId) === index);
  // 某些查询结果只提供主线编队；保留这些 ID，避免本次分配无谓依赖完整英雄快照。
  for (const [heroId, index] of preferred) {
    if (!entries.some(entry => entry.heroId === heroId)) entries.push({ heroId, hero: { heroId }, config: byId.get(heroId) ?? {}, preferred: index });
  }
  return entries;
}

/** 计算英雄对单个博物馆条件的匹配等级，职业/阵营优先于星级和品质。 */
function museumHeroRank(entry, condition) {
  if (!condition) return [entry.preferred < Number.MAX_SAFE_INTEGER ? 1 : 0, amount(entry.hero.star), amount(entry.config.qualityIndex), amount(entry.hero.power), -entry.preferred];
  const careerMatch = !condition.careerLimit || entry.config.career === condition.careerLimit;
  const factionMatch = !condition.factionLimit || entry.config.faction === condition.factionLimit;
  const star = amount(entry.hero.star);
  const quality = amount(entry.config.qualityIndex ?? entry.hero.qualityIndex);
  // 条件表使用累计星值（5/10/15...），英雄状态使用显示星级（1/2/3...）。
  const requiredStar = Math.ceil(amount(condition.heroStar) / 5);
  const starMatch = star >= requiredStar;
  const qualityMatch = quality >= amount(condition.heroQualityIndex);
  const fullMatch = careerMatch && factionMatch && starMatch && qualityMatch;
  return [fullMatch ? 1 : 0, careerMatch ? 1 : 0, factionMatch ? 1 : 0, starMatch ? 1 : 0, qualityMatch ? 1 : 0, star, quality, amount(entry.hero.power), -entry.preferred];
}

/** 按条件选择一个关卡的英雄；条件不足时仍优先保留职业/阵营匹配者。 */
function selectMuseumHeroes(ctx, stage, entries, usedHeroIds) {
  const condition = museumCondition(ctx, stage.expedition);
  const targetCount = Math.max(1, amount(condition?.heroCount) || 3);
  const available = entries.filter(entry => !usedHeroIds.has(entry.heroId));
  available.sort((a, b) => {
    const left = museumHeroRank(a, condition), right = museumHeroRank(b, condition);
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return a.heroId.localeCompare(b.heroId);
  });
  return { condition, heroIds: available.slice(0, targetCount).map(entry => entry.heroId), targetCount };
}

/**
 * 读取服务端为当前空闲探宝关卡保留的启动消耗，并确认本地库存足够。
 *
 * 空闲关卡没有消耗时无法从配置表推导本轮随机材料；跳过比猜测材料后触发
 * MuseumStartExploreRequest 的 not enough items 更安全。
 *
 * @param {import('./context.mjs').AutomationContext} ctx 当前自动化上下文。
 * @param {object} expedition 当前关卡的远征状态。
 * @returns {Array<[string, number]>|null} 已知且库存足够的消耗；未知或不足时返回 null。
 */
function museumStartCosts(ctx, expedition) {
  const expenses = costs(expedition?.cost?.asset, ctx.protocol);
  // 服务端未下发有效正数成本时，无法证明本次启动所需材料；不要把 0 或未知资源当成可发送依据。
  if (!expenses.length || !expenses.every(([item, num]) => item && Number.isFinite(num) && num > 0) || !ctx.enough(expenses)) return null;
  return expenses;
}

/** 博物馆探宝按加速、完成、领奖、开新的真实状态顺序推进。 */
export async function museum(ctx, options) {
  let state = await ctx.query('MuseumInfoRequest');
  if (options.collectRevenue && amount(state.uncollectedRevenue) > 0) await ctx.action('MuseumCollectRevenueRequest');
  for (const stage of state.exploreStages ?? []) {
    if (options.maps.length && !options.maps.includes(stage.stageId)) continue;
    let expedition = stage.expedition;
    if (options.speedUp && expedition?.endTime > ctx.now() / 1000 && options.speedUpDailyLimit > ctx.count('museum.speed') && (ctx.stock.get('博物馆加速') ?? 0) > options.speedUpKeepStock) {
      const result = await ctx.action('MuseumSpeedUpExploreRequest', { stageId: stage.stageId, useNum: 1 }, { expenses: [['博物馆加速', 1]] });
      if (result.status === 'success') ctx.count('museum.speed', 1);
      expedition = (await ctx.query('MuseumInfoRequest')).exploreStages?.find(s => s.stageId === stage.stageId)?.expedition;
    }
    if (expedition?.endTime > 0 && expedition.endTime <= ctx.now() / 1000) {
      if (!succeeded(await ctx.action('MuseumCompleteExploreRequest', { stageId: stage.stageId }))) continue;
      await ctx.action('MuseumRewardRequest', { stageId: stage.stageId });
    }
  }
  if (!options.explore) return;
  const factor = ctx.rows('MuseumExploreTimeFactorCfg').find(r => r.factor === options.factor && r.playerLevel <= ctx.player.level);
  if (!factor) return skip(ctx, '探宝倍率未开放');
  const formation = (await ctx.query('GetFormationRequest', { module: ctx.protocol.FormationModule.MAINLINE })).formation;
  const preferredHeroIds = [...new Set((formation?.heroPositions ?? []).map(h => idString(h.heroId)).filter(Boolean))];
  state = await ctx.query('MuseumInfoRequest');
  const stages = (state.exploreStages ?? []).filter(stage => !stage.expedition?.startTime && (!options.maps.length || options.maps.includes(stage.stageId)));
  if (!stages.length) return;

  // 服务端会锁定探宝中的英雄；先排除已有远征，再把候选分给空闲关卡，避免重复派出同一英雄。
  const occupiedHeroIds = new Set((state.exploreStages ?? []).flatMap(stage => stage.expedition?.heroIds ?? []).map(idString).filter(Boolean));
  const allHeroes = (await ctx.query('AllHeroRequest')).heroes ?? [];
  const entries = museumHeroEntries(ctx, allHeroes, preferredHeroIds).filter(entry => !occupiedHeroIds.has(entry.heroId));

  const usedHeroIds = new Set(occupiedHeroIds);
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    const remainingStages = stages.length - index;
    const selection = selectMuseumHeroes(ctx, stage, entries, usedHeroIds);
    const availableCount = entries.filter(entry => !usedHeroIds.has(entry.heroId)).length;
    // 每个关卡至少分到一名英雄；剩余英雄尽量按条件人数或三名上限平均分配。
    const take = Math.min(selection.targetCount, Math.max(1, Math.floor(availableCount / remainingStages)));
    const heroIds = selection.heroIds.slice(0, take);
    if (!heroIds.length) {
      skip(ctx, `关卡 ${stage.stageId} 没有可用探宝英雄`);
      continue;
    }
    const expenses = museumStartCosts(ctx, stage.expedition);
    if (!expenses) {
      skip(ctx, `关卡 ${stage.stageId} 缺少探宝消耗或库存不足`);
      continue;
    }
    const result = await ctx.action('MuseumStartExploreRequest', { stageId: stage.stageId, heroIds, factor: options.factor }, { expenses });
    if (succeeded(result)) heroIds.forEach(heroId => usedHeroIds.add(heroId));
    // 服务端拒绝或结果未确认时停止后续开探，避免继续发送相同状态下的请求。
    if (result.status === 'rejected' || result.status === 'uncertain') break;
  }
}

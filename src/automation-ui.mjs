// 与现有控制台同一 DOM 和确认框，设置表单不引入框架或另一套账号状态。
export const AUTOMATION_SCRIPT = String.raw`
let automationSettings = null;
let automationAccount = null;
let automationRunning = false;
let automationOptions = null;
const automationLabels = {
  season:'当前赛季',vipFreeAd:'VIP免广告',spending:'钻石消费',enabled:'开启',dailyLimit:'每日总额度',minRubyStock:'最低钻石保留量',modules:'各模块每日额度',
  collect:'领取产物',finish:'自动竣工',build:'自动建造',upgrade:'自动升级',speedUp:'使用加速道具',disabledBuildings:'禁用建筑',factory:'工厂',gain:'领取成品',autoProduce:'自动生产',products:'工厂产品（建筑类型 → 产品）',disabledFactories:'禁用工厂',priorityProduce:'需求优先生产',proposedPriority:'需求顺序',speedUpForDemand:'为需求加速',
  harvest:'收割',plant:'种植',cropPriorities:'作物优先级（数字越小越优先）',cropKeepStock:'作物库存水位',priorityPlant:'订单需求优先',seedOnDemand:'缺种子时安排生产',speedUpMaxActions:'每轮最多加速次数',orderReward:'领取订单档位奖',blockedMaterials:'禁止交单材料',skipCropOrders:'跳过作物订单',minExp:'最低经验奖励',minGold:'最低金币奖励',dailyCap:'每日次数上限（0 不设本地上限）',fill:'装填货船',reward:'领取奖励',optionIndex:'选择选项（1 或 2）',
  fishing:'钓鱼',maxFishCasts:'每轮最多钓鱼次数',floater:'拾取浮漂',floaterCollectWhenFull:'满仓仍收取浮漂',openChests:'使用钥匙开箱',maxChests:'每轮最多开箱次数',diving:'潜水',divingEach:'每种潜水材料数量',salvage:'拾荒',salvageEach:'每种拾荒材料数量',enhance:'采集强化',enhanceTargetLevel:'强化目标等级',claim:'领取',levelUp:'升级',levelReward:'领取等级奖励',claimAfterHours:'累计挂机几小时后领取',
  heroes:'指定英雄',levelUpMaxActions:'每轮升级轮数',starUp:'升星',skillLevelUp:'技能升级',skillAdvance:'技能进阶',exclusiveLevelUp:'专武升级',exclusiveStarUp:'专武升星',equipEnhance:'强化所选英雄装备',badgeEnhance:'强化所选英雄徽章',badgeExpItemNum:'徽章经验道具数量',appoint:'委任',positions:'委任位置（按英雄顺序）',watchSkillVideo:'请求英雄广告奖励',universal:'允许万能材料',fragRecruit:'使用碎片招募所选英雄',recruit:'招募',free:'免费次数',tickets:'使用现有券',points:'领取招募积分奖',maxDraws:'每轮最多抽取次数',activate:'激活',suit:'套装',
  breed:'培育',breedSpecies:'培育物种名称',breedMinQuality:'培育最低品质',feed:'喂养',decompose:'放生 / 分解',decomposeBelowQuality:'只处理低于此品质的闲置对象',protectedUids:'保护对象 UID',levelUpTargetLevel:'培养目标等级',advance:'进阶',advanceRooms:'进阶战备室建筑 ID（空为全部）',make:'打造',makeIds:'打造配方 ID',speedUpMinRemainSecs:'剩余秒数达到此值才加速',collectRevenue:'领取博物馆收益',explore:'开新探宝',factor:'探宝倍率',maps:'探宝地图 ID',speedUpDailyLimit:'每日加速次数上限（0 禁止）',speedUpKeepStock:'加速道具保留数量',
  maxActions:'每轮最多挑战次数',stage:'主线',samePowerRetryCount:'同战力战败重试次数',claimReward:'领取章节奖励',arena:'竞技场',sweep:'扫荡',challenge:'挑战',trial:'试炼',heroExp:'英雄经验试炼',forge:'强化石试炼',petExp:'宠物经验试炼',rubySweep:'允许钻石扫荡',league:'联盟赛',reservePoints:'保留积分',hangupReward:'领取挂机奖励',danReward:'领取段位奖励',passReward:'领取战令奖励',expedition:'远征',finalReward:'领取最终奖励',freePass:'领取远征战令',challengeStopOnHeroDeath:'英雄阵亡时停止',challengeMinTeamHpPct:'最低队伍血量百分比',
report:'领取战报',fleet:'舰队',repair:'维修',repairThresholds:'各舰队维修耐久阈值（按列表顺序）',repairSpeedUp:'加速维修（可使用钻石）',repairSpeedUpMinRemainSecs:'维修加速剩余秒数门槛',pirate:'海盗',attack:'挑战',attackTypes:'挑战海盗类型',sweepTypes:'扫荡海盗类型',attackTime:'执行时段',start:'开始时间',end:'结束时间',radar:'雷达',kinds:'雷达事件类型',fixed:'固定事件',resField:'已有资源田配比',oasis:'种子田权重',tank:'汽油田权重',chipMine:'芯片矿',hours:'上海小时（空为全天）',fleets:'舰队规则',treasureLoot:'宝藏掠夺',merchantShip:'搁浅商船（万吨货轮）',retryMinutes:'重新夺取间隔（分钟，0 不重试）',cityWar:'城战',online:'领取在线奖',reattack:'允许重复进攻',worldBoss:'世界 Boss',attackTimes:'每轮挑战次数',limitedBoss:'限时 Boss',challenge:'挑战',challengeReward:'领取挑战奖',trade:'海商王',profitLimit:'航行加速最低累计利润',speedUpDailyLimit:'每日航行加速次数',
  packs:'联盟礼包',guild:'联盟礼包',title:'职级奖励',order:'募兵订单',cityIds:'城市 ID',aid:'互助',receive:'领取帮助',ask:'发起求助',askItems:'求助物品',help:'帮助盟友',helpItems:'帮助物品',helpNicknameKeywords:'盟友昵称关键词',helpMinStock:'帮助后库存保留门槛',helpDailyLimit:'每日帮助次数',tech:'联盟科技',items:'科技 ID',ship:'联盟商船',captain:'应聘船长',crew:'补货登船',qualities:'船只品质',rewardItems:'期望奖励物品',minWaterCoin:'最低水姆币奖励',forbiddenMaterials:'禁用补货材料',relaxFilters:'允许放宽品质与奖励筛选',
  daily:'免费日奖与已有卡权益',weeklyLottery:'周抽奖（领取免费礼包）',uniqueLottery:'每周专属抽奖（领取免费次数）',dailyTask:'任务与活跃度奖励',growth:'成长、支线与成就',events:'成长活动奖励',email:'邮件奖励',midAutumn:'中秋日奖',signIn:'签到',freeGift:'免费礼包',activeReward:'活跃奖励',blindBox:'盲盒',scoreReward:'积分奖',play:'开始新局',keepCards:'保留盲盒卡',catcher:'海底捞月',repeat:'重复挑战最高开放关卡',keepHooks:'保留捞月钩',maxStage:'最高关卡',sweepStage:'扫荡关卡',workshop:'活动工坊',produce:'生产',keepStock:'备货目标',keepClaws:'保留爪钩',blessing:'祝福',boost:'消耗福运结祝福',skinId:'祝福皮肤 ID',boostTimes:'每次祝福数量',keepKnots:'保留福运结',weekOrder:'不差钱商人',buyMissingMaterials:'允许钻石补齐整单缺料',weekLottery:'幸运转盘',prize:'使用现有转盘币',pve:'水世界牌 PVE',freeMatch:'免费匹配',diamondMatch:'允许钻石匹配',diamondMatchDailyLimit:'每日钻石匹配次数上限（0 禁止）',matchWindows:'匹配时段',dailies:'原有付费日常'
};
// 酆都玩法沿用活动模块，只增加本期参与开关。
automationLabels.edict = '酆都捞尸人';
// 模块名与设置字段分表维护，避免 guild 等同名字段在加载服务端模块标签后被覆盖。
const automationModuleLabels = { island:'建筑与工厂',farm:'农田',resident:'居民订单',cargo:'货船',choiceEvent:'选择事件',gather:'采集',afk:'挂机收益',hero:'英雄',antique:'藏品',pet:'宠物',equip:'装备',museum:'博物馆',battle:'挑战',world:'世界',guild:'联盟',welfare:'福利',activity:'活动',snap:'水世界牌' };
const numericArrays = new Set(['positions','makeIds','maps','hours','attackTypes','sweepTypes','cityIds','items','repairThresholds']);
const objectArrays = new Set(['fleets','matchWindows']);
const dictionarySettings = new Set(['products','cropPriorities','cropKeepStock']);
Object.assign(automationLabels,{breedMinQuality:'培育最高品质',watchVideo:'领取招募广告收益',giveUpPve:'放弃当前 PVE 对局',cancelMatchmaking:'取消当前匹配队列',helpAlly:'允许帮助己方联盟',pvpTrustee:'真人对局使用托管',helpMinStock:'帮助前最低库存门槛',attackTimes:'每日挑战次数上限'});
Object.assign(automationLabels,{fastTimeSecs:'第一档耗时上限（秒）',shortTimeSecs:'第二档耗时上限（秒）',fastStockLow:'第一档补货低水位',fastStockHigh:'第一档补货高水位',shortStockLow:'第二档补货低水位',shortStockHigh:'第二档补货高水位',priorityBurstLimit:'连续短料优先件数上限',reorderQueue:'允许重排未开工队列'});

// 文案按完整设置路径区分同名字段，避免把“余额保留量”误读成“每日额度”。
const automationSettingCopy = {
  'modules.activity.edict.enabled': { note:'入场券足够时参与一局，每张符文先显化一次，再竞猜并结算。每次执行最多一局，已有局优先续接。' },
  season: { note:'赛季 0 不执行依赖赛季配置的玩法；填写当前赛季后，赛季城市和科技等候选项才会刷新。' },
  vipFreeAd: { note:'仅当前连接角色等级达到 10 级且 VIP 达到 3 级时显示。开启后，在挑战模块已启用、对应试炼已通关且广告额度未用尽时，自动领取英雄经验、强化石、宠物经验试炼的每日免广告额外扫荡奖励，无需开启钻石扫荡。工厂生产广告加速、建筑升级广告加速、英雄广告招募、藏品广告招募和广告商店奖励暂未接入此开关。' },
  spending: { note:'这是所有钻石操作的共同护栏，不会自行触发消费；每一次消费都要同时通过总开关、总额度、模块额度和余额保留量。' },
  'spending.enabled': { note:'只允许已经在玩法中勾选的钻石操作；关闭时任何模块都不会花钻石。' },
  'spending.dailyLimit': { note:'同一账号所有角色在上海自然日内合计的消费上限，已确认消费和结果未确认的预留都会占用；0 禁止全部钻石消费。' },
  'spending.minRubyStock': { note:'当前角色游戏内钻石余额的下限，不是每日可用额度。每次消费后（含未确认预留）余额仍须不少于此值；10000 会按原值保存。' },
  'spending.modules': { note:'各玩法在上海自然日内的独立额度，同一账号的所有角色合计；它还必须不超过“每日总额度”，设置更高不会增加总额度。' },
  'modules.world.fleet.repairSpeedUp': { note:'仅对城战规则中已启用的舰队生效，优先使用现有加速器；无道具或道具被明确拒绝、业务失败时改用钻石。剩余分钟数向上取整，每分钟 10 钻：60 秒 10 钻，61 秒 20 钻；提交前按完整费用检查钻石总额度、模块额度和余额保留量。' },
  'modules.world.fleet.repairSpeedUpMinRemainSecs': { note:'维修剩余时间达到此秒数才尝试加速，避免为即将结束的维修消耗道具或钻石。' },
  'modules.world.trade.speedUpDailyLimit': { note:'上海自然日内最多加速航行的次数；0 表示不允许该玩法的航行加速。每次使用 1 个海商王加速道具，不会使用钻石。' },
  'modules.world.trade.profitLimit': { note:'累计贸易利润不低于此值时才允许航行加速；0 表示利润非负时即可加速。仍需开启航行加速并满足每日次数上限，不影响卖货、买货、迁船或领取奖励。' },
  'modules.museum.speedUpKeepStock': { note:'博物馆加速道具的背包保留数量。库存必须严格高于此值才会使用一个加速道具。' },
  'modules.activity.weekOrder.buyMissingMaterials': { note:'只在一整单缺少的材料都能查到钻石价格时补购；价格缺失、任一额度不足或保留量不足都会跳过整单。' },
  'modules.activity.weekOrder.minRubyStock': { title:'整单补料后最低钻石保留量', note:'只约束“不差钱商人”的缺料补购：补齐这一单后当前角色余额不能低于此值。它是额外护栏，不能替代顶部的全局保留量。' },
  'modules.snap.diamondMatch': { note:'仅在免费匹配次数已用完且处于允许时段时，才会尝试钻石匹配；每局仍需通过钻石消费护栏。' },
  'modules.snap.diamondMatchDailyLimit': { note:'当前角色在上海自然日内最多发起的钻石匹配次数；0 禁止钻石匹配，不影响免费匹配。' },
  'modules.snap.matchWindows': { note:'使用上海时间。留空时沿用活动配置的开放时段；填写后只在这些时段内匹配。' },
  'modules.resident.dailyCap': { note:'当前角色在上海自然日内处理居民订单的本地次数上限；0 不设本地上限，游戏服务端仍可能限制次数。' },
  'modules.guild.order.dailyLimit': { note:'当前角色在上海自然日内最多完成的联盟募兵订单；0 不设本地上限。' },
  'modules.guild.aid.helpMinStock': { note:'帮助盟友前，自己的该物品库存必须至少达到此数量；帮助后库存可能低于该值。' },
  'modules.guild.aid.helpDailyLimit': { note:'当前角色在上海自然日内最多帮助盟友的次数；0 不设本地上限。' },
};

// 每个折叠组先交代实际处理的玩法和资源边界，字段说明再补充该项如何改变本组行为。
const automationFeatureCopy = {
  'spending.modules': { action:'为每个自动化模块设置钻石日额度', scope:'同一账号的所有角色合计；每个模块额度还会受顶部每日总额度限制' },
  'modules.island': { action:'收取建筑产物、完成竣工、建造、升级与普通工厂排产', scope:'当前角色海面上的普通建筑和工厂；历史活动工坊不在本组范围' },
  'modules.island.factory': { action:'领取普通工厂成品、安排生产、自动生产和需求优先排产', scope:'当前角色的普通工厂；禁用工厂不会被本组重新开工' },
  'modules.farm': { action:'收割成熟农田、按水位种植、补种子和使用农田加速', scope:'当前角色已拥有的农田；不扫描或新建资源田' },
  'modules.resident': { action:'处理居民订单与订单进度奖励', scope:'当前角色当前可见的居民订单；材料不足只跳过，不会购买材料' },
  'modules.cargo': { action:'装填货船并领取完成奖励', scope:'当前角色当前列表中的货船；只补未填满的舱位' },
  'modules.choiceEvent': { action:'选择当前出现的二选一事件', scope:'当前角色当前未解决的选择事件；只会提交配置的一个选项' },
  'modules.gather': { action:'钓鱼、拾取浮漂、开箱、潜水、拾荒和采集强化', scope:'当前角色的海面采集与已有采集资源；不会购买钥匙或采集材料' },
  'modules.gather.enhance': { action:'提升钓鱼、潜水和拾荒等级', scope:'当前角色的对应采集技能；达到目标等级或资源不足就停止' },
  'modules.afk': { action:'领取累计挂机收益、升级挂机等级和领取等级奖励', scope:'当前角色的挂机进度；领取阈值按服务器累计时间判断' },
  'modules.hero': { action:'培养、委任、招募和强化明确选择的英雄', scope:'当前角色在“指定英雄”中选择的英雄；未选择英雄不会消耗培养资源' },
  'modules.hero.recruit': { action:'使用免费次数或已有招募券，并领取招募积分与广告奖励', scope:'当前角色的英雄招募；不会购买招募券' },
  'modules.antique': { action:'激活、升星和培养藏品', scope:'当前角色已有或可激活的藏品；万能材料必须单独授权' },
  'modules.antique.suit': { action:'激活或升级藏品套装', scope:'当前角色满足成员和大师等级条件的套装' },
  'modules.antique.recruit': { action:'使用免费次数或已有藏品招募券', scope:'当前角色的藏品招募；不会购买抽取次数' },
  'modules.pet': { action:'领取、培育、喂养、升级、进阶和放生宠物', scope:'当前角色宠物；放生会排除阵容、舰队、远征等已引用宠物' },
  'modules.equip': { action:'领取打造完成的装备、按配方打造、加速和分解闲置装备', scope:'当前角色装备与装备制造台；不会处理未选择或未开放的配方' },
  'modules.museum': { action:'领取博物馆收益、结算探宝、领奖、开新探宝和道具加速', scope:'当前角色博物馆关卡与可用英雄；每名英雄在同轮最多分配到一个探宝关卡' },
  'modules.battle': { action:'处理主线、竞技场、试炼、联盟赛与远征', scope:'当前角色当前开放的战斗内容；失败或读回异常会停止对应战斗链' },
  'modules.battle.stage': { action:'连续挑战主线并领取章节奖励', scope:'当前角色已开放的主线关卡；失败不会继续推进后续关卡' },
  'modules.battle.arena': { action:'挑战或扫荡竞技场', scope:'当前角色当前可挑战的竞技场目标；胜负以服务器结果为准' },
  'modules.battle.trial.heroExp': { action:'挑战或扫荡英雄经验试炼', scope:'当前角色开放的英雄经验试炼；钻石扫荡仍受钻石消费护栏限制' },
  'modules.battle.trial.forge': { action:'挑战或扫荡强化石试炼', scope:'当前角色开放的强化石试炼；钻石扫荡仍受钻石消费护栏限制' },
  'modules.battle.trial.petExp': { action:'挑战或扫荡宠物经验试炼', scope:'当前角色开放的宠物经验试炼；钻石扫荡仍受钻石消费护栏限制' },
  'modules.battle.league': { action:'挑战联盟赛并领取挂机、段位和战令奖励', scope:'当前角色联盟赛；挑战会保留配置积分，不会为凑次数消耗积分' },
  'modules.battle.expedition': { action:'挑战或扫荡远征，并领取最终奖励和现有战令权益', scope:'当前角色当前选择的远征副本；阵亡或低血量会按设置停止挑战' },
  'modules.world': { action:'处理战报、舰队、海盗、雷达、资源田、世界活动与贸易', scope:'当前角色世界地图状态；同一舰队被先处理的玩法占用后不会重复派遣' },
  'modules.world.fleet': { action:'维修符合阈值的闲置舰队，并在允许时加速维修', scope:'当前角色城战规则中明确配置的舰队；不会维修未纳入城战规则的舰队' },
  'modules.world.pirate': { action:'挑战或扫荡海盗', scope:'当前角色已解锁海盗；只在配置的上海时间段内执行' },
  'modules.world.radar': { action:'派遣雷达事件并领取雷达奖励', scope:'当前角色当前雷达事件；每次派遣前重新选择闲置舰队' },
  'modules.world.resField': { action:'调整已有资源田的类型配比', scope:'当前角色已经占有的资源田；只释放超额已知类型，不搜索或占领新资源田' },
  'modules.world.chipMine': { action:'领取芯片矿奖励并派遣舰队挖矿', scope:'当前角色芯片矿活动；受开放小时、每日次数、空位和舰队规则共同限制' },
  'modules.world.treasureLoot': { action:'按规则派遣舰队进行宝藏掠夺', scope:'当前角色可见的宝藏目标；会排除己方联盟和不符合舰队规则的目标' },
  'modules.world.merchantShip': { action:'在上海整点检查万吨货轮并派遣选中远征舰队', scope:'当前角色的搁浅商船目标；只处理已确认的万吨货轮，不需要预先打开活动页面' },
  'modules.world.cityWar': { action:'领取城战在线奖励、集结、进攻、驻守与行军加速', scope:'当前角色在开放时段的城战；每支舰队按自身规则执行，已记录的进攻不会重复提交' },
  'modules.world.worldBoss': { action:'领取世界 Boss 伤害奖励并挑战 Boss', scope:'当前角色世界 Boss；只使用尚未被其他世界玩法占用的舰队' },
  'modules.world.limitedBoss': { action:'领取限时 Boss 奖励并派遣舰队挑战', scope:'当前角色当前开放的限时 Boss；只使用设置中选择且空闲的舰队' },
  'modules.world.trade': { action:'处理海商王领奖、升级、加速、买卖货物和迁船', scope:'当前角色当前贸易船；交易仅在上海 10:00 至 21:59 的执行窗口运行' },
  'modules.guild': { action:'处理联盟礼包、募兵、互助、科技和联盟商船', scope:'当前角色所在联盟；未入盟时本组不发送后续联盟操作' },
  'modules.guild.packs': { action:'领取联盟礼包和职级奖励', scope:'当前角色当前可领取的联盟福利；已领状态不会重复提交' },
  'modules.guild.order': { action:'完成联盟募兵订单', scope:'当前角色当前可接的指定城市订单；冷却、材料和每日次数都必须满足' },
  'modules.guild.aid': { action:'领取帮助、发起求助或帮助盟友', scope:'当前角色联盟互助列表；不会帮助自己或已过期项' },
  'modules.guild.tech': { action:'升级指定联盟科技', scope:'当前角色当前赛季可升级的科技；只消耗现有科技点' },
  'modules.guild.ship': { action:'应聘联盟商船船长并精确补货登船', scope:'当前角色符合品质、奖励和材料筛选的联盟商船；不会购买补货材料' },
  'modules.welfare': { action:'领取日常权益、任务、成长、活动和邮件奖励', scope:'当前角色现有且未领取的免费或已持有权益；不会购买月卡、礼包或付费资格' },
  'modules.activity': { action:'处理酆都捞尸人、不差钱商人和幸运转盘', scope:'当前角色当前活动周期；中秋、盲盒、捞月、工坊和祝福在“历史活动”中单独配置' },
  'modules.activity.edict': { action:'入场券足够时参与一局，每张符文先显化一次，再竞猜并结算', scope:'当前角色开放中的捞尸人联动活动；每次执行最多一局，优先续接已有局' },
  'modules.activity.midAutumn': { action:'领取中秋签到、免费礼包和活跃奖励', scope:'当前角色当前开放的中秋活动；活动或子玩法关闭时不会操作' },
  'modules.activity.blindBox': { action:'续办或开启盲盒并领取免费、积分奖励', scope:'当前角色本期盲盒；已有局优先续办，每个格子只处理一次' },
  'modules.activity.catcher': { action:'挑战、续局、扫荡捞月并领取战令奖励', scope:'当前角色当前开放的海底捞月；已开始的局会沿用保存的奖励信息，不重复消耗钩子' },
  'modules.activity.workshop': { action:'领取、生产和加速活动工坊成品', scope:'当前角色活动工坊；活动结束、满队列或达到库存水位时不继续排产' },
  'modules.activity.blessing': { action:'消耗福运结祝福指定皮肤并领取达成奖励', scope:'当前角色当前期有效皮肤；只使用本期福运结并保留设置数量' },
  'modules.activity.weekOrder': { action:'完成不差钱商人订单，必要时按价格补齐缺料', scope:'当前角色本期周订单；补料必须同时满足整单有价、钻石额度和余额保留量' },
  'modules.activity.weekLottery': { action:'领取幸运转盘次数奖励，并可使用已有转盘币抽奖', scope:'当前角色本期幸运转盘；不会购买转盘币' },
  'modules.snap': { action:'处理水世界牌 PVE、匹配、托管、取消与战令奖励', scope:'当前角色水世界牌对局；该玩法已下架，只能从历史活动手动单轮执行，不能加入循环' },
};

// 叶子字段只描述它改变的具体行为；影响对象、资源与时段统一由所属功能组补全。
const automationFieldActionCopy = {
  enabled:'开启本组所有已勾选的子动作；关闭后本组不发送游戏写请求',
  collect:'领取已经完成且服务器标记为可领的产物；不启动新的生产或打造',
  finish:'完成已满足竣工条件的建筑；不新建建筑',
  build:'按当前可建条件创建建筑；人口、材料或建筑状态不满足时跳过',
  upgrade:'升级当前可升级的建筑；材料不足或不满足前置条件时跳过',
  speedUp:'对本组正在进行的项目使用现有加速道具；没有道具时不会购买',
  disabledBuildings:'列出的建筑不会被本组建造、升级或加速；不影响手动操作',
  gain:'领取已完成的工厂或活动工坊成品，并在领取后刷新库存',
  autoProduce:'为普通工厂开启游戏内自动生产；需求优先开启后仍保留自动生产，并在现有队列后追加需求材料',
  products:'为选中的工厂类型指定可生产产品；未配置的工厂不会因本项自动开工',
  disabledFactories:'列出的工厂会停止本组排产，并取消其已有的自动生产',
  priorityProduce:'开启三档排产：短料按低高水位补货、长品按订单及配方依赖生产；保留游戏自动生产，需求材料仅追加到现有队列后方',
  proposedPriority:'决定订单需求来源的计算顺序；前面的来源优先占用可用库存和产能',
  speedUpForDemand:'只为已识别的订单缺口加速生产；每座工厂每轮最多加速一次',
  fastTimeSecs:'按当前固定减时和速度加成计算单件耗时；不超过此秒数归为第一档，默认 300 秒；0 只包含即时商品',
  shortTimeSecs:'超过第一档且不超过此秒数归为第二档，默认 600 秒；更长商品只按订单及原料依赖安排',
  fastStockLow:'第一档扣除订单及配方占用后的可用库存低于此值时触发补货，在产和未领取成品也会抵扣缺口',
  fastStockHigh:'第一档触发补货后补到此可用库存目标，不默认补满仓；实际目标不超过游戏单品库存上限',
  shortStockLow:'第二档扣除订单及配方占用后的可用库存低于此值时触发补货，在产和未领取成品也会抵扣缺口',
  shortStockHigh:'第二档触发补货后补到此可用库存目标；低于高水位但未触发低水位时不新开补货',
  priorityBurstLimit:'先恢复能生产短料的低水位，再按此件数为材料齐全的长订单保底；恢复低水位的紧急补货不计数，保底位置保护到开工',
  reorderQueue:'短料可取消并重排未开工的等待项；所有已开工项（包括月卡第二生产位）保持不动，取消后按实际返还库存重算',
  harvest:'收割已成熟农作物；未成熟或空闲农田不会处理',
  plant:'在空闲农田种植符合库存目标的作物；种子不足或达到水位时跳过',
  cropPriorities:'设定作物补货排序，数字越小越早安排；只在允许种植时生效',
  cropKeepStock:'设定每种作物的目标库存；田间已种和将成熟产量也会计入',
  priorityPlant:'先满足已识别的订单作物需求，再按普通作物优先级补货',
  seedOnDemand:'订单缺少种子时，允许普通工厂按真实配方生产种子；材料不足不生产',
  speedUpMaxActions:'限制每轮农田加速的最多次数；0 表示本轮不做农田加速',
  orderReward:'领取达到条件但尚未领取的居民订单进度档位奖励',
  blockedMaterials:'订单需要这些材料时不交单；不会消耗被列出的材料',
  skipCropOrders:'居民订单包含农作物时直接跳过；不影响非农作物订单',
  minExp:'订单经验低于此值时不交单并请求刷新；0 不按经验过滤',
  minGold:'订单金币低于此值时不交单并请求刷新；0 不按金币过滤',
  dailyCap:'限制上海自然日内本组处理次数；0 表示不设本地上限',
  fill:'用现有库存填充货船的未完成舱位；库存不足的舱位保持跳过',
  reward:'领取已完成货船或活动的可领奖励；已领取状态不会重复提交',
  optionIndex:'选择当前选择事件的第 1 或第 2 个选项；不会根据奖励自动改选',
  fishing:'在未达到本轮次数和容量限制时开始钓鱼，并领取可收取的大鱼',
  maxFishCasts:'限制每轮最多开始的钓鱼次数；不等同于当日总次数',
  floater:'拾取海面浮漂；普通材料满仓时默认跳过',
  floaterCollectWhenFull:'即使普通材料满仓仍尝试拾取浮漂；可能只获得不受仓库限制的内容',
  openChests:'使用背包现有保险箱钥匙开启宝箱；没有钥匙时不购买',
  maxChests:'限制每轮最多开启的宝箱数量；不改变背包中钥匙数量以外的条件',
  diving:'在已开放且有容量时进行潜水采集',
  divingEach:'设定每种潜水材料的目标数量；当前产量和仓库容量不足时会提前停止',
  salvage:'在已开放且有容量时进行拾荒采集',
  salvageEach:'设定每种拾荒材料的目标数量；会按当前材料产量换算可执行次数',
  enhanceTargetLevel:'采集技能达到此等级即停止强化；资源不足时不会继续尝试',
  claim:'领取本组已达到条件的挂机、探宝或贸易收益；不启动对应玩法',
  levelUp:'升级本组的挂机、宠物或培养等级；每次根据当前下一等级费用判断',
  levelReward:'领取已经达到等级且尚未领取的奖励档位',
  claimAfterHours:'累计挂机时间达到此小时数才领取；0 表示不额外等待',
  heroes:'限定可培养、委任、碎片招募和强化的英雄；空列表不会培养任何英雄',
  levelUpMaxActions:'限制每轮对每个选中英雄的升级轮数，避免单轮连续消耗',
  starUp:'为选中的英雄在材料足够时升星；不会处理未选择英雄',
  skillLevelUp:'提升选中英雄当前可升级的技能；每步会按当前费用刷新判断',
  skillAdvance:'为选中英雄执行符合赛季和等级条件的技能进阶',
  exclusiveLevelUp:'提升选中英雄专属装备等级；受当前星级解锁等级限制',
  exclusiveStarUp:'为选中英雄专属装备升星；只使用对应品质的升星材料',
  equipEnhance:'强化选中英雄正在穿戴的装备；不会改动背包闲置装备',
  badgeEnhance:'强化选中英雄的徽章；只使用指定数量的徽章经验道具',
  badgeExpItemNum:'设置单次徽章强化投入的经验道具数；只影响徽章强化分支',
  appoint:'按“指定英雄”和“委任位置”配置安排英雄岗位；不会使用自动随机委任',
  positions:'按英雄选择顺序指定岗位；位置不足或英雄不可用时跳过对应委任',
  watchSkillVideo:'请求当前可观看的英雄广告奖励；广告状态不允许时不请求',
  watchVideo:'请求当前可观看的招募广告奖励；广告状态不允许时不请求',
  universal:'允许当前培养或打造分支消耗万能材料；关闭时万能材料不会被使用',
  fragRecruit:'只用碎片招募尚未拥有的选中英雄；不购买碎片',
  free:'使用当前可用的免费招募次数；冷却未结束时不请求',
  tickets:'使用背包已有招募券；不会购买招募券',
  points:'领取达到条件且尚未领取的招募积分奖励',
  maxDraws:'限制每轮最多抽取次数；不等同于背包或活动总次数',
  activate:'激活满足碎片条件的藏品或套装；不消耗未授权的万能材料',
  suit:'处理藏品套装激活和升级；仍受套装成员和大师等级条件限制',
  breed:'开始符合物种和品质要求的宠物培育；材料或位置不足时跳过',
  breedSpecies:'限定允许培育的宠物物种；空列表不会按物种主动开培育',
  breedMinQuality:'只保留达到该品质的培育目标；不指定时不过滤品质',
  feed:'喂养满足当前需求的宠物；不对受保护或不符合流程的宠物操作',
  decompose:'放生或分解符合品质阈值的闲置对象；已引用或受保护对象会排除',
  decomposeBelowQuality:'只处理严格低于此品质的闲置对象；未指定品质时不进行放生或分解',
  protectedUids:'列出的宠物或装备 UID 永远不由自动分解处理；不会影响手动操作',
  levelUpTargetLevel:'宠物达到此等级即停止升级；不会为了进阶超过该目标',
  advance:'在喂养完成且满足进阶条件后推进宠物进阶',
  advanceRooms:'限定可执行宠物进阶的战备室建筑；空列表表示不按建筑 ID 限制',
  make:'按已选择且当前赛季开放的装备配方开始打造；材料不足不排队',
  makeIds:'限定允许打造的装备配方；未列出的配方不会由本组开工',
  speedUpMinRemainSecs:'剩余时间达到此秒数才尝试使用一个加速器；避免为即将完成的项目加速',
  collectRevenue:'领取博物馆未收取的收益；不影响探宝是否开启',
  explore:'结算已完成探宝、领取奖励后，为符合条件的空闲关卡开启新探宝',
  factor:'选择探宝时间倍率；当前等级未开放该倍率时不启动探宝',
  maps:'限定参与探宝的博物馆关卡；空列表表示所有可用关卡',
  speedUpDailyLimit:'限制上海自然日内本组加速次数；0 表示禁止本组加速',
  maxActions:'限制本轮主线挑战次数；失败后不会继续挑战后续关卡',
  samePowerRetryCount:'主线失败时允许以相同战力重试的次数；0 表示失败即停止',
  claimReward:'领取已达到条件且未领取的章节、活动或祝福奖励',
  sweep:'扫荡当前已通过且允许扫荡的内容；不主动挑战未通过关卡',
  challenge:'挑战当前符合条件的目标或关卡；失败、血量限制或状态异常会停止该链',
  rubySweep:'允许试炼在免费次数用尽后使用钻石扫荡；仍受全局和模块钻石护栏限制',
  reservePoints:'联盟赛挑战后仍需保留的积分；积分不足时不挑战',
  hangupReward:'领取联盟赛挂机收益；只处理可领档位',
  danReward:'领取联盟赛段位奖励；已领取档位不会重复请求',
  passReward:'领取当前已有权益的战令奖励；不购买战令或等级',
  finalReward:'领取远征已完成副本的最终奖励；未完成时不请求',
  freePass:'领取远征当前已拥有的免费战令权益；不购买付费档',
  challengeStopOnHeroDeath:'远征队伍中任一英雄阵亡时停止后续挑战，保留当前状态等待人工处理',
  challengeMinTeamHpPct:'远征队伍血量低于此百分比时停止后续挑战；0 表示不按血量额外停止',
  report:'领取已确认可领的战报奖励；没有奖励时不发送请求',
  repair:'维修闲置且耐久低于对应阈值的配置舰队',
  repairThresholds:'按舰队列表顺序设置维修耐久阈值；没有对应阈值的舰队不会因本项维修',
  repairSpeedUp:'维修满足剩余时间条件时优先使用加速器；无道具或道具明确失败后按剩余分钟数向上取整、每分钟 10 钻计价，仍受钻石消费护栏限制',
  attack:'挑战当前已解锁的海盗；不扫荡未击败档位',
  attackTypes:'限定可挑战的海盗类型；空列表不会按类型主动挑战',
  sweepTypes:'限定可扫荡的已击败海盗类型；空列表不会按类型主动扫荡',
  start:'设置本组执行时段的开始上海时间',
  end:'设置本组执行时段的结束上海时间；开始和结束共同决定允许窗口',
  kinds:'限定处理的雷达事件类型；未列出的事件保持不动',
  fixed:'允许处理固定雷达事件；关闭时固定事件不会被本组派遣',
  factory:'设置已有资源田中工厂类资源田的目标权重；只用于释放超额资源田',
  oasis:'设置已有资源田中种子田的目标权重；不会新占领资源田',
  tank:'设置已有资源田中汽油田的目标权重；0 表示不保留该类型配额',
  hours:'限定本组在上海哪些整点执行；空列表表示不按小时限制',
  fleets:'按列表顺序使用符合每行条件的舰队；忙碌舰队只跳过自身，不阻塞后续舰队',
  retryMinutes:'同一整点未成功夺取万吨货轮时的重试间隔；0 表示该整点不重试',
  online:'只在城战在线奖励开放且尚未领取时领取；不触发进攻或驻守',
  reattack:'允许对已记录的城战目标再次进攻；关闭时同一目标会被本地日记录去重',
  attackTimes:'限制上海自然日内世界 Boss 挑战次数；不影响领取伤害奖励',
  challengeReward:'领取限时 Boss 已达到条件的挑战奖励；不等同于开启挑战',
  profitLimit:'累计贸易利润不低于该值时才允许航行加速；0 表示利润非负时即可加速，不影响买卖、迁船和领奖',
  dailyLimit:'限制当前玩法在上海自然日的本地次数；0 表示不设本地上限',
  cityIds:'限定可完成联盟募兵的城市；未列出的城市订单不会提交',
  receive:'领取自己已经完成的联盟帮助；不发起新的求助',
  ask:'为指定物品发起联盟求助；只选择当前配置表存在的物品',
  askItems:'限定可以发起求助的物品；空列表不主动求助',
  help:'帮助符合物品、昵称与库存条件的盟友；不会帮助自己或过期请求',
  helpItems:'限定可以贡献给盟友的物品；其他物品请求不处理',
  helpNicknameKeywords:'限定盟友昵称必须包含的关键词；空列表不按昵称额外过滤',
  helpMinStock:'帮助前自己的库存必须达到该值；帮助后库存可能低于该值',
  helpDailyLimit:'限制上海自然日内帮助盟友次数；0 表示不设本地上限',
  items:'限定允许升级的联盟科技；未选择科技不会消耗科技点',
  captain:'为符合条件的联盟商船尝试应聘船长；会校验英雄、星级和专属装备条件',
  crew:'为符合筛选的联盟商船补齐可用舱位；只用现有材料',
  qualities:'限定可处理的联盟商船品质；未选择品质不处理',
  rewardItems:'限定期望出现的联盟商船奖励；不匹配时默认跳过',
  minWaterCoin:'联盟商船奖励水姆币低于此值时跳过；0 表示不按水姆币过滤',
  forbiddenMaterials:'这些材料不会被用于联盟商船补货；库存再高也不使用',
  relaxFilters:'允许在严格品质或奖励筛选无匹配时放宽筛选；仍保留禁用材料限制',
  guild:'领取当前可领取的联盟礼包；不影响联盟募兵、互助、科技或联盟商船',
  title:'领取当前已满足条件的联盟职级奖励；不变更联盟职位或成员关系',
  daily:'领取现有月卡、季卡、VIP 和其他免费日奖；不会购买权益',
  weeklyLottery:'领取本周可用的免费抽奖礼包；默认关闭且不使用付费次数',
  uniqueLottery:'领取每周专属抽奖的免费次数；不会使用钻石或购买资格',
  dailyTask:'领取已完成的每日任务和活跃宝箱奖励',
  growth:'领取主线、支线和成就的已达成奖励',
  events:'领取当前符合条件的新手登录或成长活动奖励',
  email:'领取未领取附件的邮件；不会删除或标记邮件内容',
  signIn:'领取当前活动日的签到奖励；活动未开放时不请求',
  freeGift:'领取当前活动的免费礼包；不购买付费礼包',
  activeReward:'领取达到活动活跃条件的奖励档位',
  scoreReward:'领取盲盒达到积分条件的奖励；不开始新局',
  play:'在没有可续办对局时开始新的盲盒或捞月挑战；活动状态不允许时跳过',
  keepCards:'盲盒保留的卡片数量；不足该数量时不为了继续流程消耗卡片',
  repeat:'允许重复挑战当前最高已开放的捞月关卡；关闭时只处理首次可进度',
  keepHooks:'捞月钩的背包保留数量；库存不高于此值时不消耗钩子',
  maxStage:'限定自动挑战捞月的最高关卡；更高关卡即使开放也不进入',
  sweepStage:'指定要扫荡的捞月关卡；0 表示不执行捞月扫荡',
  produce:'在队列有空位且未达到备货目标时安排活动工坊生产',
  keepStock:'活动工坊成品的备货目标；在产和已完成成品都会计入',
  keepClaws:'活动工坊生产后保留的爪钩数量；不足时不排产',
  boost:'消耗本期福运结为指定皮肤祝福；无有效皮肤或材料时跳过',
  skinId:'指定可被祝福的活动皮肤 ID；不匹配当前活动时不消耗福运结',
  boostTimes:'设置单次祝福投入数量；达到皮肤上限时不继续投入',
  keepKnots:'保留的本期福运结数量；库存不高于此值时不祝福',
  buyMissingMaterials:'允许为一整单周订单补购缺料；缺任一价格、预算或保留量时整单跳过',
  prize:'使用背包已有幸运转盘币抽奖；关闭时仍可领取次数奖励',
  pve:'处理水世界牌 PVE 已有对局或使用当前有效打牌券开局',
  pvpTrustee:'在真人对局中开启托管；仅影响当前匹配对局，不会自动发起匹配',
  giveUpPve:'放弃当前进行中的 PVE 对局；只有确有进行中对局才提交',
  cancelMatchmaking:'取消当前匹配队列；队列为空时不发送请求',
  freeMatch:'使用当前免费匹配次数发起匹配；免费次数不足时不自动改用钻石',
  diamondMatch:'免费次数用尽后允许钻石匹配；仍受匹配次数、时段和钻石护栏限制',
  diamondMatchDailyLimit:'限制当前角色上海自然日内的钻石匹配次数；0 表示禁止钻石匹配',
  matchWindows:'限定水世界牌匹配的上海时间段；空列表沿用活动配置时间',
  maxMatches:'限制本轮水世界牌新开或续办的对局数量；不改变服务器活动次数',
};

// 舰队规则和匹配时段存在于动态编辑行，不会经过默认设置模型的普通字段渲染。
const automationRuleFieldCopy = {
  enabled:'功能：将这一行舰队规则纳入派遣候选。影响范围：仅本行选择的舰队；关闭时该行不会占用或派出舰队。',
  buildingId:'功能：指定使用的游戏内舰队。影响范围：仅这支舰队；留空时才允许从闲置舰队中自动选择。',
  levels:'功能：设置芯片矿或宝藏目标的最低品质。影响范围：只影响本行舰队筛选，0 表示不按品质过滤。',
  emptyOnly:'功能：只选择尚未被其他玩家占领的目标。影响范围：只影响本行芯片矿或宝藏目标筛选。',
  helpAlly:'功能：允许本行舰队协助己方联盟的宝藏目标。影响范围：只影响宝藏掠夺，不影响其他舰队派遣。',
  roles:'功能：勾选本行舰队可执行的城战行动。影响范围：只影响该舰队；未勾选的行动不会由它执行。',
  gotoCityId:'功能：指定本行舰队驻守或前往的城战城市。影响范围：只影响本行的前往或驻守动作，0 表示按当前城战目标自动决定。',
  marchSpeedUp:'功能：允许本行舰队在确认行军后使用钻石加速。影响范围：只影响该舰队的行军，仍受钻石消费护栏限制。',
  start:'功能：设置一条匹配时段的开始上海时间。影响范围：只影响水世界牌在该时段内是否可匹配。',
  end:'功能：设置一条匹配时段的结束上海时间。影响范围：只影响水世界牌在该时段内是否可匹配。',
};

/**
 * Returns the player-facing title and business explanation for one setting.
 * Exact paths take precedence because several features reuse names such as
 * enabled、dailyLimit 与 minRubyStock 等同名字段在不同玩法中的作用范围不同。
 *
 * @param {string[]} path Full setting path, including the current field name.
 * @param {string} key Current setting key.
 * @returns {{title: string, note: string}} Display copy for the setting.
 */
function settingCopy(path, key) {
  const pathName = path.join('.');
  const copy = automationSettingCopy[pathName];
  if (copy) return { title:copy.title || automationLabels[key] || key, note:copy.note || '' };
  const ownFeature = automationFeatureCopy[pathName];
  if (ownFeature) return { title:automationLabels[key] || key, note:'功能：' + ownFeature.action + '。影响范围：' + ownFeature.scope + '。' };
  // 钻石模块额度的每一行都只是共享总额度下的子上限，不能让通用“设置值”文案掩盖这一层约束。
  if (path.length === 3 && path[0] === 'spending' && path[1] === 'modules') return { title:automationLabels[key] || key, note:'功能：设置“' + (automationLabels[key] || key) + '”在上海自然日内可使用的钻石子额度。影响范围：同一账号所有角色在该玩法的消费合计；仍必须同时满足每日总额度和最低钻石保留量。' };
  // 顶层模块开关只授权该玩法；资源、时段和子功能条件仍会决定是否实际执行。
  if (path.length === 3 && path[0] === 'modules' && key === 'enabled') return { title:automationLabels[key], note:'这是该玩法的总开关。开启后仍需满足已勾选的子功能、库存、时段和游戏状态条件。' };
  const feature = [...path.slice(0, -1)].map((_, index, parts) => parts.slice(0, parts.length - index).join('.')).map(name => automationFeatureCopy[name]).find(Boolean);
  const action = automationFieldActionCopy[key] || '设置“' + (automationLabels[key] || key) + '”的值；保存后只影响所属自动化分支，不会立即执行游戏操作';
  if (feature) return { title:automationLabels[key] || key, note:'功能：' + action + '。影响范围：' + feature.scope + '。' };
  return { title:automationLabels[key] || key, note:'功能：' + action + '。影响范围：当前账号保存的自动化设置；需在执行对应模块时才生效。' };
}

/** Renders a setting title with its function and scope explanation. */
function settingText(title, note) {
  const copy = el('span', 'automation-field-copy');
  copy.appendChild(el('span', 'automation-field-label', title));
  if (note) copy.appendChild(el('small', 'automation-field-help', note));
  return copy;
}

/**
 * Creates the shared heading used by list and dictionary editors, whose input
 * control lives in the following three-column editor rather than this row.
 *
 * @param {string} title Visible setting title.
 * @param {string} note Optional scope or business-rule explanation.
 * @returns {HTMLElement} Heading element for a complex setting.
 */
function settingHeading(title, note) {
  const heading = el('div', 'automation-field');
  heading.appendChild(settingText(title, note));
  return heading;
}

// 已下架玩法仍复用原有模块 ID 与账号设置路径；这里只调整控制台呈现位置，避免历史配置失效。
const HISTORICAL_ACTIVITY_KEYS = ['midAutumn', 'blindBox', 'catcher', 'workshop', 'blessing'];
const CURRENT_ACTIVITY_KEYS = ['enabled', 'edict', 'weekOrder', 'weekLottery'];
const HISTORICAL_ACTIVITY_LABELS = { midAutumn: '中秋', blindBox: '盲盒', catcher: '抓捕（海底捞月）', workshop: '活动工坊', blessing: '祈福' };

/**
 * Adds one selected-fleet row for the merchant-ship form. The setting keeps a
 * building ID, rather than a display ordinal, because the protocol requires
 * that exact ID when it sends the expedition request.
 *
 * @param {{enabled?: boolean, buildingId?: string}} fleet Saved row, if any.
 * @param {HTMLElement} container Merchant-ship fleet row container.
 */
function addMerchantShipFleetRow(fleet, container) {
  // 商船舰队沿用通用编辑行外观；仅保留数据属性与读取时的业务校验。
  const row = el('div', 'automation-editor-row merchant-ship-fleet-row');
  row.dataset.merchantShipFleet = '';
  const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(fleet.enabled); enabled.dataset.merchantShipFleetEnabled = '';
  const toggle = el('label', 'merchant-ship-fleet-toggle'); toggle.append(enabled, document.createTextNode('派出'));
  const buildingId = editorSelect(automationOptions.fleets, fleet.buildingId || '', '远征舰队', '请选择舰队');
  buildingId.className = 'merchant-ship-fleet-id';
  buildingId.dataset.merchantShipFleetBuildingId = ''; buildingId.setAttribute('aria-label', '远征船建筑 ID');
  buildingId.title = '选择游戏内远征舰队，保存其真实建筑 ID。';
  const remove = el('button', 'tiny merchant-ship-remove', '移除');
  remove.type = 'button'; remove.title = '移除此舰队规则';
  // 空白占位行也允许删除；保存时只保留填写了建筑 ID 的舰队规则。
  remove.onclick = () => { row.remove(); container.dispatchEvent(new Event('change', { bubbles:true })); };
  row.append(toggle, buildingId, remove); container.appendChild(row);
}

/**
 * Renders merchant-ship switches and fleet choices with the same setting rows
 * and three-column editor used by the other automation configuration groups.
 *
 * @param {{enabled: boolean, retryMinutes: number, fleets: Array<{enabled: boolean, buildingId: string}>}} value Saved merchant-ship settings.
 * @param {string[]} path Full settings path for scalar controls.
 * @returns {HTMLElement} Merchant-ship configuration panel.
 */
function merchantShipFields(value, path) {
  const panel = el('div');

  const enabledCopy = settingCopy(path.concat('enabled'), 'enabled');
  const enabled = editorInput('enabled', value.enabled); enabled.dataset.setting = path.concat('enabled').join('.'); enabled.dataset.kind = 'boolean'; enabled.title = enabledCopy.note;
  const enabledLabel = el('label', 'automation-field'); enabledLabel.append(settingText(enabledCopy.title, enabledCopy.note), enabled);
  panel.appendChild(enabledLabel);

  const retryCopy = settingCopy(path.concat('retryMinutes'), 'retryMinutes');
  const retryLabel = el('label', 'automation-field'); retryLabel.appendChild(settingText(retryCopy.title, retryCopy.note));
  const retry = editorInput('retryMinutes', value.retryMinutes);
  retry.dataset.setting = path.concat('retryMinutes').join('.'); retry.dataset.kind = 'number'; retry.setAttribute('aria-label', retryCopy.title); retry.title = retryCopy.note;
  retryLabel.appendChild(retry); panel.appendChild(retryLabel);

  const editor = structuredEditor('fleets', path.concat('fleets').join('.'), 'merchant');
  const add = el('button', 'tiny', '添加舰队'); add.type = 'button'; add.title = '新增一条舰队规则';
  const fleetsCopy = settingCopy(path.concat('fleets'), 'fleets');
  panel.appendChild(settingHeading(fleetsCopy.title, fleetsCopy.note));
  editor.palette.append(add, el('p', 'automation-editor-note', '选择远征舰队后勾选“派出”；未勾选的舰队不会出征。'));
  const fleets = el('div', 'automation-editor-rows merchant-ship-fleets'); fleets.dataset.merchantShipFleets = '';
  editor.rows.appendChild(fleets);
  /** 商船使用严格的建筑 ID 选择和去重规则，空白禁用行不属于实际派遣计划。 */
  editor.root.readSetting = () => readMerchantShipFleets(fleets);
  const rows = value.fleets.length ? value.fleets : Array.from({ length: 3 }, () => ({ enabled: false, buildingId: '' }));
  for (const fleet of rows) addMerchantShipFleetRow(fleet, fleets);
  // 新行默认不启用，避免只为预留一行就被保存校验视作待派遣舰队。
  add.onclick = () => { addMerchantShipFleetRow({ enabled: false, buildingId: '' }, fleets); editor.sync(); };
  panel.appendChild(editor.root); editor.sync();
  return panel;
}

/**
 * 渲染海商王自动化设置；沿用通用设置行，避免视觉样式与其他配置组分叉。
 * @param {{enabled?: boolean, claim?: boolean, upgrade?: boolean, speedUp?: boolean, speedUpDailyLimit?: number, profitLimit?: number}} value Saved trade settings.
 * @param {string[]} path Full settings path used by the shared form reader.
 * @returns {HTMLElement} 海商王配置面板。
 */
function tradeFields(value, path) {
  const panel = el('div');

  // 专用标题保留贸易语义，避免通用字段名“开启”“领取”在独立面板中失去对象。
  const tradeFieldTitles = { enabled:'开启海商王', claim:'领取贸易战报、成就和通行证奖励', upgrade:'自动升级贸易船', speedUp:'允许航行加速', speedUpDailyLimit:'每日航行加速次数', profitLimit:'航行加速最低累计利润' };
  /** 为海商王面板创建带统一 data-setting 路径的基础控件。 */
  const field = (key, kind, extra = {}) => {
    const copy = settingCopy(path.concat(key), key);
    copy.title = tradeFieldTitles[key] || copy.title;
    const row = el('label', 'automation-field'); row.appendChild(settingText(copy.title, copy.note));
    const input = editorInput(key, kind === 'boolean' ? Boolean(value[key]) : value[key] ?? 0);
    input.dataset.setting = path.concat(key).join('.'); input.dataset.kind = kind; input.title = copy.note;
    Object.assign(input, extra); row.appendChild(input); return row;
  };

  panel.appendChild(field('enabled', 'boolean'));
  panel.appendChild(field('claim', 'boolean'));
  panel.appendChild(field('upgrade', 'boolean'));
  panel.appendChild(field('speedUp', 'boolean'));
  panel.appendChild(field('speedUpDailyLimit', 'number'));
  panel.appendChild(field('profitLimit', 'number'));
  return panel;
}

/**
 * Wraps one world activity in the same collapsible group used by the other
 * world features. The activity title and scope note belong on the summary
 * group so its fields are not duplicated inside the panel.
 *
 * @param {{title: string, note: string}} copy Activity display copy.
 * @param {HTMLElement} fields Existing activity form fields.
 * @returns {HTMLDetailsElement} Collapsible world-activity group.
 */
function worldActivityGroup(copy, fields) {
  const group = el('details', 'automation-group');
  group.appendChild(el('summary', null, copy.title));
  if (copy.note) group.appendChild(el('p', 'automation-group-note', copy.note));
  group.appendChild(fields);
  return group;
}

/** 根据业务字段取本地游戏选项；时钟和需求来源属于固定业务枚举。 */
function editorChoices(key) {
  const options = automationOptions;
  if (key === 'hours') return Array.from({ length: 24 }, (_, value) => ({ value, label: String(value).padStart(2, '0') + ':00' }));
  if (key === 'proposedPriority') return ['resident', 'cargo', 'guild'].map(value => ({ value, label: { resident:'居民订单', cargo:'货船', guild:'联盟募兵' }[value] }));
  const source = { disabledBuildings:'buildings', disabledFactories:'factories', products:'factories', cropPriorities:'crops', cropKeepStock:'crops', blockedMaterials:'items', askItems:'items', helpItems:'items', rewardItems:'items', forbiddenMaterials:'items', items:'tech', attackTypes:'pirates', sweepTypes:'pirates' }[key] || key;
  const season = Number(document.querySelector('[data-setting="season"]')?.value ?? automationSettings.season);
  const values = key === 'cityIds' ? options.cities[season] || [] : options[source] || [];
  return [...new Map(values.filter(item => !item.season || item.season <= season).map(item => [item.value, item])).values()];
}

/** 显示游戏名称但提交原始 ID；已保存的业务值始终作为可选项展示。 */
function editorSelect(options, value, label, emptyLabel) {
  const select = el('select'); select.setAttribute('aria-label', label);
  if (emptyLabel !== undefined) select.appendChild(new Option(emptyLabel, ''));
  const choices = [...options];
  if (value !== '' && !choices.some(item => String(item.value) === String(value))) choices.push({ value, label:String(value) });
  for (const item of choices) select.appendChild(new Option(item.label, String(item.value)));
  select.value = String(value); return select;
}

/** 将普通数值、时间、品质与开关生成有标签的控件，规则行也复用同一套转换。 */
function editorInput(key, value) {
  if (key === 'buildingId') return editorSelect(automationOptions.fleets, value, '派出舰队', '自动选择闲置舰队');
  if (key === 'gotoCityId') return editorSelect([{ value:0, label:'自动选择城市' }, ...editorChoices('cityIds')], value, '目标城市');
  if (key === 'levels') return editorSelect([{ value:0, label:'请选择目标品质' }, ...automationOptions.colors], value, '目标品质');
  if (['breedMinQuality','decomposeBelowQuality'].includes(key)) return editorSelect(automationOptions.qualities, value, automationLabels[key], '不指定品质');
  const input = el('input'); input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : ['start','end'].includes(key) ? 'time' : 'text';
  if (input.type === 'checkbox') { input.checked = value; input.setAttribute('role', 'switch'); }
  else input.value = value;
  if (input.type === 'time') input.step = '1';
  if (input.type === 'number') { input.min = '0'; input.step = key === 'claimAfterHours' ? 'any' : '1'; }
  input.setAttribute('aria-label', automationLabels[key] || key); return input;
}

/** 读取控件时拒绝空白、负数与无效时间，避免 Number('') 将未填值悄悄保存为零。 */
function readEditorInput(input, kind, label) {
  if (kind === 'boolean') return input.checked;
  const raw = input.value.trim();
  if (kind === 'number') {
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0 || !input.checkValidity()) throw new Error(label + '：请填写有效非负数');
    return value;
  }
  if (input.type === 'time' && (!raw || !input.checkValidity())) throw new Error(label + '：请选择有效时间');
  return raw;
}

/** 创建三列编辑器；JSON 仅展示实际表单结果，保存直接读取控件而非预览文本。 */
function structuredEditor(key, settingPath, kind) {
  const root = el('div', 'automation-editor'); root.dataset.editor = kind; root.dataset.setting = settingPath;
  const palette = el('div', 'automation-editor-pane'); palette.appendChild(el('strong', null, '可选项'));
  const selected = el('div', 'automation-editor-pane'); selected.appendChild(el('strong', null, '当前设置'));
  const rows = el('div', 'automation-editor-rows'); selected.appendChild(rows);
  const result = el('div', 'automation-json-pane'); result.appendChild(el('strong', null, 'JSON 结果'));
  const output = el('textarea', 'automation-json'); output.readOnly = true; output.dataset.jsonOutput = ''; output.setAttribute('aria-label', automationLabels[key] + ' JSON 结果');
  const error = el('p', 'automation-editor-error'); error.setAttribute('role', 'status'); result.append(output, error);
  /** 无效的编辑状态不沿用旧预览，保存时仍由同一个读取函数阻止提交。 */
  const sync = () => {
    try { output.value = JSON.stringify(root.readSetting(), null, 2); error.textContent = ''; }
    catch (failure) { output.value = ''; error.textContent = failure.message; }
  };
  root.addEventListener('input', sync); root.addEventListener('change', sync);
  root.append(palette, selected, result); return { root, palette, rows, sync };
}

/** 大列表可按游戏名称搜索；只隐藏候选按钮，不清空已经选择的值。 */
function editorPalette(container, choices, onPick) {
  const list = el('div', 'automation-choice-list');
  if (choices.length > 12) {
    const search = el('input', 'automation-choice-search'); search.type = 'search'; search.placeholder = '搜索游戏名称'; search.setAttribute('aria-label', '搜索可选项');
    search.oninput = () => { for (const button of list.children) button.hidden = !button.textContent.toLowerCase().includes(search.value.trim().toLowerCase()); };
    container.appendChild(search);
  }
  for (const item of choices) {
    const button = el('button', 'automation-choice', item.label); button.type = 'button'; button.dataset.editorChoice = String(item.value);
    button.onclick = () => onPick(item.value); list.appendChild(button);
  }
  container.appendChild(list);
  if (!choices.length) container.appendChild(el('p', 'automation-editor-note', '暂无可选项；请检查本地游戏配置和赛季设置。'));
}

/** 数组按点击顺序保存，可移除或上移；维修阈值允许不同舰队使用相同数值。 */
function primitiveArrayEditor(value, key, settingPath) {
  const { root, palette, rows, sync } = structuredEditor(key, settingPath, 'array');
  const selected = [...value], choices = editorChoices(key), labels = new Map(choices.map(item => [String(item.value), item.label]));
  const repeatable = key === 'repairThresholds';
  /** 返回副本，防止保存过程或调用者改写页面中的选择顺序。 */
  root.readSetting = () => [...selected];
  /** 重绘选择列表与按钮状态，顺序同时决定需求优先级、英雄委任和舰队阈值。 */
  const render = () => {
    clear(rows);
    if (!selected.length) rows.appendChild(el('span', 'automation-editor-note', '暂未选择'));
    selected.forEach((item, index) => {
      const chip = el('div', 'automation-chip'); chip.appendChild(el('span', null, (index + 1) + '. ' + (labels.get(String(item)) || item)));
      const up = el('button', 'tiny', '↑'); up.type = 'button'; up.disabled = index === 0; up.setAttribute('aria-label', '上移 ' + item);
      up.onclick = () => { [selected[index - 1], selected[index]] = [selected[index], selected[index - 1]]; render(); };
      const remove = el('button', 'automation-chip-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '移除 ' + item);
      remove.onclick = () => { selected.splice(index, 1); render(); }; chip.append(up, remove); rows.appendChild(chip);
    });
    for (const button of palette.querySelectorAll('[data-editor-choice]')) {
      const pressed = selected.some(item => String(item) === button.dataset.editorChoice); button.classList.toggle('on', pressed); button.setAttribute('aria-pressed', String(pressed));
    }
    sync();
  };
  /** 候选项点击可选中或取消；按顺序填写的阈值则保留重复项。 */
  const pick = item => {
    const index = selected.indexOf(item);
    if (index >= 0 && !repeatable) selected.splice(index, 1); else selected.push(item);
    render();
  };
  if (!['protectedUids','helpNicknameKeywords','repairThresholds'].includes(key)) editorPalette(palette, choices, pick);
  palette.appendChild(el('p', 'automation-editor-note', '按选择顺序保存，可在当前设置中上移或移除。'));
  // UID、昵称和逐舰队阈值没有静态配置表，逐项填写且保持 UID 为十进制字符串。
  if (['protectedUids','helpNicknameKeywords','repairThresholds'].includes(key)) {
    const add = el('div', 'automation-editor-add'); const input = editorInput(key, repeatable ? 0 : '');
    input.setAttribute('aria-label', automationLabels[key]); input.placeholder = repeatable ? '耐久阈值' : key === 'protectedUids' ? '对象 UID' : '盟友昵称关键词';
    const button = el('button', 'tiny', '添加'); button.type = 'button';
    /** 手填条目逐项校验，错误直接在输入框显示，不把无效条目混入结果。 */
    const addValue = () => {
      try {
        const item = readEditorInput(input, repeatable ? 'number' : 'string', automationLabels[key]);
        if (item === '') throw new Error('请填写内容');
        if (repeatable && !Number.isSafeInteger(item)) throw new Error('耐久阈值必须为整数');
        if (key === 'protectedUids' && !/^\d+$/.test(item)) throw new Error('UID 必须为十进制数字');
        input.setCustomValidity('');
        if (repeatable || !selected.includes(item)) selected.push(item);
        if (!repeatable) input.value = ''; render();
      } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    button.onclick = addValue; input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addValue(); } };
    add.append(input, button); palette.appendChild(add);
  }
  render(); return root;
}

/** 作物通过点击添加数值行，工厂通过所属产品下拉框选择，动态字典不按其键递归成配置组。 */
function dictionaryEditor(value, key, settingPath) {
  const { root, palette, rows, sync } = structuredEditor(key, settingPath, 'dictionary');
  const choices = editorChoices(key), controls = new Map();
  /** 字典键由所选游戏元素确定，只读取每个元素对应的值并拒绝未完成行。 */
  root.readSetting = () => Object.fromEntries([...controls].map(([name, input]) => {
    const entry = readEditorInput(input, key === 'products' ? 'string' : 'number', automationLabels[key]);
    if (entry === '' || (typeof entry === 'number' && !Number.isSafeInteger(entry))) throw new Error('请完成 ' + name + ' 的设置');
    return [name, entry];
  }));
  /** 每个作物或工厂最多一行，产品候选项按所属工厂过滤。 */
  const addRow = (name, saved) => {
    if (controls.has(name)) { controls.get(name).focus(); return; }
    const products = automationOptions.products.filter(item => item.factory === name);
    const initial = saved ?? (key === 'products' ? '' : key === 'cropPriorities' ? controls.size + 1 : 0);
    const input = key === 'products' ? editorSelect(products, initial, '生产产品', '请选择产品') : editorInput(key, initial);
    const row = el('div', 'automation-editor-row'); row.dataset.editorRow = ''; row.dataset.editorKey = name;
    const label = el('label', 'automation-dictionary-label', choices.find(item => item.value === name)?.label || name); label.appendChild(input);
    const remove = el('button', 'tiny', '移除'); remove.type = 'button'; remove.onclick = () => { controls.delete(name); row.remove(); sync(); };
    controls.set(name, input); row.append(label, remove); rows.appendChild(row); sync();
  };
  editorPalette(palette, choices, name => addRow(name));
  palette.appendChild(el('p', 'automation-editor-note', key === 'products' ? '点击工厂，再选择要生产的产品。' : '点击作物，再设置数值；移除后不再保留此项配置。'));
  for (const [name, saved] of Object.entries(value)) addRow(name, saved);
  sync(); return root;
}

/** 舰队规则与服务端当前模型一致，不同玩法只显示自己支持的字段。 */
function fleetRuleDefaults(settingPath) {
  const kind = settingPath.split('.')[2], model = { enabled:false, buildingId:'' };
  if (['chipMine','treasureLoot'].includes(kind)) Object.assign(model, { levels:0, emptyOnly:false });
  if (kind === 'treasureLoot') model.helpAlly = false;
  if (kind === 'cityWar') Object.assign(model, { roles:['attack'], gotoCityId:0, marchSpeedUp:false });
  return model;
}

/** 匹配时段和舰队规则逐行编辑，保留秒精度、城战行动和宝藏援助等全部业务字段。 */
function objectArrayEditor(value, key, settingPath) {
  const { root, palette, rows, sync } = structuredEditor(key, settingPath, 'object-array');
  const model = key === 'matchWindows' ? { start:'00:00', end:'00:00' } : fleetRuleDefaults(settingPath);
  /** 逐行重新读取当前控件，保证删除、修改和保存使用相同的规则顺序。 */
  root.readSetting = () => [...rows.children].map(row => row.readSetting());
  /** 新舰队默认关闭，用户完成品质、目标和行动设置后才会参与派遣。 */
  const addRow = saved => {
    const row = el('div', 'automation-rule-row'); row.dataset.editorRow = ''; const controls = new Map();
    for (const [field, sample] of Object.entries(model)) {
      const selected = saved[field] ?? sample;
      const label = el(field === 'roles' ? 'div' : 'label', 'automation-rule-field');
      const title = { enabled:'派出舰队', buildingId:'舰队', levels:'目标品质', emptyOnly:'只选未被占领的目标', helpAlly:'允许帮助己方联盟', roles:'城战行动', gotoCityId:'驻守 / 前往城市', marchSpeedUp:'钻石行军加速' }[field] || automationLabels[field];
      const note = automationRuleFieldCopy[field] || settingCopy(settingPath.split('.').concat('0', field), field).note;
      label.appendChild(settingText(title, note));
      if (field === 'roles') {
        const roles = el('div', 'automation-role-options'); const inputs = [];
        for (const [role, title] of Object.entries({ attack:'进攻', bounty:'悬赏', goto:'前往', defend:'驻守' })) {
          const choice = el('label'); const input = editorInput('enabled', selected.includes(role)); input.value = role; input.setAttribute('aria-label', title);
          choice.append(input, document.createTextNode(title)); roles.appendChild(choice); inputs.push(input);
        }
        label.appendChild(roles); controls.set(field, () => inputs.filter(input => input.checked).map(input => input.value));
      } else {
        const input = editorInput(field, selected); label.appendChild(input);
        input.title = note;
        controls.set(field, () => readEditorInput(input, typeof sample, title));
      }
      row.appendChild(label);
    }
    /** 字段集合来自当前玩法模型，避免保存时丢失城战行动或注入其他玩法字段。 */
    row.readSetting = () => Object.fromEntries([...controls].map(([field, read]) => [field, read()]));
    const remove = el('button', 'tiny', '移除此行'); remove.type = 'button'; remove.onclick = () => { row.remove(); sync(); };
    row.appendChild(remove); rows.appendChild(row); sync();
  };
  const add = el('button', 'tiny', key === 'matchWindows' ? '添加时段' : '添加舰队'); add.type = 'button'; add.onclick = () => addRow(structuredClone(model));
  palette.append(add, el('p', 'automation-editor-note', key === 'matchWindows' ? '使用上海时间；留空沿用活动时间配置，支持精确到秒。' : '按排列顺序派出已开启的舰队；自动选择时只使用闲置舰队。'));
  value.forEach(addRow); sync(); return root;
}

/** 将嵌套设置生成为分类参数表；复杂数组和动态字典使用三列点击编辑器。 */
function settingFields(value, path, parent) {
  for (const [key, sample] of Object.entries(value)) {
    const fullPath = path.concat(key), copy = settingCopy(fullPath, key), title = copy.title;
    const pathName = fullPath.join('.');
    // 两个世界活动各自独立折叠，避免平铺字段和把不同玩法混入同一个面板。
    if (pathName === 'modules.world.merchantShip') { parent.appendChild(worldActivityGroup(copy, merchantShipFields(sample, fullPath))); continue; }
    if (pathName === 'modules.world.trade') { parent.appendChild(worldActivityGroup(copy, tradeFields(sample, fullPath))); continue; }
    if (dictionarySettings.has(key)) { parent.appendChild(settingHeading(title, copy.note)); parent.appendChild(dictionaryEditor(sample, key, fullPath.join('.'))); continue; }
    if (Array.isArray(sample)) {
      if (objectArrays.has(key)) { parent.appendChild(settingHeading(title, copy.note)); parent.appendChild(objectArrayEditor(sample, key, fullPath.join('.'))); }
      else { parent.appendChild(settingHeading(title, copy.note)); parent.appendChild(primitiveArrayEditor(sample, key, fullPath.join('.'))); }
      continue;
    }
    if (sample && typeof sample === 'object' && Object.keys(sample).length) {
      const group = el('details', 'automation-group'); group.open = key === 'spending'; group.appendChild(el('summary', null, title));
      if (copy.note) group.appendChild(el('p', 'automation-group-note', copy.note));
      settingFields(sample, fullPath, group); parent.appendChild(group); continue;
    }
    const label = el('label', 'automation-field'); label.appendChild(settingText(title, copy.note));
    const input = editorInput(key, sample);
    if (copy.note) input.title = copy.note;
    // 城市与科技候选项依赖赛季；切换时重新生成候选项并保留当前表单选择。
    if (key === 'season') input.onchange = refreshEditorOptions;
    input.dataset.kind = typeof sample; input.dataset.setting = fullPath.join('.'); label.appendChild(input); parent.appendChild(label);
  }
}

/**
 * Converts merchant-ship rows back to the validated fleet-array setting. Empty
 * disabled rows are only visual placeholders; enabled rows require a concrete
 * building ID so a save cannot silently produce an unusable dispatch plan.
 *
 * @param {HTMLElement} container 当前商船表单的舰队行容器。
 * @returns {Array<{enabled: boolean, buildingId: string}>} Fleet rules in UI order.
 */
function readMerchantShipFleets(container) {
  const rules = [];
  for (const row of container.querySelectorAll('[data-merchant-ship-fleet]')) {
    const enabled = row.querySelector('[data-merchant-ship-fleet-enabled]').checked;
    const buildingId = row.querySelector('[data-merchant-ship-fleet-building-id]').value.trim();
    if (enabled && !buildingId) throw new Error('请填写每支已勾选商船舰队的建筑 ID');
    if (buildingId) rules.push({ enabled, buildingId });
  }
  const selected = rules.filter(rule => rule.enabled).map(rule => rule.buildingId);
  if (new Set(selected).size !== selected.length) throw new Error('同一支商船舰队不能重复勾选');
  return rules;
}

/** 赛季变更只重建依赖赛季的候选项，先完整读取所有选择，防止丢失尚未保存的编辑。 */
function refreshEditorOptions() {
  try {
    const editors = [...document.querySelectorAll('[data-editor][data-setting]')].filter(editor => ['array','object-array'].includes(editor.dataset.editor));
    const values = editors.map(editor => ({ editor, value:editor.readSetting() }));
    for (const { editor, value } of values) {
      const path = editor.dataset.setting, key = path.split('.').at(-1);
      editor.replaceWith(editor.dataset.editor === 'array' ? primitiveArrayEditor(value, key, path) : objectArrayEditor(value, key, path));
    }
  } catch (error) { $('automation-hint').textContent = '请先完成当前编辑：' + error.message; }
}

/** 设置加载仅访问本地保存数据，切换账号后重新加载防止覆盖另一账号。 */
async function loadAutomation() {
  const account = current;
  const data = await call('/api/automation/settings');
  if (account !== current) return;
  automationSettings = data.settings; automationAccount = account;
  automationOptions = data.options;
  Object.assign(automationLabels, data.labels);
  const form = clear($('automation-settings')), pick = clear($('automation-select'));
  pick.appendChild(new Option('全部已启用模块','all'));
  const shared = el('details','automation-group'); shared.open = true;
  shared.appendChild(el('summary',null,'账号与钻石额度'));
  shared.appendChild(el('p','automation-group-note','功能：设置当前赛季和所有模块共用的钻石消费护栏。影响范围：仅当前账号；赛季影响关联候选项，钻石护栏影响所有允许花钻石的模块。'));
  const sharedSettings = { season:data.settings.season };
  // VIP开关只有在服务端确认当前连接角色达到等级和 VIP 双重门槛时才生成控件。
  if (data.vipAd?.eligible) sharedSettings.vipFreeAd = data.settings.vipFreeAd;
  sharedSettings.spending = data.settings.spending;
  settingFields(sharedSettings,[],shared); form.appendChild(shared);
  for (const id of data.modules) {
    pick.appendChild(new Option(id === 'snap' ? '历史活动：' + data.labels[id] : data.labels[id],id));
    if (id === 'snap') continue;
    const group = el('details','automation-group');
    // 海商王属于世界模块；默认展开世界组，让新增的贸易设置无需额外点击即可发现。
    group.open = id === 'world';
    group.appendChild(el('summary',null,data.labels[id]));
    // 顶层模块不经过 settingFields 的对象节点，因此在这里补齐功能与影响范围说明。
    const moduleCopy = settingCopy(['modules',id], id);
    if (moduleCopy.note) group.appendChild(el('p','automation-group-note',moduleCopy.note));
    // 当前联动与周玩法留在常规活动；下架内容在页面底部统一归档。
    const values = id === 'activity'
      ? Object.fromEntries(CURRENT_ACTIVITY_KEYS.map(key => [key, data.settings.modules.activity[key]]))
      : data.settings.modules[id];
    settingFields(values,['modules',id],group); form.appendChild(group);
  }
  const history = el('details','automation-group'); history.append(el('summary',null,'历史活动（已下架）'), el('p','automation-group-note','功能：保留已下架活动的历史账号设置以便查阅或手动单轮执行。影响范围：这些玩法不会加入自动循环，不会因保存设置而自动开始。'));
  for (const key of HISTORICAL_ACTIVITY_KEYS) {
    const group = el('details','automation-group'); group.appendChild(el('summary',null,HISTORICAL_ACTIVITY_LABELS[key]));
    const activityCopy = settingCopy(['modules','activity',key], key);
    if (activityCopy.note) group.appendChild(el('p','automation-group-note',activityCopy.note));
    settingFields(data.settings.modules.activity[key],['modules','activity',key],group); history.appendChild(group);
  }
  const snap = el('details','automation-group'); snap.appendChild(el('summary',null,data.labels.snap));
  const snapCopy = settingCopy(['modules','snap'], 'snap');
  if (snapCopy.note) snap.appendChild(el('p','automation-group-note',snapCopy.note));
  settingFields(data.settings.modules.snap,['modules','snap'],snap); history.appendChild(snap);
  form.appendChild(history);
  const choices = clear($('automation-loop-modules'));
  for (const id of data.modules) {
    const label=el('label'); const input=el('input');input.type='checkbox';input.value=id;
    // 水世界牌已经下架，循环入口保持未选并禁用，避免误触重新启用历史玩法。
    input.checked = id !== 'snap'; input.disabled = id === 'snap'; input.dataset.loopModule=id;
    label.append(input,document.createTextNode(' '+(id === 'snap' ? '历史活动：' + data.labels[id] : data.labels[id])));choices.appendChild(label);
  }
  $('automation-hint').textContent='已加载当前账号设置。保存后生效；新模块默认关闭。';
}

/** 读取所有参数控件生成结构化设置，禁止保存到已切换的账号。 */
function readAutomationForm() {
  if (!automationSettings || automationAccount !== current) throw new Error('账号已切换，请重新加载设置');
  const settings=structuredClone(automationSettings);
  // 编辑器根节点保存结构化值，子控件不带 data-setting，避免同一字段被重复覆盖。
  for(const input of document.querySelectorAll('input[data-setting], textarea[data-setting], select[data-setting]')) {
    const keys=input.dataset.setting.split('.');let target=settings;
    for(const key of keys.slice(0,-1)) target=target[key];
    target[keys.at(-1)] = readEditorInput(input, input.dataset.kind, input.getAttribute('aria-label') || keys.at(-1));
  }
  for (const editor of document.querySelectorAll('[data-editor][data-setting]')) {
    const keys = editor.dataset.setting.split('.'); let target = settings;
    for (const key of keys.slice(0, -1)) target = target[key];
    // 保存重新读取表单，不信任可被改写或尚未刷新的 JSON 展示文本。
    target[keys.at(-1)] = editor.readSetting();
  }
  return settings;
}

/** 将自动化执行结果中的内部模块 ID 转成面向玩家的玩法名称。 */
function automationModuleLabel(id) {
  return id ? automationModuleLabels[id] ?? id : '';
}

/** 将服务端记录的 ISO 时间转换成日志前缀，只显示浏览器本地时区的时分秒。 */
function formatAutomationTime(value) {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** 结果面板显示计划、跳过、不确定和失败状态，执行与预览分开显示。 */
function renderAutomationStatus(data) {
  automationRunning = Boolean(data.running);
  const labels={planned:'计划',success:'成功',skipped:'跳过',disabled:'未开启',uncertain:'未确认',failed:'业务失败',rejected:'服务器拒绝',error:'错误'};
  $('automation-view').textContent=(data.results||[]).map(r=>formatAutomationTime(r.at)+' ['+(labels[r.status]||r.status)+'] '+automationModuleLabel(r.module)+' '+(r.label||r.request||'')+(r.ruby?' / '+r.ruby+' 钻石':'')+(r.reason?'：'+r.reason:'')).join('\n')+(data.error?'\n中止：'+data.error:'');
  const activeModule = automationModuleLabel(data.module);
  $('automation-hint').textContent=data.looping?'循环运行中 '+(activeModule||'等待下一轮'):data.running?'正在执行 '+activeModule:'本轮已结束';
  $('automation-run').disabled=data.running;
  if (data.budget) $('automation-view').textContent += '\n账号今日钻石：已结算 '+data.budget.spent+'，预留 '+data.budget.held+'（所有角色合计）。';
  const pending = Object.values(data.ledger?.pending || {});
  if (pending.length) $('automation-view').textContent += '\n未确认记录 '+pending.length+' 条，预留 '+pending.reduce((sum,row)=>sum+row.ruby,0)+' 钻石；禁止重复提交对应动作。';
}

/** 运行中的状态轮询不触碰游戏网关，页面关闭时服务端仍按停止信号管理。 */
async function refreshAutomation() {
  if (!current || $('tab-automation').classList.contains('hidden')) return;
  const account=current;
  try { const data=await call('/api/automation/status'); if(account===current)renderAutomationStatus(data); }catch(error){if(account===current)$('automation-hint').textContent=error.message;}
}
/** 重新加载设置时保留可见错误，避免把未保存表单误报为已保存。 */
async function reloadAutomationSettings() {
  try { await loadAutomation(); } catch(error) { $('automation-hint').textContent=error.message; }
}

/** 设置确认绑定打开确认框时的账号，切换账号后必须重新确认。 */
function saveAutomationSettings() {
  let settings;try{settings=readAutomationForm();}catch(e){$('automation-hint').textContent=e.message;return;}
  const account=current;
  openConfirm('保存当前账号自动化设置',[el('div',null,'这些设置控制资源消耗、分解、放生和钻石额度。额度 0 禁止钻石消费。')],async()=>{
    if(account!==current)throw new Error('账号已切换，请重新确认当前账号设置');
    const data=await call('/api/automation/settings',{method:'POST',body:JSON.stringify({confirm:true,settings})});automationSettings=data.settings;$('automation-hint').textContent='设置已保存';
  });
}

/** 计划返回时核验账号，慢查询不能覆盖切换后的另一个账号结果。 */
async function previewAutomation() {
  const account=current;
  try {
    const data=await call('/api/automation/plan',{method:'POST',body:JSON.stringify({modules:$('automation-select').value})});
    if(account===current)renderAutomationStatus(data);
  } catch(error) { if(account===current)$('automation-hint').textContent=error.message; }
}

/** 一轮执行使用确认时已展示的账号和模块，确认框期间切换账号就拒绝提交。 */
function runAutomationRound() {
  const account=current, modules=$('automation-select').value;
  openConfirm('执行当前账号自动化一轮',[el('div',null,'按已保存设置执行所选模块。资源消耗、放生和分解立即生效；钻石消费受每日总额、模块额度和保留量共同限制。')],async()=>{
    if(account!==current)throw new Error('账号已切换，请重新确认当前账号执行');
    await call('/api/automation/run',{method:'POST',body:JSON.stringify({confirm:true,modules})});await refreshAutomation();
  });
}

/** 停止只设置服务端信号，不额外提交游戏操作。 */
async function stopAutomationRound() {
  try { await call('/api/automation/stop',{method:'POST',body:JSON.stringify({confirm:true})});await refreshAutomation(); }
  catch(error) { $('automation-hint').textContent=error.message; }
}

/** 循环选择和次数在打开确认框时固定，防止确认内容与执行参数发生变化。 */
function startAutomationLoop() {
  const account=current;
  const modules=[...document.querySelectorAll('[data-loop-module]:checked')].map(n=>n.value);
  const rounds=Number($('automation-rounds').value), everySeconds=Number($('automation-every').value);
  openConfirm('循环执行所选模块',[el('div',null,'循环使用已保存设置，未开启模块跳过。轮数 0 表示持续运行，可随时停止。')],async()=>{
    if(account!==current)throw new Error('账号已切换，请重新确认当前账号循环');
    if(!modules.length)throw new Error('请选择循环模块');
    await call('/api/loop/start',{method:'POST',body:JSON.stringify({confirm:true,rounds,everySeconds,modules,automationOnly:true})});await refreshAutomation();
  });
}
$('automation-load').onclick=reloadAutomationSettings;
$('automation-save').onclick=saveAutomationSettings;
$('automation-plan').onclick=previewAutomation;
$('automation-run').onclick=runAutomationRound;
$('automation-stop').onclick=stopAutomationRound;
$('automation-loop').onclick=startAutomationLoop;
setInterval(refreshAutomation,2000);
`;

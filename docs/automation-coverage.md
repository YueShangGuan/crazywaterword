# 自动化功能对照与离线验收

参考源为 `sea666-afk` 项目的 `sea666_*.py`，不把只有设置、没有执行器的功能计入范围。已审查请求及参考位置保存在仓库内的 `automation-protocol.json`；离线测试不需要相邻参考项目目录。
所有新模块默认关闭；计划与执行共用同一处理函数，计划不提交写请求。

跨服比拼日程、设置一次性迁移、主挂机固定领奖及每日海兽培育补做见 [跨服比拼与固定日常](competition-idle.md)。日期模式会叠加当前连接校时；“自动升星”沿用藏品碎片升星，不新增经验升级。主挂机固定领奖不受福利总开关控制，独立模块执行与预览不附带固定日常。

| 目标模块 / 设置入口 | 参考逻辑 | 请求族 | 必须验收的业务规则 |
| --- | --- | --- | --- |
| island / factory | island_once、factory、demand | OnWater、Factory、Building | 禁用工厂、配方、库存、需求优先级与队列容量 |
| farm | farm | FarmHarvest、FarmPlant、FarmSpeedUp | 成熟收割、种子不足、库存水位与田间产量 |
| resident / cargo / choiceEvent | resident、cargo、choice_event | WorkerOrder、CargoShip、SelectChoice | 过滤、冷却、重复领取、数组索引 |
| gather / afk | gather、afk_once | Fishing、Diving、Salvage、Floater、Afk | 满仓、钥匙不足、累计时长与等级奖励 |
| hero | hero | Hero、Recruit、Appoint、Enhance | 显式选择、资源不足、专武、广告与委任 |
| antique | antique | Antique、Recruit | 激活、升星、套装成员和大师等级上限 |
| pet / equip / museum | pet、equip、pet_museum | Pet、Equip、Museum | 队列、喂养、保护对象、品质阈值和探宝多阶段 |
| battle | battle、trial、league | ChallengeStage、Arena、TrialRaid、League、Expedition | 失败停止、远征血量、战令、钻石扫荡 |
| world | world、world_ext | Fleet、Pirate、Radar、ChipMine、Treasure、City、Boss、Trade | 舰队争用、维修、配比、时段和当前城市交易 |
| guild | guild | GuildPack、Order、Aid、Tech、Ship | 未入盟、互助库存、任职与补货 |
| welfare | welfare | Daily、Growth、Login、Email、Activity | 未开放、已领取、成长与活动周期 |
| activity / snap | activity、workshop、blessing、week_order、snap | Festival、BlindBox、Catcher、Workshop、Blessing、WeekOrder、Lottery、Snap | 活动结束、多步推进、钻石购买与匹配 |

验收分层：固定数据业务测试、模拟 GameClient 网关、当前 game.js 编解码核对、本地网页检查。以上均不能代表真实游戏验收。

本次合并验证中，完整 `npm test` 在本地道具图标覆盖率检查失败（1059/1207）；没有修改素材覆盖断言来绕过问题。新增离线测试及上游专项自检独立执行，结果不能代替素材完整性检查。

## 逐项功能与验收场景

下面路径均相对于 `settings.modules`，Node 函数位于 `src/automation/`。引用的 Python 文件来自参考项目 `sea666-afk`，不随本仓库分发。参考项目只有配置、没有执行逻辑的独立商店、扫描占领新资源田和贸易自动迁城不纳入补齐范围。原有手动、日常、海面和循环入口继续保留。

### 基地、农田、居民、货船、采集与挂机

| 功能 | 参考文件 / 函数 | Node 入口与主要请求 | 设置入口 | 验收场景 |
| --- | --- | --- | --- | --- |
| 建筑收取与竣工 | sea666_island_once.py / classify_collectable、finish_ready | base.island；CollectBuildingProduct、FinishUpgradeBuilding | island.collect、finish、disabledBuildings | 只收可领产物/竣工建筑；buildingId 按 repeated string 编码 |
| 建造、升级、道具加速 | sea666_island_once.py / start_builds、start_upgrades、speed_up_buildings | base.island 复用 world.planWorld；BuildBuilding、UpgradeBuilding、SpeedUpUpgradeBuilding | island.build、upgrade、speedUp | 预算、人口、材料与建筑状态满足才提交；加速仅用现有道具 |
| 工厂成品领取 | sea666_factory.py / run_factory_actions | base.island；GainFactoryProduce | island.factory.gain | 领取后刷新库存再排产 |
| 禁用与自动生产 | sea666_factory.py / auto_produce_keep_busy、run_factory_actions | base.island；CancelFactoryAutoProduce、SetFactoryAutoProduce、StartFactoryProduce | island.factory.disabledFactories、autoProduce、products | 禁用后取消自动生产，不安排新单；活动工厂交独立模块管理 |
| 居民/货船/联盟需求汇总 | sea666_demand.py / collect_demand | base.demand；OnWater、CargoShips、GuildInfo、GuildOrder | island.factory.proposedPriority | 按来源顺序累计，共用库存；未入盟不查询联盟订单 |
| 需求插队与连续排产 | sea666_factory.py / priority_produce | base.island；StartFactoryProduce | island.factory.priorityProduce | 扣除背包、队列与待领取成品；按缺口和空位连续排产；跨轮不重复 |
| 需求加速 | sea666_factory.py / run_factory_actions | base.island；SpeedUpFactoryProduce | island.factory.speedUpForDemand | 需求与道具同时存在才加速，每厂每轮至多一次；读回队列后再排产 |
| 成熟收割 | sea666_farm.py / run_farm_actions | base.farm；FarmHarvest | farm.harvest | 未成熟和空田不收，建筑数组使用当前字段 |
| 优先种植与库存水位 | sea666_farm.py / run_farm_actions | base.farm；SetAutoFarming、FarmPlant | farm.plant、priorityPlant、cropPriorities、cropKeepStock | 手工种植先关闭自动种植；计入田间产量；满田或达水位不写 |
| 缺种子生产与加速 | sea666_farm.py / produce_seed_on_demand、run_farm_actions | base.farm；StartFactoryProduce、FarmSpeedUp | farm.seedOnDemand、speedUp、speedUpMaxActions | 真实配方、未禁用工厂、足够材料才生产；每轮加速有上限 |
| 居民订单过滤与交单 | sea666_resident.py / should_skip_order、finish_eligible_orders | base.resident；FinishWorkerOrder | resident.blockedMaterials、skipCropOrders、minExp、minGold、dailyCap | 冷却、禁用材料、作物、奖励下限、库存和每日次数过滤 |
| 居民进度奖励 | sea666_resident.py / claim_progress_rewards | base.resident；GetNextOrderOTDReward | resident.orderReward | 当前赛季/开服天数的未领档位达标才领 |
| 货船装填与领奖 | sea666_cargo.py / run_cargo_actions | base.cargo；FillCargoShip、DrawShipReward | cargo.fill、reward | 状态枚举正确；只补未填舱；cargoIndex 为 1-based；库存不足跳过 |
| 选择事件 | sea666_choice_event.py / run_choice_actions | base.choiceEvent；SelectChoice | choiceEvent.optionIndex | 仅选择配置的 1/2 选项；UID 不丢 64 位精度；读推送确认消失 |
| 钓鱼、大鱼、浮漂 | sea666_gather.py | base.gather；StartFishing、GainBigFish、PickUpFloater | gather.fishing、maxFishCasts、floater、floaterCollectWhenFull | 钓鱼有次数上限；大鱼实际响应为 GainBigResponse；满仓过滤普通材料 |
| 潜水与拾荒 | sea666_gather.py | base.gather；Diving、EndSalvage | gather.diving、divingEach、salvage、salvageEach | 未开放/满仓跳过；按当前产量把垃圾数量换算为材料容量 |
| 钥匙开箱 | sea666_gather.py | base.gather；AntiqueRecruit | gather.openChests、maxChests | 只消耗现有保险箱钥匙，不购买钥匙 |
| 采集强化 | sea666_gather.py | base.gather；FishingLevelUp、DivingLevelUp、SalvageLevelUp | gather.enhance、enhanceTargetLevel | 当前等级消耗来自三种 LevelCfg；达到目标或资源不足即停 |
| 累计挂机领取 | sea666_afk_once.py / run_afk_actions | base.afk；DrawAfkReward | afk.claim、claimAfterHours | 累计 start/finish 时长，零时长不重复领；日常入口遵守相同阈值 |
| 挂机升级与等级奖励 | sea666_afk_once.py / run_afk_actions | base.afk；UpgradeAfkLevel、DrawAfkLevelReward | afk.levelUp、levelReward | 当前主线限制最高等级，逐档刷新已领奖等级 |

### 英雄、藏品、宠物、装备、博物馆与挑战

| 功能 | 参考文件 / 函数 | Node 入口与主要请求 | 设置入口 | 验收场景 |
| --- | --- | --- | --- | --- |
| 指定英雄升级/升星/技能升级 | sea666_hero.py | cultivation.hero 复用 heroes.planHeroes；HeroLevelUp、HeroStarUp、HeroSkillLevelUp | hero.heroes、levelUp、levelUpMaxActions、starUp、skillLevelUp、universal | 未选择英雄不消耗资源；单次升级只算下一等级价格；每步刷新资源 |
| 技能进阶 | sea666_hero.py | cultivation.hero；HeroSkillUpgrade | hero.skillAdvance | 所选英雄、赛季和下一进阶等级命中当前表才提交 |
| 专武升级与升星 | sea666_hero.py / run_exclusive_actions | cultivation.hero；HeroExclusiveLevelUp、HeroExclusiveStarUp | hero.exclusiveLevelUp、exclusiveStarUp | 当前星级 unlockLv 限制等级；按英雄品质选升星石；实际响应 HeroExclusiveNextUp |
| 装备与徽章强化 | sea666_hero.py / run_equip_enhance、run_badge_enhance | cultivation.hero；EnhanceEquip、EnhanceBadge | hero.equipEnhance、badgeEnhance、badgeExpItemNum | 仅所选英雄穿戴件，遵守等级上限；徽章仅用经验，不分解其他徽章 |
| 指定委任 | sea666_hero.py / run_auto_appoint | cultivation.hero；AppointHero | hero.appoint、positions、heroes | 等价替代 AutoAppoint，按选择顺序指定英雄和位置 |
| 碎片招募 | sea666_hero.py / run_frag_recruit | cultivation.hero；HeroRecruit | hero.fragRecruit、heroes | 仅未拥有的所选英雄；用当前 recruitFrag，不猜碎片数 |
| 英雄/藏品抽卡 | sea666_hero.py / run_recruit_draw；sea666_antique.py | cultivation.recruits；RecruitStart、AntiqueRecruit | hero.recruit / antique.recruit：free、tickets、maxDraws | 免费冷却到期或背包有券才抽；单轮上限明确 |
| 积分与广告 | sea666_hero.py / run_watch_skill_video；sea666_antique.py | cultivation.recruits / hero；GotHeroRecruitTask、GotAntiqueRecruitTask、WatchAdv | recruit.points、watchVideo；hero.watchSkillVideo | 积分达到未领档；广告 ID 在当前表存在且状态允许 |
| 藏品激活、升星 | sea666_antique.py / antique_once | cultivation.antique；ActivateAntique、AntiqueStarUp | antique.activate、upgrade、universal | 当前碎片足够；万能材料需单独授权；每步读回 |
| 套装激活、升级 | sea666_antique.py / antique_once | cultivation.antique；AntiqueSuitLevelUp | antique.suit.activate、levelUp | 检查套装成员、大师等级上限和费用 |
| 宠物领取、培育 | sea666_pet.py / claim_mature_pets、breed_fill_slots | cultivation.pet；GetMaturePet、PetBreed | pet.claim、breed、breedSpecies、breedMinQuality、universal | 服务端队列容量、物种和赛季匹配；breedMinQuality 在界面明确为最高允许品质 |
| 宠物喂养 | sea666_pet.py / feed_breed_jobs | cultivation.pet；PetFeed | pet.feed | 使用服务端 feedRequirements，缺料跳过 |
| 宠物升级、进阶 | sea666_pet.py / level_up_serve_pets、advance_serve_pets | cultivation.pet；PetLevelUp、PetUpgradeFeed、PetUpgrade | pet.levelUp、levelUpTargetLevel、advance、advanceRooms | 仅战备室宠物；喂满当前要求后才进阶；到目标停止 |
| 宠物放生 | sea666_pet.py / decompose_pets | cultivation.destroy；FreePet | pet.decompose、decomposeBelowQuality、protectedUids | 必须设阈值，只处理严格低于阈值者；排除战备室、舰队、主线、联盟赛、远征、锦标赛和 Ultra 编队；舰队实例数据不全则暂停 |
| 装备领取、打造、加速 | sea666_equip.py / collect_made、start_make、speed_make | cultivation.equip；PickMadeEquip、MakeEquip、SpeedMakeEquip | equip.collect、make、makeIds、universal、speedUp、speedUpMinRemainSecs | 仅用户所选且当前赛季开放配方；正在制造/材料不足不重开 |
| 装备分解 | sea666_equip.py / decompose_idle | cultivation.destroy；DecomposeEquip | equip.decompose、decomposeBelowQuality、protectedUids | 明确阈值；排除穿戴与保护 UID |
| 博物馆收益与多步探宝 | sea666_pet_museum.py / collect_museum_revenue、run_museum_explore | cultivation.museum；MuseumCollectRevenue、MuseumCompleteExplore、MuseumReward、MuseumStartExplore | museum.collectRevenue、explore、maps、factor | 完成→领奖→刷新→开新；倍率已开放且主线编队存在 |
| 探宝加速 | sea666_pet_museum.py / run_museum_explore | cultivation.museum；MuseumSpeedUpExplore | museum.speedUp、speedUpDailyLimit、speedUpKeepStock | 日次数和道具保留共同限制；0 次额度禁止 |
| 主线连续挑战与章节奖 | sea666_battle.py / run_stage | battle.battle；ChallengeStage、PassStageGotReward | battle.maxActions、stage.enabled、samePowerRetryCount、claimReward | 失败即停，显式设置才同战力重试；只领达标章节档位 |
| 竞技场挑战/扫荡 | sea666_battle.py / run_arena_challenge、run_arena_sweep | battle.arena；ArenaChallenge、ArenaSweep | battle.arena.challenge、sweep | 当前排名/战力筛选，真实 isWin 判胜负 |
| 三类试炼挑战/扫荡 | sea666_trial.py / run_trial_actions；VIP3 实机抓包 | battle.trial / vipTrialSweep；TrialRaidChallenge、WatchAdv、TrialRaidBuySweep | battle.trial.heroExp / forge / petExp：challenge、rubySweep；账号 vipFreeAd | passedStage 读回判胜；普通扫荡按 buyTimes 定价；角色等级 ≥10 且 VIP ≥3 时可独立领取每日广告额外扫荡，奖励回包确认、当日写前记次防重；详见 vip-trial-sweep.md |
| 联盟赛挑战、挂机、段位和战令奖 | sea666_league.py / run_challenge、run_hangup_reward、run_dan_reward、run_pass_reward；积分赛抓包 | battle.league；LeagueOtherFormation、LeagueFormationSequence、LeagueFight、LeagueRefreshRival、GotLeagueBonusItem、LeagueGotBonusDan、LeagueGotPassReward | battle.league.challenge、reservePoints、hangupReward、danReward、passReward | 按四人原始顺序；总战力较低且双舰队强对强均严格占优才挑战，回包必须两局全胜。无稳赢只在 refreshTimes=1 且换榜后钻石不变时免费刷新一次；仍无稳赢才强打弱、弱打强，回包一胜一负且 finalScore 不降才保分。reservePoints 保留的是 LEAGUE_POINT 挑战券，不是排名积分；读取/换位/回包异常均停止。 |
| 远征挑战与血量停止 | sea666_battle.py / run_expedition_challenge | battle.expedition；ExpeditionChooseRaid、ExpeditionChooseBuff、ExpeditionChallenge | battle.expedition.challenge、challengeStopOnHeroDeath、challengeMinTeamHpPct | 仅当前已选副本；先选待选增益；阵亡/低血停止；重启保留本周期血量基线 |
| 远征扫荡、最终奖与战令 | sea666_battle.py / run_expedition_sweep、run_expedition_final_reward、run_expedition_free_pass | battle.expedition / claimPass；ExpeditionSweep、ExpeditionGotFinalReward、BattlePassGotReward | battle.expedition.sweep、finalReward、freePass | 仅扫已通过副本；完成且未领才领奖；只领现有战令权益 |

### 世界、联盟与福利

| 功能 | 参考文件 / 函数 | Node 入口与主要请求 | 设置入口 | 验收场景 |
| --- | --- | --- | --- | --- |
| 战报奖励 | sea666_world.py / run_campaign_report_claim | world.world；QuickGotCampaignReport | world.report | 有奖励且未领才提交；战报 ID 保留 64 位 |
| 舰队维修/加速 | sea666_world.py / run_fleet_repair | world.world；RepairFleet、SpeedUpRepair | world.fleet.repair、repairThresholds、repairSpeedUp、repairSpeedUpMinRemainSecs | 只修闲置且低于各自阈值的舰队；维修加速优先用加速器，无道具或道具明确失败后按 ceil(最新剩余秒数 / 60) × 10 钻石计价并通过完整消费护栏；累计失败 3 次后不再尝试加速器 |
| 海盗挑战/扫荡 | sea666_world.py / run_pirate_attack、run_pirate_sweep | world.pirates；ChallengePirate、PirateSweep | world.pirate.attack、sweep、attackTypes、sweepTypes、attackTime | 挑已解锁档；仅扫已击败档；检查时段 |
| 雷达派遣/领奖 | sea666_world.py / run_radar | world.radar；RadarSendFleets、RadarGetReward | world.radar.enabled、claim、kinds、fixed | 按所选类型逐条领奖，替代全部领奖；每次重新取闲置舰队 |
| 已有资源田配比 | sea666_world.py / run_res_field | world.fields；MyResFields、GiveUpResField | world.resField.enabled、factory、oasis、tank | 按当前表真实产物分配；只释放已有超额类型，未知类型保留；不扫描新田 |
| 芯片矿 | sea666_world_ext.py / run_chip_mine | world.chipMine；ChipMineReward、ChipMineList、ChipMine、ChipMineSendFleet | world.chipMine.enabled、hours、dailyCap、fleets | rewardInfo.myRewardTimes 和本地日次数共同约束；检查品质、空位、战斗次数 |
| 宝藏掠夺与搁浅商船 | sea666_world_ext.py / run_treasure_loot；AutoJs merchantShip | world.treasure / world.merchantShip；TreasureLootList、TreasureLootSendFleets | world.treasureLoot；world.merchantShip.enabled、retryMinutes、fleets | 宝藏掠夺保留品质/空置/联盟过滤；搁浅商船每轮检查当前万吨货轮，按目标 UID 和跨小时派遣间隔使用配置的空闲舰队；0 表示同一目标只尝试一次，新目标立即检查，无目标或舰队全忙不计时，城战时段保留舰队 |
| 城战与在线奖励 | sea666_world_ext.py / run_city_war_online、run_city_war | world.cityWar；GotWorldOnlineRwd、SetAssembleCity、MoveFleetsToCity、SpeedUpFleet、CityRecruitDefence | world.cityWar.enabled、online、reattack、fleets[].marchSpeedUp | 开放时段、集结确认、进攻日记录防重复；行军加速只在派遣确认后按抓包协议提交并读回舰队状态；募防读取城市守军确认 |
| 世界 Boss | sea666_world_ext.py / run_world_boss | world.world；WorldBossGetDamageReward、ChallengeWorldBoss | world.worldBoss.enabled、attackTimes | 奖励按当前伤害档；attackTimes 为每日上限；不复用已占用舰队 |
| 限时 Boss | sea666_world_ext.py / run_limited_boss | world.world；LimitedBossGetReward、LimitedBossSendFleets | world.limitedBoss.enabled、challengeReward、fleets | 活动/当日时段和剩余血量同时满足；仅所选闲置舰队 |
| 贸易领奖、升级、加速 | sea666_world.py / run_trade_claim、run_trade_ops | world.trade；GotTradeReport、GotTradeAchievement、TradeCargoUpgrade、TradeSpeed、BattlePassGotReward | world.trade.enabled、claim、upgrade、speedUp、speedUpDailyLimit、profitLimit | 实际回包 GotTTradeReport；升级取 lv/upCost/upMoney；钻石升级也走预算；加速用海商王加速 |
| 商情共享、买卖与迁船 | 最新抓包 / TradeCityReport、TradeGuildRadar、TradeMove | world.trade；TradeCityReport、TradeSell、TradeCity、TradeBuy、TradeGuildRadar、TradeMove | world.trade.enabled | 到港先确认城市商情已共享；卖空旧货后用贸易金币买满最低价商品；按货物数量×买入单价×0.3 优先送往紧缺城市，无匹配时避开船舱货物特产城市后随机迁船 |
| 联盟礼包/职级奖 | sea666_guild.py / run_actions | guild.guild；GotGuildWelfarePack、GotGuildTitleReward | guild.packs.guild、title | 未入盟不发送后续请求；仅当前可领状态 |
| 联盟募兵 | sea666_guild.py / run_actions | guild.orders；FinishGuildOrder | guild.order.enabled、dailyLimit、cityIds | 城市、冷却、每日次数与材料同时满足 |
| 领取帮助/发起求助 | sea666_guild.py / run_actions | guild.aid；GotMyGuildAid、GuildAidAsk | guild.aid.receive、ask、askItems | 只领已完成帮助；只对指定且当前表存在的物品求助 |
| 帮助盟友 | sea666_guild.py / run_actions | guild.aid；GuildAidHelp | guild.aid.help、helpItems、helpNicknameKeywords、helpMinStock、helpDailyLimit | 不帮自己/过期项；物品/昵称过滤；库存高于阈值才帮，日次数封顶 |
| 联盟科技 | sea666_guild.py / run_actions | guild.guild；UpgradeGuildTech | guild.tech.enabled、items | 当前赛季/等级确定科技点费用；只升所选科技 |
| 船长与补货登船 | sea666_guild.py / run_guild_ships | guild.ships；GuildShipSeek、GuildShipOrder | guild.ship.captain、crew、qualities、rewardItems、minWaterCoin、forbiddenMaterials、relaxFilters | 品质/实际奖励/禁用材料过滤；精确补空舱；船长校验英雄、星级、专武 |
| 主线、支线、成就 | sea666_welfare.py / claim_main_tasks、claim_other_rewards | welfare.welfare 复用 tasks.surveyTasks；DrawMainTaskReward、GotAchievementReward | welfare.growth | 达到真实目标才领取；刷新新任务后再规划 |
| 日常任务与活跃宝箱 | sea666_welfare.py / claim_daily_tasks、claim_activity_boxes | welfare.welfare；DrawDailyTaskReward、DrawDailyReward、DrawWeeklyReward | welfare.dailyTask | 已领不重复；日/周宝箱按各自配置门槛 |
| 月卡/季卡/VIP 日奖 | sea666_welfare.py / claim_month_card、claim_season_card、claim_vip_daily | welfare.welfare；MonthCardDailyReward、SeasonCardGotDaily、GotVipDailyReward | welfare.daily | 仅现有未到期权益；VIP 按真实等级和已领状态，不探测等级 |
| 其他免费奖 | sea666_welfare.py / claim_other_rewards | welfare.welfare；GotFreeDailyPack、GotChannelReward、ComicDramaGotDaily、WeekLotteryFreePack、GotUniqueLotteryFree | welfare.daily | 当前表和状态决定免费项；本地日记录防止静默入口重复 |
| 新手登录/邮件 | sea666_welfare.py / claim_other_rewards、claim_email | welfare.welfare；DrawNewbieLoginReward、QuickGotReadEmail | welfare.events、email | 登录日次来自活动推送；只领未领附件，不猜新手日次 |

### 活动与水世界牌

| 功能 | 参考文件 / 函数 | Node 入口与主要请求 | 设置入口 | 验收场景 |
| --- | --- | --- | --- | --- |
| 中秋签到、免费礼包、活跃奖 | sea666_activity.py / run_mid_autumn | activity.activity；ClaimActivityDailyCheckInReward、ClaimDailyCombGift、ClaimActivityDailyActiveReward | activity.midAutumn.enabled、signIn、freeGift、activeReward | 本期及子活动均开放；按当前赛季配置免费礼包和档位 |
| 盲盒 | sea666_activity.py / run_blind_box | activity.blindBox；ClaimFreeSelectGift、BlindBoxStart、BlindBoxOpen、ClaimBlindBoxScoreReward | activity.blindBox.enabled、freeGift、scoreReward、play、keepCards | 先续已有局，每格只开一次；结算后才开新局；保留卡数 |
| 捞月挑战、续局 | sea666_activity.py / run_catcher | activity.catcher；CatcherInfo、CatcherStart、CatcherEnd | activity.catcher.enabled、play、repeat、maxStage、keepHooks | 按解锁天数与最高关筛选；保存开局真实奖励 ID；重启续局不再耗钩；缺 ID 跳过 |
| 捞月扫荡、战令 | sea666_activity.py / run_catcher | activity.catcher；CatcherSweep、BattlePassGotReward | activity.catcher.sweep、sweepStage、passReward | 已解锁且达到星级；现有钩和保留量满足；只领现有战令权益 |
| 活动工坊 | sea666_workshop.py / run_workshop | activity.workshop；GainFactoryProduce、StartFactoryProduce、SpeedUpFactoryProduce | activity.workshop.enabled、produce、gain、speedUp、keepStock、keepClaws、speedUpDailyLimit | 在产/成品抵扣水位；保留爪钩；满队列/达水位/日加速次数满即停 |
| 祝福与奖励 | sea666_blessing.py / run_blessing | activity.blessing；CelebrationDetail、CelebrationBoost、ClaimCelebrationReward | activity.blessing.enabled、boost、skinId、boostTimes、claimReward、keepKnots | 只投指定有效皮肤；用本期福运结；上限停止 |
| 不差钱商人 | sea666_week_order.py / run_week_order | activity.weekOrder；WeekOrderInfo、CommonBuyGoods、FinishWeekOrder、WeekOrderGotFinal | activity.weekOrder.enabled、buyMissingMaterials、minRubyStock | 本期开放；整单缺料都有当前价才购买；全部预算通过；买后读库存再交单 |
| 幸运转盘 | sea666_welfare.py / run_week_lottery | activity.lottery；WeekLotteryPrize、WeekLotteryTimesReward | activity.weekLottery.enabled、prize、maxDraws | 开启后可只领次数奖；prize 单独开启才耗现有币；本期阈值领奖 |
| 卡牌 PVE/续局 | sea666_snap.py / run_pve | snap.playPve；SnapStart、SnapEndRound | snap.pve、maxMatches | 新局只用本期有效打牌券；已有局优先续；共同限制能量/区域/放置；结算后不发后续回合 |
| 免费/钻石匹配 | sea666_snap.py / run_free_match | snap.snap；SnapStartMatchmaking | snap.freeMatch、diamondMatch、diamondMatchDailyLimit、matchWindows | 当前免费次数/钻石价/时段；日次数 0 禁止；统一预算 |
| 真人对局、托管 | sea666_snap.py / run_free_match | snap.playPvp / trustee；SnapEndRound、SnapPvpToggleTrustee | snap.pvpTrustee | 默认按真实回合出牌，等 SCSnapPvpRoundResult；托管需显式开；回合键包含 matchId/round |
| 放弃、取消、战令 | sea666_snap.py / run_snap | snap.snap；SnapGiveUp、SnapCancelMatchmaking、BattlePassGotReward | snap.giveUpPve、cancelMatchmaking、passReward | 只有对应进行中状态才写；空队列不发取消；不自动放弃对局 |

## 共享执行与测试对应

| 规则 | 实现 | 自动化用例前缀（test/automation.test.mjs） |
| --- | --- | --- |
| 默认关闭、严格设置、账号隔离 | settings | settings、service |
| 嵌套必填、数组、枚举、int64 | context.validateMessage、tools/describe.mjs | protocol；字段提取另自检 1586 类型 |
| 串行队列、同账号跨进程互斥、停止/断线/顶号 | context.withRoleLock / assertReady、GameClient.enqueueBusiness | execution、client、loop、API |
| 消费开关、账号总额、模块额、余额保留 | context.reserve | budget、account budget、paid legacy、week order、snap diamond |
| 多角色共用账号总额，明细隔离 | settings.accountSpending / loadLedger | account budget、service status |
| 写前预留、拒绝释放、成功结算、重启持久化 | context.action | budget、uncertain、confirmed failure |
| 超时只读核对、不直接重发、跨日保留不明记录 | context.action、businessDate | uncertain、date |
| 规划不写业务，不假设多步已完成 | 同一执行器 dryRun | budget dry plan、API、service |
| 库存、次数、舰队刷新 | context.refreshStock、common.idleFleets | factory demand、hero、module chain、chip mine、treasure |
| 日常复用已启用对应玩法并去重 | service.dailyGameplay / handledDailyIds | daily gameplay、daily dedup |
| 原付费点金/折扣/手动操作不可绕过预算 | service.guardedDailyAction / legacyAction、actions.runAction | paid legacy、manual writes |

设置按账号散列目录保存；日消费、日计数、活动和远征状态以角色账本隔离。日预算汇总同账号所有角色账本，因此换角色不能重置账号总额度或模块额度。日期统一使用 `Asia/Shanghai`。最低钻石保留量按当前角色余额及该角色的不明预留检查。

结果不明的 `pending` 持久保留并停止业务链；重启或跨日不自动重发。同一请求键在人工核对前继续禁止提交，没有自动清空或猜测成功的入口。真实验收时需结合服务端状态核对，不能用删除账本绕过额度。

## 网页、CLI 与 API

网页沿用上游主题、账号选择和写操作确认框，提供分类设置、计划、一轮执行、循环模块选择、停止、逐项结果和账号今日钻石合计。英雄页允许显式选择英雄。普通打开网页只查询本地连接状态，不自动登录。确认框绑定打开时的账号，期间切换账号则拒绝原确认。

接口沿用 `?account=<账号 id>`，省略则取现有选中账号。所有写接口 JSON 的 `confirm` 必须严格等于 `true`。校验错误返回 HTTP 400 与 `{error:"原因"}`。

| 接口 | 请求 body | 返回 / 连接行为 |
| --- | --- | --- |
| GET /api/automation/settings | 无 | `{settings, labels, modules}`；本地读取 |
| POST /api/automation/settings | `{confirm:true, settings:{...}}` | `{settings}`；严格验证并原子保存；不连接游戏 |
| POST /api/automation/plan | `{modules:"all"}` 或模块名/数组 | 等待规划完成并返回结果；需要读取当前角色游戏状态 |
| POST /api/automation/run | `{confirm:true, modules:"all"}` 或模块名/数组 | `{running:true}`；后台运行，轮询 status |
| GET /api/automation/status | 无 | `{running, looping, mode, module, results, error, ledger, budget, startedAt, completedAt}`；字段可缺省；不发游戏请求 |
| POST /api/automation/stop | `{confirm:true}` | 设置停止信号并返回状态，同时停止循环后续动作 |
| POST /api/loop/start | `{confirm:true, modules:[...], automationOnly:true, rounds:0, everySeconds:60}` | 原循环接口；0 轮持续运行；间隔至少 1 秒；无效模块在连接前拒绝 |

结果状态为 `disabled / planned / success / skipped / failed / rejected / uncertain / error`。`budget` 为账号当天 `spent / held / modules / heldModules` 合计，`ledger` 为当前角色明细。业务运行或循环等待期间拒绝另一个业务操作；本地设置、状态和停止仍可访问。

```text
node src/app.mjs automation settings
node src/app.mjs automation settings <完整设置.json>
node src/app.mjs automation plan all
node src/app.mjs automation plan farm
node src/app.mjs automation run all --yes
node src/app.mjs automation run hero --yes
```

CLI 沿用现有账号选择方式；settings 不连接游戏，plan/run 在明确调用时登录。run 必须 `--yes`。plan 不发送玩法写请求，不持久化消费或活动记录；读取活动可能需要登录同步信号。多步流程的计划只展示当前可确认的下一步，不假设前一步已成功。旧循环每轮读取共享设置；单独日常调用复用已启用玩法，防止绕过累计时长等规则。

## 验证记录与边界

运行 `npm run test:offline` 完成固定数据业务测试与当前协议自检。测试用临时隔离目录、固定配置和内存网关，模拟请求与响应都通过当前 codec；不读取真实凭证，不创建游戏 WebSocket。业务用例涵盖资源不足、满仓、未开放、未入盟、活动结束、重复领奖、失败停止、舰队争用、远征血量、跨日、停止、断线、不确定结果、预算持久化和多账号/多角色隔离。

逐请求索引由 `node tools/audit-automation.mjs --write` 生成，见 [automation-requests.md](automation-requests.md) 和 [automation-protocol.json](automation-protocol.json)。218 种参考请求分别记录字段、实现入口、响应及两处等价替代；异名响应和 Snap 的两类回合响应也做编解码核对。该索引证明协议和源码入口存在，不能代替完整业务或真实网关验收。

本地网页用 `test/local-console.mjs` 的隔离账号和 OfflineClient 验证：账号设置切换隔离、分类表单、英雄选择入口、一轮运行、循环等待状态、停止、按钮恢复、无横向溢出及无浏览器脚本错误。夹具仅监听本地端口，不连接真实账号。

`npm test` 的“食品厂图标缺失”素材基线保留原断言，单独报告；字段提取工具的嵌套字段问题已修复。离线业务用例不依赖该素材。真实战斗判定、活动发奖延迟和账号特定开放条件仍需用户另行授权真实账号验收，本次没有进行真实游戏操作。

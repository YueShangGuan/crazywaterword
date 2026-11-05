import { iconEntry } from '../art.mjs';

/**
 * 从本地游戏配置表生成表单选项，展示名与协议值分开，加载设置时无需登录游戏。
 * 城市名称按所选赛季分组，工厂产品保留所属工厂以防选到错误配方。
 * @param {{tables: Record<string, {data?: object[]}>} | null} config 本地配置表。
 * @returns {object} 仅包含表单需要的选项与关联关系。
 */
export function automationFormOptions(config) {
  /** 缺失的配置表以空列表呈现，由页面提示补充缓存，不编造游戏 ID。 */
  const rows = name => config?.tables[name]?.data ?? [];
  /** 同一业务 ID 可能有多个等级或赛季行，选择器只保留一条展示项。 */
  const unique = values => [...new Map(values.map(value => [value.value, value])).values()];
  const colors = rows('ColorViewCfg');
  const names = new Map(rows('BuildingCfg').map(row => [row.buildingType, row.name]));
  const resourceRows = rows('ResourceCfg');
  const itemRows = rows('ItemCfg');
  const itemIds = new Set(itemRows.map(row => row.id));
  const itemNames = new Map([...resourceRows, ...itemRows].map(row => [row.id, row.show_name]));
  const resourceIds = new Set(resourceRows.map(row => row.id));
  const materialRows = new Map([...resourceRows, ...itemRows].map(row => [row.id, row]));
  const cropIds = new Set(rows('FarmlandPlantCfg').map(row => row.id));
  const seedIds = new Set(rows('FarmlandPlantCfg').map(row => row.material?.[0]).filter(Boolean));

  /**
   * 将配置中的物品分类为操作者能理解的材料组；农田表优先于通用道具类型，保证种子与作物不会混入加工品。
   *
   * @param {{type?: string}} row 游戏配置中的物品或资源行。
   * @param {string} id 物品 ID。
   * @returns {string} 候选面板中显示的材料组名。
   */
  const materialGroup = (row, id) => {
    if (resourceIds.has(id)) return '资源';
    if (cropIds.has(id)) return '农作物';
    if (seedIds.has(id)) return '种子';
    if (row.type === '原料') return '基础原料';
    return row.type || '其他道具';
  };

  /**
   * 将物品或资源配置转换为图文材料候选；图集缺项时仍保留名称以供选择。
   *
   * @param {string} id 游戏中的物品或资源 ID。
   * @returns {{value: string, label: string, group: string, icon?: object}|null} 表单使用的材料候选。
   */
  const materialChoice = id => {
    const row = materialRows.get(id);
    if (!row) return null;
    const choice = { value: id, label: itemNames.get(id) ?? id, group: materialGroup(row, id) };
    const icon = iconEntry(row.pic);
    // 仅发送真实图集条目，避免浏览器为缺图材料创建无效的图片请求。
    if (icon) choice.icon = icon;
    return choice;
  };

  /**
   * 将一个业务表明确引用的物品 ID 列表转换为候选；未知 ID 不进入面板，避免把旧配置或猜测项伪装成可选材料。
   *
   * @param {Iterable<string>} ids 某项游戏业务实际使用的物品 ID。
   * @returns {Array<{value: string, label: string, group: string, icon?: object}>} 去重后的图文候选。
   */
  const materialChoices = ids => unique([...new Set(ids)].map(materialChoice).filter(Boolean));

  /**
   * 为赛季限定候选保留所属赛季；页面只展示当前设置赛季明确开放的材料。
   *
   * @param {Array<{id: string, season?: number}>} values 含物品 ID 和赛季的配置行。
   * @returns {Array<{value: string, label: string, group: string, seasons: number[], icon?: object}>} 已合并赛季的候选。
   */
  const seasonalMaterialChoices = values => {
    const seasonsById = new Map();
    for (const row of values) {
      if (!materialRows.has(row.id) || !Number.isSafeInteger(Number(row.season))) continue;
      const seasons = seasonsById.get(row.id) ?? new Set();
      seasons.add(Number(row.season)); seasonsById.set(row.id, seasons);
    }
    return [...seasonsById].map(([id, seasons]) => ({ ...materialChoice(id), seasons: [...seasons].sort((a, b) => a - b) }));
  };

  const recipes = rows('BuildingProduceCfg');
  const factoryTypes = new Set(recipes.map(row => row.buildType));
  const merchantShip = rows('TreasureLootCfg').find(row => row.name === '万吨货轮');
  const merchantRewardLibraries = new Set(merchantShip?.rewardLib ?? []);
  // type=0 才会被万吨货轮自动化匹配；资源配置中的金币、钻石即使奖励表出现也不能作为筛选条件。
  const merchantShipRewards = rows('TreasureLootRewardCfg')
    .filter(row => merchantRewardLibraries.has(row.libId) && Number(row.weight) > 0 && itemIds.has(row.reward?.[0]))
    .map(row => ({ id: row.reward[0], season: row.season }));
  const merchantShipRewardsLatestSeason = merchantShipRewards.reduce((latest, row) => {
    const season = Number(row.season);
    return Number.isSafeInteger(season) ? Math.max(latest, season) : latest;
  }, 0) || null;
  const options = {
    buildings: rows('BuildingCfg').map(row => ({ value: row.buildingType, label: row.name })),
    factories: [...factoryTypes].map(value => ({ value, label: names.get(value) ?? value })),
    products: recipes.map(row => ({ value: row.itemId, label: itemNames.get(row.itemId) ?? row.itemId, factory: row.buildType })),
    crops: rows('FarmlandPlantCfg').map(row => ({ value: row.id, label: row.id })),
    heroes: rows('HeroCfg').filter(row => row.type === '英雄').map(row => ({ value: row.id, label: row.name })),
    breedSpecies: rows('PetSpeciesCfg').map(row => ({ value: row.name, label: row.name })),
    items: materialChoices(materialRows.keys()),
    // 业务专用候选只收录配置表明确出现过的物品，防止无关礼包、外观或过期活动道具污染材料筛选。
    residentOrderMaterials: materialChoices(rows('WorkerOrderCfg').map(row => row.itemId)),
    guildAidMaterials: seasonalMaterialChoices(rows('GuildHelpCfg')),
    merchantShipRewards: seasonalMaterialChoices(merchantShipRewards),
    // 货轮奖励表滞后于已开启赛季时，页面只沿用最新一季同一奖励库，绝不回退到全量物品。
    merchantShipRewardsLatestSeason,
    // 联盟商船奖品与舱位消耗由当前 GuildShipRequest 决定，加载后由页面写入这两组动态候选。
    guildShipRewards: [],
    guildShipMaterials: [],
    qualities: colors.map(row => ({ value: row.quality, label: row.title })),
    colors: colors.map(row => ({ value: row.quality_index, label: row.title })),
    fleets: rows('BuildingUnlockCfg').filter(row => row.buildingType === '远征船').map(row => ({ value: row.buildingId, label: row.buildingId.replace('远征船', '号远征舰队') })),
    advanceRooms: rows('BuildingUnlockCfg').filter(row => row.buildingType === '宠物战备室').map(row => ({ value: row.buildingId, label: row.buildingId.replace('宠物战备室', '号海兽战备室') })),
    positions: rows('AppointPosCfg').map(row => ({ value: row.posId, label: '委任位置 ' + row.posId })),
    makeIds: rows('BuildingEquipMakeCfg').map(row => ({ value: row.makeId, label: row.type + ' · 配方 ' + row.makeId, season: row.season })),
    maps: rows('MuseumExpeditionStageCfg').map(row => ({ value: row.stageId, label: row.name })),
    pirates: unique(rows('WorldPirateCfg').map(row => ({ value: row.type, label: row.showName }))),
    kinds: unique(rows('RadarRandEventCfg').map(row => ({ value: row.type, label: row.type }))),
    tech: rows('GuildTechCfg').map(row => ({ value: row.techId, label: row.name, season: row.season })),
    cities: {},
  };
  for (const name of Object.keys(config?.tables ?? {})) {
    const match = /^(\d+)_CityCfg$/.exec(name);
    if (match) options.cities[match[1]] = rows(name).map(row => ({ value: row.id, label: row.name }));
  }
  return options;
}

/**
 * 从当前服务端联盟商船状态提取实际可见的奖励和舱位消耗材料，避免用泛用道具表猜测本轮内容。
 *
 * @param {{tables: Record<string, {data?: object[]}>} | null} config 本地游戏配置表。
 * @param {Array<{reward?: {asset?: Array<{type?: number, id?: string}>}, cabin?: Array<{order?: Array<{type?: number, id?: string}>}>}>} ships 当前可补给商船。
 * @returns {{rewards: object[], materials: object[]}} 仅含当前服务端已返回 type=0 物品的候选组。
 */
export function guildShipMaterialOptions(config, ships) {
  const all = new Map(automationFormOptions(config).items.map(choice => [choice.value, choice]));
  /** 从资产列表保留普通道具 ID；资源枚举与未知配置不作为可筛选的材料候选。 */
  const fromAssets = assets => [...new Set((assets ?? [])
    .filter(asset => Number(asset?.type) === 0 && typeof asset.id === 'string')
    .map(asset => asset.id))]
    .map(id => all.get(id))
    .filter(Boolean);
  return {
    rewards: fromAssets((ships ?? []).flatMap(ship => ship.reward?.asset ?? [])),
    materials: fromAssets((ships ?? []).flatMap(ship => (ship.cabin ?? []).flatMap(cabin => cabin.order ?? []))),
  };
}

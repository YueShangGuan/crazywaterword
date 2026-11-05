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
  const itemNames = new Map([...rows('ResourceCfg'), ...rows('ItemCfg')].map(row => [row.id, row.show_name]));
  /**
   * 将物品或资源配置转换为图文材料候选；图集缺项时仍保留名称以供选择。
   *
   * @param {{id: string, pic?: string}} row 游戏配置中的物品或资源行。
   * @returns {{value: string, label: string, icon?: object}} 表单使用的材料候选。
   */
  const materialChoice = row => {
    const choice = { value: row.id, label: itemNames.get(row.id) ?? row.id };
    const icon = iconEntry(row.pic);
    // 仅发送真实图集条目，避免浏览器为缺图材料创建无效的图片请求。
    if (icon) choice.icon = icon;
    return choice;
  };
  // 资源与道具使用同一候选集；相同 ID 以后出现的道具配置覆盖资源配置，与原展示名称规则一致。
  const materialChoices = new Map([...rows('ResourceCfg'), ...rows('ItemCfg')].map(row => [row.id, materialChoice(row)]));
  const recipes = rows('BuildingProduceCfg');
  const factoryTypes = new Set(recipes.map(row => row.buildType));
  const options = {
    buildings: rows('BuildingCfg').map(row => ({ value: row.buildingType, label: row.name })),
    factories: [...factoryTypes].map(value => ({ value, label: names.get(value) ?? value })),
    products: recipes.map(row => ({ value: row.itemId, label: itemNames.get(row.itemId) ?? row.itemId, factory: row.buildType })),
    crops: rows('FarmlandPlantCfg').map(row => ({ value: row.id, label: row.id })),
    heroes: rows('HeroCfg').filter(row => row.type === '英雄').map(row => ({ value: row.id, label: row.name })),
    breedSpecies: rows('PetSpeciesCfg').map(row => ({ value: row.name, label: row.name })),
    items: [...materialChoices.values()],
    // 万吨货轮协议的 type=0 只会返回 ItemCfg 道具；资源币种不作为可配置的匹配材料。
    rewardMaterials: unique(rows('ItemCfg').map(materialChoice)),
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

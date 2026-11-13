// 轻量游戏配置卡片（舰队族/领奖族的关键字段），走既有 /api/settings 路由。
// 完整字段与只读预览仍以「游戏配置」全量编辑器（UI 迁移波）为准；高级需求用 JSON 模式。
export const SETTINGS_SCRIPT = String.raw`
const gsSchema = [
  ['巨轮调度', [
    ['treasure.enabled', '启用宝藏派舰', 'bool'],
    ['treasure.follow', '跟随指定玩家出发（需配置 followPlayerIds）', 'bool'],
    ['treasure.petrolReserve', '汽油保留', 'num'],
    ['treasure.checkEverySeconds', '检查间隔（秒）', 'num'],
  ]],
  ['联盟情报', [
    ['radar.enabled', '启用联盟情报（接管旧雷达开关）', 'bool'],
    ['radar.petrolReserve', '汽油保留', 'num'],
    ['radar.checkEverySeconds', '检查间隔（秒）', 'num'],
  ]],
  ['世界Boss', [
    ['worldBoss.enabled', '启用首战派遣', 'bool'],
    ['worldBoss.petrolReserve', '汽油保留', 'num'],
  ]],
  ['城战接续（内核参数，供自动化·世界模块读取）', [
    ['cityWar.petrolReserve', '行军汽油保留（0 不预算）', 'num'],
    ['cityWar.nativeCommissionLimit', '原生委任额度：-1 跟随 VIP / 0 全接管 / N 保留 N 队', 'num'],
    ['cityWar.targetPriority', '选城策略', 'select:fewestAllied=本盟排队少者优先|declaration=按宣战顺序'],
  ]],
  ['装备锻造', [
    ['forge.enabled', '启用锻造（接管自动化·装备厂开关）', 'bool'],
    ['forge.decompose', '启用自动分解（检查穿戴与海兽值守占用）', 'bool'],
    ['forge.goldReserve', '金币保留', 'num'],
    ['forge.dailyLimit', '每日锻造次数上限', 'num'],
  ]],
  ['广告奖励', [
    ['ads.noPrivilege', '无免广告权益账号走真实看广告等待', 'bool'],
    ['ads.waitSeconds', '广告等待秒数', 'num'],
  ]],
];
let gsDoc = null, gsRevision = null, gsBaseRevision = null;
const gsGet = path => path.split('.').reduce((o, key) => (o == null ? o : o[key]), gsDoc);
const gsSet = (path, value) => {
  const keys = path.split('.'), last = keys.pop();
  let node = gsDoc;
  for (const key of keys) node = node[key];
  node[last] = value;
};
function gsRender() {
  const box = $('game-settings-fields');
  box.textContent = '';
  for (const [group, fields] of gsSchema) {
    box.append(el('div', 'k', group));
    for (const [path, label, kind] of fields) {
      const row = el('label', 'bar');
      const value = gsGet(path);
      let input;
      if (kind === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(value);
      } else if (kind.startsWith('select:')) {
        input = document.createElement('select');
        for (const option of kind.slice(7).split('|')) {
          const [v, text] = option.split('=');
          const node = document.createElement('option');
          node.value = v; node.textContent = text;
          if (String(value ?? '') === v) node.selected = true;
          input.append(node);
        }
      } else {
        input = document.createElement('input');
        input.type = 'number';
        input.value = value ?? 0;
      }
      input.dataset.gsPath = path;
      input.dataset.gsKind = kind.startsWith('select:') ? 'text' : kind;
      input.addEventListener('change', () => gsSet(path, input.dataset.gsKind === 'bool' ? input.checked : input.dataset.gsKind === 'num' ? Number(input.value) : input.value));
      row.append(el('span', 'k', label), input);
      box.append(row);
    }
  }
}
async function gsSave() {
  const hint = $('game-settings-hint');
  hint.textContent = '保存中…';
  try {
    const saved = await call('/api/settings', { method: 'POST', body: JSON.stringify({ settings: gsDoc, revision: gsRevision, baseRevision: gsBaseRevision }) });
    gsDoc = saved.settings; gsRevision = saved.revision; gsBaseRevision = saved.baseRevision;
    gsRender();
    hint.textContent = '';
  } catch (error) { hint.textContent = '保存失败：' + error.message; }
}
function gsToggleJson() {
  const box = $('game-settings-text');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return gsSave(); }
  box.classList.remove('hidden');
  box.value = JSON.stringify(gsDoc, null, 2);
  box.onchange = () => {
    try {
      gsDoc = JSON.parse(box.value);
      gsRender();
      $('game-settings-hint').textContent = 'JSON 已应用，请点击保存配置写盘';
    } catch (error) { $('game-settings-hint').textContent = 'JSON 解析失败：' + error.message; }
  };
}
async function gsLoad() {
  const hint = $('game-settings-hint');
  try {
    const data = await call('/api/settings');
    gsDoc = data.settings; gsRevision = data.revision; gsBaseRevision = data.baseRevision;
    gsRender();
    hint.textContent = '';
  } catch (error) { hint.textContent = '加载失败：' + error.message; }
}
$('game-settings-save').addEventListener('click', () => gsSave().catch(() => {}));
$('game-settings-json').addEventListener('click', () => gsToggleJson());
`;

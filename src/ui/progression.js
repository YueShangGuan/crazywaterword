// Loaded into the console page alongside its shared account, table and log helpers.
const progressionViews = [
  { id: 'trial', tab: 'stages', path: '/api/trials', render: renderTrialProgress },
  { id: 'equipment', tab: 'heroes', path: '/api/equipment', render: renderEquipment },
  { id: 'guild', tab: 'dailies', path: '/api/guild', render: renderGuild },
  { id: 'hunt', tab: 'activities', path: '/api/pirates/hunt', render: renderHunt },
  { id: 'formation', tab: 'activities', path: '/api/fleets/formation', render: renderFormations },
];
const pendingProgression = new Set();
let progressionVersion = 0;

async function refreshProgression() {
  const version = ++progressionVersion;
  const account = current;
  const views = progressionViews.filter(v => !$('tab-' + v.tab).classList.contains('hidden'));
  await Promise.all(views.map(async view => {
    const box = clear($(view.id + '-view'));
    if (!account || snapshot.paused || disconnected.has(account)) {
      box.textContent = !account ? '请先选择账号' : snapshot.paused ? '账号已暂停' : '请先连接账号';
      return;
    }
    box.textContent = '正在读取…';
    try {
      const data = await call(view.path);
      if (version !== progressionVersion || account !== current) return;
      view.render(clear(box), data, account);
    } catch (error) {
      if (version === progressionVersion && account === current) {
        reportError(error);
        box.textContent = '读取失败，详情见运行日志';
      }
    }
  }));
}

for (const id of ['trial', 'guild', 'equipment']) $(id + '-refresh').onclick = refreshProgression;

function progressionAction(label, path, payload, account, reason) {
  const key = JSON.stringify([account, path, payload]);
  const button = smallButton(pendingProgression.has(key) ? '执行中…' : label);
  button.disabled = Boolean(reason) || pendingProgression.has(key);
  if (reason) button.title = reason;
  button.onclick = async () => {
    if (current !== account || snapshot.paused || disconnected.has(account) || button.disabled || pendingProgression.has(key)) return;
    pendingProgression.add(key);
    button.disabled = true;
    button.textContent = '执行中…';
    try {
      await call(path, { method: 'POST', body: JSON.stringify({ ...payload, confirm: true }) });
    } catch (error) { if (account === current) reportError(error); }
    finally {
      pendingProgression.delete(key);
      if (account === current) {
        await refreshProgression();
        if (path === '/api/pirates/hunt' && !$('tab-activities').classList.contains('hidden')) refreshActivities();
      }
    }
  };
  return button;
}

function choice(bar, title, options) {
  const label = el('label', 'choice-field');
  label.appendChild(el('span', 'dim', title));
  const control = component('ui-select');
  const select = control.querySelector('select');
  select.setAttribute('aria-label', title);
  for (const item of options) {
    const option = new Option(item.text, item.value);
    option.disabled = Boolean(item.disabled);
    select.add(option);
  }
  const first = options.find(item => !item.disabled);
  if (first) select.value = first.value;
  else select.disabled = true;
  label.appendChild(control);
  bar.appendChild(label);
  return select;
}

function renderTrialProgress(box, rows, account) {
  for (const row of rows) {
    const item = el('div', 'progression-row');
    const body = el('div');
    body.appendChild(el('strong', null, row.name));
    if (row.passed != null) body.appendChild(el('p', 'dim', '已通关 ' + row.passed + ' 关 · 今日免费扫荡剩余 ' + row.freeLeft + ' 次'));
    if (row.sweepHint) body.appendChild(el('p', 'dim', row.sweepHint));
    if (row.sweepRewards) body.appendChild(el('p', 'dim', '扫荡掉落 · ' + row.sweepRewards));
    if (row.next) body.appendChild(el('p', null, '第 ' + row.next.level + ' 关 · 参考战力 ' + fmt(row.next.power) + ' · ' + row.next.rewards));
    if (row.reason) body.appendChild(el('p', 'dim', row.failed ? '进度读取失败，详情见运行日志' : row.reason));
    item.appendChild(body);
    if (row.next && !row.reason) item.appendChild(progressionAction('挑战第 ' + row.next.level + ' 关', '/api/trials/challenge',
      { raidId: row.raidId, stageId: row.next.id }, account));
    box.appendChild(item);
  }
}

function renderEquipment(box, data, account) {
  if (data.locked) { box.textContent = '英雄装备在角色 ' + data.requiredLevel + ' 级开放'; return; }
  box.appendChild(el('p', null, '持有装备 ' + data.items.length + ' 件 · ' + data.ironName + ' ' + fmt(data.iron)));
  if (!data.items.length) { box.appendChild(el('p', 'dim', '装备仓库为空。获得装备后可在这里穿戴和强化。')); return; }
  const heroNames = new Map(data.heroes.map(h => [h.heroId, h.name]));
  const bar = el('div', 'bar');
  const equipped = el('div');
  if (data.heroes.length) {
    const select = choice(bar, '选择英雄', data.heroes.map(h => ({ value: h.heroId, text: h.name })));
    const draw = () => {
      const hero = data.heroes.find(h => h.heroId === select.value);
      clear(equipped);
      if (!hero) return;
      equipped.appendChild(table(['部位', '已穿戴', '可补空槽'], hero.slots.map(s => [s.type, s.item?.name || '空槽', s.suggested?.name || '—'])));
      if (hero.slots.some(s => s.suggested)) equipped.appendChild(progressionAction('为' + hero.name + '补齐空槽', '/api/equipment/wear', { heroId: hero.heroId }, account));
    };
    select.onchange = draw;
    draw();
    box.append(bar, equipped);
  }
  box.appendChild(table(['装备', '部位', '穿戴者', '等级', '升一级'], data.items.map(item => {
    const cost = item.nextCost;
    return [item.name, item.type || '未知', item.owner ? heroNames.get(item.owner) || '已穿戴' : '闲置',
      fmt(item.level), cost == null ? '已达上限或不可强化' : progressionAction('强化 · ' + fmt(cost) + ' ' + data.ironName,
        '/api/equipment/enhance', { uid: item.uid, expectedLevel: item.level, maxCost: cost }, account,
        cost > data.iron ? data.ironName + '不足' : '')];
  })));
}

function renderGuild(box, data, account) {
  if (data.state !== 'member') { box.textContent = data.reason; return; }
  box.appendChild(el('strong', null, data.name + ' · ' + fmt(data.level) + ' 级 · ' + fmt(data.memberCount) + ' 人'));
  box.appendChild(el('p', null, data.welfareCount == null ? '福利领取记录待确认' : '待领福利礼包 ' + data.welfareCount + ' 份'));
  if (data.welfareCount > 0) box.appendChild(progressionAction('领取联盟福利礼包', '/api/guild/welfare', {}, account));
  if (data.requests.length) box.appendChild(table(['求助成员', '所需材料', '需要数量'], data.requests.map(r => [r.requester, r.material, fmt(r.quantity)])));
  else box.appendChild(el('p', 'dim', data.aidError ? '求助列表读取失败，详情见运行日志' : '目前没有成员求助'));
}

function renderHunt(box, data, account) {
  if (data.locked) { box.textContent = data.reason || '世界在角色 ' + data.required + ' 级开放'; return; }
  box.appendChild(el('p', null, '汽油 ' + fmt(data.fuel) + ' · 单队出征消耗 ' + fmt(data.fuelPerFleet)));
  if (data.reason) box.appendChild(el('p', 'dim', data.reason));
  if (data.fleets?.length) box.appendChild(table(['舰队', '编队英雄', '战力', '耐久', '状态'], data.fleets.map(f => [
    f.name, f.heroes.join('、') || '未布阵', fmt(f.power), fmt(f.durability), f.reason || '可出征'])));
  if (!data.fleets?.length || !data.targets?.length || data.reason) return;
  const bar = el('div', 'bar');
  const target = choice(bar, '首杀目标', data.targets.map(t => ({ value: t.targetKey, disabled: t.reason,
    text: [t.name + ' ' + t.level + ' 级', t.location, t.reason].filter(Boolean).join(' · ') })));
  const fleet = choice(bar, '出征舰队', data.fleets.map(f => ({ value: f.key, text: [f.name, f.reason].filter(Boolean).join(' · '), disabled: f.reason })));
  const actions = el('div');
  const draw = () => {
    clear(actions);
    if (target.disabled || fleet.disabled) return;
    actions.appendChild(progressionAction('派遣所选舰队', '/api/pirates/hunt', { targetKey: target.value, fleetKey: fleet.value }, account));
  };
  target.onchange = fleet.onchange = draw;
  draw();
  box.append(bar, actions);
}

function renderFormations(box, data, account) {
  if (data.locked) return;
  box.appendChild(el('strong', null, '远征舰队编队'));
  if (!data.docks.length) { box.appendChild(el('p', 'dim', '尚未建成远征舰队')); return; }
  for (const dock of data.docks) {
    const row = el('div', 'progression-row'), detail = el('div');
    detail.appendChild(el('strong', null, dock.name));
    if (dock.heroes.length) detail.appendChild(el('p', null, (dock.saved ? '已编队' : '首次编队预览') + ' · ' + dock.heroes.map(h => h.name).join('、')));
    detail.appendChild(el('p', 'dim', dock.reason || (dock.visible ? '已在世界舰队列表' : '世界地图尚未列出这支舰队')));
    row.appendChild(detail);
    if (!dock.saved && !dock.reason && dock.previewKey) row.appendChild(progressionAction('保存这套首次编队',
      '/api/fleets/formation', { buildingId: dock.buildingId, previewKey: dock.previewKey }, account));
    box.appendChild(row);
  }
}

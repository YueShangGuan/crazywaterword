// Loaded into the console page alongside its shared account, table and log helpers.
const progressionViews = [
  { id: 'trial', tab: 'stages', path: '/api/trials', render: renderTrialProgress },
  { id: 'equipment', tab: 'heroes', path: '/api/equipment', render: renderEquipment },
  { id: 'crafting', tab: 'heroes', path: '/api/equipment/crafting', render: renderCrafting },
  { id: 'lineup', tab: 'heroes', path: '/api/lineups', render: renderLineups },
  { id: 'guild', tab: 'dailies', path: '/api/guild', render: renderGuild },
  { id: 'pirate-board', tab: 'activities', path: '/api/pirates/board', render: renderPirateBoard },
];
const pendingProgression = new Set();
let progressionVersion = 0;
let craftingTimer;

async function refreshProgression() {
  clearTimeout(craftingTimer);
  const version = ++progressionVersion;
  const account = current;
  const views = progressionViews.filter(v => !$(v.id + '-view').closest('.hidden,[hidden]'));
  await Promise.all(views.map(view => refreshProgressionView(view, version, account)));
}

async function refreshProgressionView(view, version, account, retrySeconds = 15) {
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
    if (view.id === 'crafting' && !document.hidden && data.state === 'making' && data.serverNow > 0 && data.job?.finishTime > 0) {
      const remaining = data.job.finishTime - data.serverNow;
      const delay = remaining > 0 ? remaining + 1 : retrySeconds;
      const nextRetry = remaining > 0 ? 15 : Math.min(retrySeconds * 2, 60);
      craftingTimer = setTimeout(() => {
        if (version === progressionVersion && account === current && !document.hidden && !$('tab-heroes').classList.contains('hidden')) {
          void refreshProgressionView(view, version, account, nextRetry);
        }
      }, delay * 1000);
    }
  } catch (error) {
    if (version === progressionVersion && account === current) {
      reportError(error);
      box.textContent = '读取失败，详情见运行日志';
    }
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(craftingTimer);
  if (!document.hidden && !$('tab-heroes').classList.contains('hidden')) void refreshProgression();
});

for (const id of ['trial', 'guild', 'equipment', 'crafting', 'lineup']) $(id + '-refresh').onclick = refreshProgression;

function progressionAction(label, path, payload, account, reason, group) {
  const key = JSON.stringify(group ? [account, group] : [account, path, payload]);
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

function craftingCosts(costs) {
  return table(['材料', { label: '需要', num: true }, { label: '库存', num: true }, '备料', '来源'], costs.map(c => {
    const missing = c.need - c.have;
    return [c.name, { text: fmt(c.need), num: true }, { text: fmt(c.have), num: true },
      el('span', missing > 0 ? 'warn' : 'ok', missing > 0 ? '缺 ' + fmt(missing) : '已备齐'),
      c.sources.join('、') || '—'];
  }));
}

function renderCrafting(box, data, account) {
  const { state, job, recipes, buildingId } = data;
  const labels = { locked: '尚未开放', unbuilt: '待建', building: '建造中', idle: '空闲', making: '制作中', ready: '成品待领' };
  box.appendChild(el('strong', null, '装备厂 · ' + labels[state]));
  if (data.reason) box.appendChild(el('p', 'dim', data.reason));
  if (state === 'locked' || state === 'unbuilt' || state === 'building') {
    if (data.buildFinishTime) box.appendChild(el('p', null, '建造完成时间 · ' + when(data.buildFinishTime * 1000)));
    if (state !== 'building' && data.buildCosts.length) {
      box.appendChild(craftingCosts(data.buildCosts));
      if (state === 'unbuilt') box.appendChild(el('p', 'dim', '材料备齐后，可在「挂机 → 海面」开启空位建造。'));
    }
    return;
  }

  const base = '/api/equipment/crafting';
  if (job) {
    const detail = el('div');
    const product = job.equipId && job.equipName && job.equipName !== job.equipId ? job.equipName : job.name;
    detail.appendChild(el('strong', null, product));
    if (job.equipId && job.star != null) detail.appendChild(el('span', 'dim', ' · ' + fmt(job.star) + ' 星'));
    if (job.finishTime) detail.appendChild(el('p', 'dim', '制作完成时间 · ' + when(job.finishTime * 1000)));
    box.appendChild(detail);
    if (state === 'ready') box.appendChild(progressionAction('领取成品', base + '/collect',
      { buildingId, previewKey: job.previewKey }, account, job.previewKey ? '' : data.reason || '请刷新并确认当前成品', 'crafting'));
  }
  if (!recipes.length) {
    box.appendChild(el('p', 'dim', '当前没有可查看的制作配方。'));
    return;
  }

  const bar = el('div', 'bar');
  const select = choice(bar, '制作配方', recipes.map(r => ({
    value: String(r.makeId), text: r.name + (r.canStart ? ' · 可制造' : ''),
  })));
  const available = recipes.find(r => r.canStart);
  if (available) select.value = String(available.makeId);
  const preview = el('div', 'progression-view');
  const draw = () => {
    const recipe = recipes.find(r => String(r.makeId) === select.value);
    clear(preview).appendChild(el('p', null, recipe.type + ' · 基础工时 ' + fmt(recipe.seconds / 60) + ' 分钟'));
    preview.appendChild(craftingCosts(recipe.costs));
    if (recipe.reason && recipe.reason !== data.reason) preview.appendChild(el('p', 'dim', recipe.reason));
    if (state === 'idle') preview.appendChild(progressionAction('制作一件' + recipe.name, base + '/start',
      { buildingId, makeId: recipe.makeId, previewKey: recipe.previewKey }, account,
      recipe.canStart && recipe.previewKey ? '' : recipe.reason || '当前无法制造', 'crafting'));
  };
  select.onchange = draw;
  draw();
  box.append(bar, preview);
}

function renderGuild(box, data, account) {
  if (data.state !== 'member') { box.textContent = data.reason; return; }
  box.appendChild(el('strong', null, data.name + ' · ' + fmt(data.level) + ' 级 · ' + fmt(data.memberCount) + ' 人'));
  box.appendChild(el('p', null, data.welfareCount == null ? '福利领取记录待确认' : '待领福利礼包 ' + data.welfareCount + ' 份'));
  if (data.welfareCount > 0) box.appendChild(progressionAction('领取联盟福利礼包', '/api/guild/welfare', {}, account));
  if (data.requests.length) box.appendChild(table(['求助成员', '所需材料', '需要数量'], data.requests.map(r => [r.requester, r.material, fmt(r.quantity)])));
  else box.appendChild(el('p', 'dim', data.aidError ? '求助列表读取失败，详情见运行日志' : '目前没有成员求助'));
}

function pirateSection(box, title) {
  const section = el('section', 'pirate-section');
  section.appendChild(el('h3', null, title));
  box.appendChild(section);
  return section;
}

function formationGrid(heroes) {
  const cols = Math.max(4, ...heroes.map(h => h.x ?? 0)), rows = Math.max(5, ...heroes.map(h => h.y ?? 0));
  const grid = el('div', 'formation-grid');
  grid.style.setProperty('--cols', cols);
  for (let y = 1; y <= rows; y++) {
    for (let x = 1; x <= cols; x++) {
      const hero = heroes.find(h => h.x === x && h.y === y);
      grid.appendChild(el('div', hero ? 'formation-cell filled' : 'formation-cell', hero?.name ?? ''));
    }
  }
  return grid;
}

function renderPirateFleets(box, data, account) {
  const section = pirateSection(box, '1. 舰队布局');
  const { formation, hunt } = data;
  if (formation.error) { section.appendChild(el('p', 'dim', '舰队读取失败，详情见运行日志')); return; }
  if (formation.locked) { section.appendChild(el('p', 'dim', '世界在角色 ' + formation.requiredLevel + ' 级开放')); return; }
  if (!formation.docks.length) { section.appendChild(el('p', 'dim', '尚未建成远征舰队')); return; }
  for (const dock of formation.docks) {
    const fleet = hunt.fleets?.find(row => row.name === dock.name);
    section.appendChild(el('strong', null, dock.name));
    const meta = el('div', 'pirate-meta');
    if (fleet) meta.append(el('span', null, '战力 ' + fmt(fleet.power)), el('span', null, '耐久 ' + fmt(fleet.durability)), el('span', fleet.reason ? 'warn' : 'ok', fleet.reason || '可出征'));
    else meta.appendChild(el('span', 'dim', dock.reason || '世界地图尚未列出这支舰队'));
    section.appendChild(meta);
    if (dock.heroes.length) section.appendChild(formationGrid(dock.heroes));
    if (!dock.saved && !dock.reason && dock.previewKey) section.appendChild(progressionAction('保存这套首次编队',
      '/api/fleets/formation', { buildingId: dock.buildingId, previewKey: dock.previewKey }, account));
  }
}

function renderPirateTargets(box, data, account) {
  const section = pirateSection(box, '2. 下一档目标');
  const { tracker, hunt } = data;
  if (tracker.error) { section.appendChild(el('p', 'dim', '目标读取失败，详情见运行日志')); return; }
  const meta = el('div', 'pirate-meta');
  meta.appendChild(el('span', null, '第 ' + tracker.season + ' 赛季'));
  if (hunt.fuel != null) meta.appendChild(el('span', null, '汽油 ' + fmt(hunt.fuel) + ' · 单队出征 ' + fmt(hunt.fuelPerFleet)));
  section.appendChild(meta);
  if (hunt.reason) section.appendChild(el('p', 'warn', hunt.reason));
  const fleets = (hunt.fleets ?? []).filter(row => !row.reason);
  let fleetSelect;
  if (fleets.length > 1) {
    const bar = el('div', 'bar');
    fleetSelect = choice(bar, '出征舰队', fleets.map(row => ({ value: row.key, text: row.name + ' · 战力 ' + fmt(row.power) })));
    section.appendChild(bar);
  }
  const cards = el('div', 'pirate-targets');
  const cardsDraw = [];
  for (const row of tracker.targets) {
    const card = el('article', 'pirate-target');
    card.appendChild(el('h4', null, row.name + ' ' + row.level + ' 级'));
    card.appendChild(el('span', 'dim', row.finished ? '全部首杀已完成' : '已击败至 ' + (row.cleared ?? '?') + ' 级 · 地图上 ' + (row.visible ?? '?') + ' 个'));
    card.appendChild(el('span', null, '建议战力 ' + fmt(row.power)));
    card.appendChild(el('span', 'dim', '首杀奖励 · ' + (row.materials || '无')));
    const matches = (hunt.targets ?? []).filter(target => target.name === row.name && target.level === row.level);
    const available = matches.filter(target => !target.reason);
    const holder = el('div', 'pirate-section');
    card.appendChild(holder);
    let location;
    if (available.length > 1) {
      const bar = el('div');
      location = choice(bar, '选择地点', available.map(target => ({ value: target.targetKey, text: target.location })));
      card.insertBefore(bar, holder);
    }
    const draw = () => {
      clear(holder);
      if (!available.length) {
        holder.appendChild(el('span', 'dim', matches[0]?.reason || hunt.reason || '地图上暂无可派遣的目标'));
        return;
      }
      const fleet = fleets.find(item => item.key === fleetSelect?.value) ?? fleets[0];
      if (!fleet) { holder.appendChild(el('span', 'dim', '没有可出征的舰队')); return; }
      const ratio = row.power > 0 ? Math.round(num(fleet.power) / row.power * 100) : 100;
      if (ratio < 100) holder.appendChild(el('span', 'warn', '舰队战力只有建议战力的 ' + ratio + '%，很可能失败，仍会消耗汽油和耐久'));
      holder.appendChild(progressionAction(ratio < 100 ? '仍然派遣' : '派遣', '/api/pirates/hunt',
        { targetKey: location?.value ?? available[0].targetKey, fleetKey: fleet.key }, account));
    };
    if (location) location.onchange = draw;
    cardsDraw.push(draw);
    draw();
    cards.appendChild(card);
  }
  if (fleetSelect) fleetSelect.onchange = () => cardsDraw.forEach(draw => draw());
  section.appendChild(cards);
}

function renderPirateProgress(box, data) {
  const section = pirateSection(box, '3. 战况与排行');
  const list = el('ul', 'pirate-list');
  for (const flight of data.flights ?? []) list.appendChild(el('li', null, flight.label));
  for (const row of data.reports.pirates ?? []) {
    list.appendChild(el('li', row.win ? 'ok' : 'bad', when(row.time * 1000) + ' · ' + row.name + ' · ' + (row.win ? '胜利' : '失败')
      + (row.rewards ? ' · ' + (row.received ? '已领 ' : '待领 ') + row.rewards : '')));
  }
  if (list.childElementCount) section.appendChild(list);
  else section.appendChild(el('p', 'dim', data.reports.error ? '战报读取失败，详情见运行日志' : '还没有海盗战报'));
  section.appendChild(el('p', 'dim', '地图上的海盗和其他玩家共享，可能先被别人打掉，刷新后再选其他地点。'));
  const rank = data.rank;
  if (rank.error) section.appendChild(el('p', 'dim', '排行读取失败，详情见运行日志'));
  else if (rank.open && rank.top.length) {
    section.appendChild(el('p', 'dim', '剿匪冲榜是全服排名，排名奖励在活动结束后结算，前排含联盟福利礼包。'));
    const board = el('ul', 'pirate-list');
    for (const row of rank.top) board.appendChild(el('li', null, '第 ' + row.rank + ' 名 · ' + row.nickname + ' · ' + fmt(row.value) + ' 分'));
    if (rank.me) board.appendChild(el('li', 'ok', '我 · ' + (rank.me.rank ? '第 ' + rank.me.rank + ' 名' : '未上榜') + ' · ' + fmt(rank.me.value ?? rank.progress) + ' 分'));
    section.appendChild(board);
  }
}

function renderPirateBoard(box, data, account) {
  renderPirateFleets(box, data, account);
  renderPirateTargets(box, data, account);
  renderPirateProgress(box, data);
}

const lineupSelection = new Map();

function lineupHeroes(rec) {
  return rec.heroes.map(h => h.role ? h.name + '（' + h.role + '）' : h.name).join('、');
}

function lineupPower(rec) {
  const box = el('div');
  box.appendChild(el('div', null, fmt(rec.power)));
  if (rec.isCurrent) return box;
  box.appendChild(el('small', rec.delta < 0 ? 'warn' : 'ok', (rec.delta < 0 ? '比当前低 ' : '比当前高 ') + fmt(Math.abs(rec.delta))));
  return box;
}

function lineupName(rec) {
  const box = el('div');
  box.appendChild(el('strong', null, rec.label));
  box.appendChild(el('div', 'dim', rec.presetName));
  if (rec.note) box.appendChild(el('div', 'warn', rec.note));
  if (rec.pet) box.appendChild(el('div', 'dim', rec.pet));
  return box;
}

function renderLineupTarget(box, target, account) {
  if (target.reason) box.appendChild(el('p', 'dim', target.reason));
  if (target.hint) box.appendChild(el('p', 'dim', target.hint));
  if (target.current) {
    const names = target.current.heroes.map(h => h.name).join('、');
    box.appendChild(el('p', null, names
      ? '当前阵容 · ' + target.current.presetName + ' · 总战力 ' + fmt(target.current.power) + ' · ' + names
      : '当前阵容为空'));
  }
  if (!target.current) return;
  if (target.recommended.length) {
    box.appendChild(table(['推荐阵容', '英雄与分工', '总战力', '操作'], target.recommended.map(rec => [
      lineupName(rec), lineupHeroes(rec), lineupPower(rec),
      rec.isCurrent ? el('span', 'ok', '正在使用') : progressionAction('换成这套', '/api/lineups/apply',
        { targetKey: target.key, previewKey: rec.previewKey }, account, target.reason, 'lineup'),
    ])));
  } else {
    box.appendChild(el('p', 'dim', '现有英雄凑不齐完整的攻略阵容。'));
  }
  if (target.near.length) {
    box.appendChild(table(['差一点能凑齐', '还差', '被占用'], target.near.map(rec => [
      rec.label, rec.missing.join('、') || '—', rec.blocked.join('、') || '—',
    ])));
  }
}

function renderLineups(box, data, account) {
  box.appendChild(el('p', 'dim', '阵容来自游戏内的英雄攻略，只选你能凑齐的，同类阵容按总战力排序。攻略没有按玩法分类，玩法适配是本工具的判断，也没有针对具体关卡，换阵不保证过关。'));
  const bar = el('div', 'bar');
  const select = choice(bar, '玩法和队伍', data.targets.map(t => ({ value: t.key, text: t.title })));
  const saved = lineupSelection.get(account);
  if (data.targets.some(t => t.key === saved)) select.value = saved;
  const detail = el('div', 'progression-view');
  const draw = () => {
    lineupSelection.set(account, select.value);
    renderLineupTarget(clear(detail), data.targets.find(t => t.key === select.value), account);
  };
  select.onchange = draw;
  draw();
  box.append(bar, detail);
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GameClient } from './client.mjs';
import { challengeTrial, trialProgress } from './trials.mjs';
import { readHeroEquipment, equipHeroEmptySlots, enhanceHeroEquipment } from './hero-equipment.mjs';
import { readEquipmentCrafting, startEquipmentCraft, collectEquipmentCraft } from './equipment-crafting.mjs';
import { readGuild, claimGuildWelfare } from './guild.mjs';
import { readFleetFormations, initializeFleetFormation } from './fleet-formation.mjs';
import { loadProtocol } from './proto.mjs';
import { PAGE } from './page.mjs';
import { listWorlds, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState, ENTRY_QUERIES } from './game.mjs';
import { claimRewards } from './claim-rewards.mjs';
import { fishView, newbieView } from './collections.mjs';
import { normalize } from './worlds.mjs';
import { pirateTracker, pirateHuntOptions, startPirateHunt } from './pirates.mjs';
import { activityView } from './activities.mjs';
import { displayMaterial, getConfig } from './config.mjs';
import { planHeroes, runHeroPlan, formatHeroPlan } from './heroes.mjs';
import { appointments } from './appointments.mjs';
import { surveyDailies, runDailies, formatSurvey } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { makeTypeResolver, weekFactoryInfo, surveyWorld, planWorld, runWorldRound, submitResidentOrder, formatWorldPlan, formatFieldReport, loadMapAsset } from './world.mjs';
import { runLoop, formatLoopRound, formatLoopStep } from './loop.mjs';
import { describeLogError } from './log-errors.mjs';
import { operationLabels } from './operation-labels.mjs';
import { automationTasks, defaultFishingGoldReserve, taskSettings, worldTaskKey } from './automation.mjs';
import { rewardSchedule } from './reward-schedule.mjs';
import { createStageTask } from './stages.mjs';
import { runAction } from './actions.mjs';
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { startCapture, stopCapture, captureState, DEFAULT_PROXY_PORT } from './capture.mjs';
import { iconIndex, atlasFile, itemIcon, resourceIcon, materialIcon, heroIcon, heroCard, buildingIcon, workerIcon } from './art.mjs';

const LOG_LIMIT = 400;
const overviewQueries = ENTRY_QUERIES.filter(({ name }) => [
  'AllResourceRequest', 'AllItemRequest', 'AllHeroRequest', 'MainTaskInfoRequest', 'DailyTaskInfoRequest',
  'AchievementInfoRequest', 'EmailBoxRequest', 'AfkInfoRequest', 'OnWaterRequest', 'MyResFieldsRequest', 'MonthCardRequest',
].includes(name));
// 协议帧不再进界面，但仍然要能事后查。默认只写文件，CW_DEBUG=1 时才同时打到终端。
const TRACE_PATH = path.resolve(import.meta.dirname, '../data/protocol.log');

const STATE_TEXT = {
  IDLE: '未连接',
  CONNECTING: '连接中',
  READY: '已连接',
  FAILED: '连接失败',
  REJECTED: '服务器拒绝登录',
  CLOSED: '连接已断开',
  STOPPED: '已停止',
};

export function createConsole({ host = '127.0.0.1', port = 17321 }) {
  const protocol = loadProtocol();
  const globalLog = [];
  const streams = new Set();
  const sessions = new Map();
  let logId = 0;

  const logLimit = (list) => {
    while (list.length > LOG_LIMIT) list.shift();
  };

  function emit(session, level, message, extra) {
    const display = describeLogError(message, extra);
    const detail = [extra?.diagnostic, display.detail].filter(Boolean).join('\n');
    const entry = { id: ++logId, t: Date.now(), level, message: display.message, detail: detail || undefined, extra, account: session?.id ?? null };
    const list = session ? session.log : globalLog;
    list.push(entry);
    logLimit(list);
    const payload = `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of streams) {
      if (entry.account !== null && res.account !== entry.account) continue;
      res.write(payload);
    }
    return entry;
  }

  // 协议层细节（帧、序号、字节数、原始 JSON）只落盘，不进运行记录。
  let traceStream = null;
  function trace(session, line) {
    const text = `${new Date().toISOString()} [${session.id.slice(0, 8)}] ${line}\n`;
    if (process.env.CW_DEBUG === '1') process.stdout.write(text);
    try {
      if (!traceStream) {
        fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
        traceStream = fs.createWriteStream(TRACE_PATH, { flags: 'a' });
      }
      traceStream.write(text);
    } catch {
      /* 写不进去就算了，协议日志不是功能 */
    }
  }

  function enqueue(session, work, label) {
    if (session.queueTail && label) emit(session, 'info', label + '已排队，当前操作结束后执行');
    const generation = session.generation;
    const run = () => {
      if (session.paused || generation !== session.generation) throw new Error('账号已暂停，已取消排队操作');
      return work();
    };
    const job = (session.queueTail ?? Promise.resolve()).then(run, run);
    session.queueTail = job;
    const clear = () => { if (session.queueTail === job) session.queueTail = null; };
    job.then(clear, clear);
    return job;
  }

  function newSession(id) {
    const saved = loadStore().accounts.find(account => account.id === id)?.automation;
    return {
      id,
      paused: saved?.paused === true,
      generation: 0,
      client: null,
      connecting: null,
      player: null,
      stages: createStageTask(),
      busy: null,
      overviewRead: null,
      claiming: null,
      heroJob: null,
      queueTail: null,
      appointmentJob: null,
      residentJobs: new Map(),
      progressionJobs: new Map(),
      log: [],
      loop: {
        running: false,
        rounds: 0,
        completed: 0,
        everyMs: (saved?.everySeconds ?? 60) * 1000,
        tasks: taskSettings(saved?.tasks),
        fishingGoldReserve: saved?.fishingGoldReserve ?? defaultFishingGoldReserve,
        controller: null, job: null,
        history: [],
        error: null,
      },
    };
  }

  // Share identical clicks until this account's queued operation has finished.
  function progressionJob(session, account, key, label, action) {
    if (!session.progressionJobs.has(key)) {
      const generation = session.generation;
      const job = enqueue(session, async () => {
        const client = await ensureConnected(session, account);
        const enabled = () => session.client === client && client.connected && !session.paused && generation === session.generation;
        if (!enabled()) throw new Error('账号连接已变化，请刷新后再试');
        return action(client, enabled);
      }, label).finally(() => session.progressionJobs.delete(key));
      session.progressionJobs.set(key, job);
    }
    return session.progressionJobs.get(key);
  }

  function sessionFor(id) {
    if (!sessions.has(id)) {
      const session = newSession(id);
      sessions.set(id, session);
      try {
        const audit = JSON.parse(fs.readFileSync(factoryReportFile(id), 'utf8'));
        if (audit.lines?.length) emit(session, 'info', '上次工厂检查 · ' + audit.time, { diagnostic: audit.lines.join('\n') });
      } catch { /* 新账号没有历史核对记录 */ }
    }
    return sessions.get(id);
  }

  function factoryReportFile(id) {
    return path.join(DATA_DIR, 'factory-report-' + encodeURIComponent(id) + '.json');
  }

  function wire(session, instance) {
    instance.on('message', ({ name, body }) => {
      if (session.client === instance && session.player) {
        if (name === 'SCJoinGuild') session.player.guildId = body.guildId;
        if (name === 'SCLeaveGuild') session.player.guildId = 0;
      }
      // The loop keeps a reference to this login's player object. Update it in place
      // so crossing an unlock level takes effect without restarting the console.
      if (name === 'SCPlayerExpUpdate' && session.client === instance && session.player && body.level > 0) {
        if (session.player.level !== body.level) {
          for (const key of ['adShop', 'weekPass', 'trialSweep', 'dailyRewards', 'chests',
            'museumCollect', 'museumExplore', 'petCollect', 'petBreed']) rewardSchedule(instance).clearTask(key);
        }
        session.player.level = body.level;
        session.player.exp = body.exp;
      }
      if (name === 'SCVipUpdate' && session.client === instance && session.player) {
        Object.assign(session.player.vip ??= {}, { vipLevel: body.vipLevel, vipExp: body.vipExp });
      }
      if (name === 'SCAllActivity' || name === 'SCNewbieActivityUpdate') instance.newbieActivity = normalize(body.newbieActivity);
      if (name === 'SCAllActivity') {
        instance.festivals = body.festivalActivities ?? [];
        trace(session, '节日活动目录 ' + JSON.stringify(instance.festivals.map(row => ({
          type: row.type, start: row.startTime, end: row.endTime, open: row.openTime, close: row.closeTime,
          subs: row.subActivity.map(sub => sub.subActivityType),
        }))));
      }
    });
    instance.on('state', ({ state }) => emit(session, 'state', STATE_TEXT[state] ?? state));
    instance.on('frame', ({ dir, name, seq, bytes }) => trace(session, `${dir === 'out' ? '->' : '<-'} [${name}] seq=${seq} ${bytes.byteLength}B`));
    instance.on('message', ({ seq, name, body }) => trace(session, `[${name}] seq=${seq} ${JSON.stringify(body).slice(0, 400)}`));
    instance.on('pong', ({ latencyMs, offsetMs }) => trace(session, `pong ${latencyMs}ms offset=${offsetMs}ms`));
    instance.on('drop', ({ name, reason }) => emit(session, reason === 'duplicate' ? 'info' : 'warn',
      reason === 'duplicate' ? '已忽略服务器重复发送的消息' : '服务器消息序号不连续，已跳过这条消息',
      { diagnostic: name + ' · ' + reason }));
    instance.on('warn', (message) => emit(session, 'warn', message === 'ping timeout' ? '服务器心跳超时，连接可能已经断了' : message));
    instance.on('fatal', ({ reason }) => {
      const message = reason === 'SCChannelExpired' ? '这个账号在别处登录了，本条连接被顶掉' : `连接被服务器中断（${reason}）`;
      if (session.client === instance) { session.stages.stop(message); stopLoop(session, message); }
      emit(session, 'error', message);
    });
    instance.on('error', (error) => emit(session, 'error', error.message));
    instance.on('close', () => {
      if (session.client === instance) { session.stages.stop('连接已断开'); stopLoop(session, '连接已断开'); }
      emit(session, 'state', '连接已断开');
    });
  }

  // 每次连接把服务端给的昵称/等级/区服写回账号文件，账号列表里就能看到人话标记。
  function persistIdentity(account, player) {
    try {
      const store = loadStore();
      const target = store.accounts.find((entry) => entry.id === account.id);
      if (!target) return;
      const role = describeRole(player);
      target.lastSeen = { nickname: role?.nickname ?? null, level: role?.level ?? null, power: role?.power ?? null, worldId: role?.worldId ?? null, at: new Date().toISOString() };
      if (!target.label && role?.nickname) target.label = role.nickname;
      saveStore(store);
    } catch {
      /* 回填失败不影响连接 */
    }
  }

  async function loginSession(session, account) {
    if (session.client?.connected) throw new Error('这个账号已经连上了');
    const client = new GameClient({ url: account.url, protocol });
    wire(session, client);
    session.client = client;
    session.player = null;
    const response = await client.connect(account.login);
    if (session.client !== client) {
      client.stop();
      throw new Error('连接已取消');
    }
    session.player = response.playerInfo || null;
    client.send('LoginFinishRequest', {});
    persistIdentity(account, session.player);
    const role = describeRole(session.player);
    emit(session, 'info', `已进入游戏：${role?.nickname ?? '未知角色'}（${role?.level ?? '?'} 级）`);
    return { url: account.url, result: response.result, initSeqNo: response.initSeqNo, playerInfo: session.player };
  }

  async function connect(session, account) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    if (session.connecting) return session.connecting;
    const connecting = loginSession(session, account);
    session.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (session.connecting === connecting) session.connecting = null;
    }
  }

  async function ensureConnected(session, account) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    if (!session.connecting && session.client?.connected && session.player) return session.client;
    await connect(session, account);
    return session.client;
  }

  // 每个请求都带 ?account=<id>；不给就是当前选中的那个账号。
  function resolve(url) {
    const store = loadStore();
    const account = pickAccount(store, url.searchParams.get('account'));
    if (!account) throw new Error('还没有任何账号，先在「账号」页添加一个');
    return { store, account, session: sessionFor(account.id) };
  }

  function accountStatus(session) {
    return {
      paused: session.paused,
      connected: Boolean(session.client?.connected),
      state: session.client?.snapshot?.().state ?? 'IDLE',
      busy: session.busy,
      looping: session.loop.running,
    };
  }

  function loadConfigSafe() {
    try {
      return getConfig();
    } catch {
      return null;
    }
  }

  // ---- 只读汇总 -------------------------------------------------------------

  async function overview(session, account) {
    const instance = await ensureConnected(session, account);
    const { ok, failed } = await collectState(instance, protocol, { queries: overviewQueries, signals: [], timeout: 8000 });
    const sections = { AllResourceRequest: '资源', AllItemRequest: '仓库', AllHeroRequest: '英雄', MainTaskInfoRequest: '主线任务',
      DailyTaskInfoRequest: '每日任务', AchievementInfoRequest: '成就', EmailBoxRequest: '邮件', AfkInfoRequest: '挂机收益',
      OnWaterRequest: '海面建筑', MyResFieldsRequest: '资源田', MonthCardRequest: '月卡' };
    for (const [name, error] of Object.entries(failed)) emit(session, 'warn', `总览：未能读取${sections[name] ?? '游戏数据'}：${error}`, { diagnostic: name });
    const config = loadConfigSafe();
    const view = summarize({ ok }, { config });
    const daily = view.daily;
    return {
      account: describeAccount(account, { active: account.id === loadStore().activeId }),
      status: accountStatus(session),
      player: describeRole(session.player),
      resources: view.resources.map((entry) => ({ ...entry, sources: config?.materialSources(entry.res), icon: resourceIcon(entry.res) })),
      items: {
        ...view.items,
        top: view.items.top.map((item) => ({ itemId: item.itemId, name: displayMaterial(config, item.itemId), num: item.num, sources: config?.materialSources(item.itemId), icon: itemIcon(item.itemId) })),
      },
      claimable: {
        mainTask: view.mainTask ? 1 : 0,
        daily: daily?.claimable ?? 0,
        achievement: view.achievements?.claimable ?? 0,
        email: view.email?.unclaimed ?? 0,
        afk: view.afk ? Math.max((view.afk.level ?? 0) - (view.afk.rewardedLevel ?? 0), 0) : 0,
      },
      afk: view.afk,
      heroes: {
        count: view.heroes.count,
        power: view.heroes.power,
        list: view.heroes.list.slice(0, 12).map((hero) => ({ ...hero, icon: heroCard(hero.heroId) ?? heroIcon(hero.heroId) })),
      },
      water: view.water,
      resFields: view.resFields,
      monthCard: view.monthCard,
      unreadable: Object.keys(failed),
      text: formatState(view),
    };
  }

  async function tasks(session, account) {
    const instance = await ensureConnected(session, account);
    const survey = await surveyTasks(instance, protocol, { config: loadConfigSafe(), player: session.player });
    return { ...survey, text: formatTaskPlan(survey) };
  }

  async function world(session, account) {
    const instance = await ensureConnected(session, account);
    const config = loadConfigSafe();
    const survey = await surveyWorld(instance, protocol, { config, player: session.player, includeCargo: session.loop.tasks.cargo });
    const plan = planWorld(survey, { config });
    // Manual preview and idle execution can use different toggles. The order
    // table describes what the account's idle loop can actually deliver.
    const autoOrders = survey.orders.length ? planWorld(survey, {
      config, enabled: kind => session.loop.tasks[worldTaskKey(kind)] === true,
      allowReroll: session.loop.tasks.denyOrder, minOrderExp: null,
    }).orderDecisions : [];
    let map = null, mapError;
    try {
      map = await loadMapAsset(Number(session.player?.scenarioId ?? 0));
    } catch (error) {
      mapError = error.message;
    }
    const fields = { ...survey.resFields, text: formatFieldReport(survey, map, mapError) };
    const typeNames = new Map(config?.tables?.BuildingCfg?.data.map(row => [row.buildingType, row.name]));
    const now = Date.now() / 1000;
    return {
      population: `${survey.population}/${survey.maxPopulation}`,
      farms: survey.buildings.filter(b => b.type === '农田').map(b => ({
        plot: b.buildingId,
        status: !b.level ? (b.buildFinishTime ? '建造中' : '未建成') : !b.farm?.productId ? '空闲'
          : displayMaterial(config, b.farm.productId) + (b.farm.ripeTime < survey.serverNow ? ' · 已成熟' : ' · 生长中'),
      })),
      factories: survey.factories.map((b) => ({ buildingId: b.buildingId, type: b.type, typeName: typeNames.get(b.type), level: b.level, queue: (b.factory.factoryQ ?? []).length, auto: b.factory.autoProductId ? displayMaterial(config, b.factory.autoProductId) : null, icon: buildingIcon(b.type) })),
      orders: survey.orders.map((order) => ({
        ...order,
        workerIcon: workerIcon(order.workerId),
        decision: autoOrders.find(row => row.index === order.index),
        manualDecision: order.orderKey ? planWorld({ ...survey, orders: [order] }, {
          config, enabled: kind => kind === 'finishOrder',
        }).orderDecisions[0] : { status: 'unknown', reason: '无法确认这条居民订单，请刷新后再试' },
        requirements: order.requirements.map((need) => ({ ...need, name: displayMaterial(config, need.id), sources: config?.materialSources(need.id), icon: materialIcon(need.id) })),
        missing: (order.missing ?? []).map((need) => ({ ...need, name: displayMaterial(config, need.id), sources: config?.materialSources(need.id), icon: materialIcon(need.id) })),
      })),
      // 建筑全表：level=0 的是空位（正在盖或还没盖），界面靠它解释「为什么没在建造」。
      buildings: survey.buildings.map((b) => ({
        buildingId: b.buildingId, type: b.type ?? null, level: b.level,
        typeName: typeNames.get(b.type),
        building: b.buildFinishTime > now,
        awaitingFinish: b.buildFinishTime > 0 && b.buildFinishTime <= now,
        icon: buildingIcon(b.type),
      })),
      idleRunning: session.loop.running && !session.loop.controller?.signal.aborted,
      autoDeliverOrders: session.loop.tasks.finishOrder,
      stock: [...survey.stock].filter(([, num]) => num > 0).sort((a, b) => b[1] - a[1]).map(([id, num]) => ({ id, name: displayMaterial(config, id), num, sources: config?.materialSources(id), icon: materialIcon(id) })),
      resFields: fields,
      plan: plan.actions,
      notes: [...survey.notes, ...plan.notes],
      text: formatWorldPlan(survey, plan),
    };
  }

  async function heroes(session, account) {
    const instance = await ensureConnected(session, account);
    const heroList = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
    const itemList = await instance.request('AllItemRequest', {}, 'AllItemResponse', 15000);
    const counts = new Map();
    for (const item of itemList.items ?? []) {
      const id = item.itemId ?? item.id;
      counts.set(id, (counts.get(id) ?? 0) + Number(item.num ?? item.count ?? 0));
    }
    const config = loadConfigSafe();
    if (!config) throw new Error('没有配置表，算不出英雄养成计划');
    const plan = planHeroes({ config, heroes: heroList.heroes ?? [], itemNum: (id) => counts.get(id) ?? 0, playerLevel: describeRole(session.player)?.level ?? 1 });
    return {
      steps: plan.steps,
      notes: plan.notes,
      maxLevel: plan.maxLevel,
      maxStar: plan.maxStar,
      text: formatHeroPlan(plan),
      heroes: (heroList.heroes ?? []).map((hero) => ({ ...hero, icon: heroCard(hero.heroId), head: heroIcon(hero.heroId) })),
    };
  }

  async function dailies(session, account) {
    const instance = await ensureConnected(session, account);
    const survey = await surveyDailies(instance, protocol, { config: loadConfigSafe(), player: session.player });
    return { tasks: survey.tasks.map((entry) => ({ ...entry, task: { ...entry.task } })), chests: survey.chests, gift: survey.gift, ruby: survey.ruby, text: formatSurvey(survey) };
  }

  // ---- 从电脑微信采集登录 ---------------------------------------------------

  // 用户提供的小程序码仅作为游戏入口展示；它没有与本机捕获会话关联。
  function qrInfo() {
    if (fs.existsSync(path.join(DATA_DIR, 'qrcode.png'))) {
      return { kind: 'image', url: '/api/capture/qrcode', note: '你提供的游戏入口码：请在电脑微信中识别。手机扫码不会把登录凭证传到本工具。' };
    }
    return { kind: 'none', note: '请直接在电脑版微信中打开《疯狂水世界》。此游戏包未发现独立扫码授权接口。' };
  }

  // 抓到登录包就落库；顺手连一次把昵称/等级/区服回填，账号列表才看得到人话。
  async function addCapturedAccount({ url, body, rawFrameHex }, platform) {
    if (platform === 'douyin' && !['openId', 'token', 'sign', 'timestamp'].every(key => body?.eworldParams?.[key])) {
      throw new Error('抖音游戏登录报文缺少凭证字段');
    }
    const credential = { url, login: body, loginFrameHex: rawFrameHex, source: platform === 'douyin' ? 'douyin-mitm' : 'mitm', capturedAt: new Date().toISOString() };
    const store = loadStore();
    const { account, created } = upsertAccount(store, credential);
    if (created) account.automation = { enabled: true, everySeconds: 60 };
    saveStore(store);
    const title = describeAccount(account).title;
    emit(null, 'info', created ? `新账号已入库：${title}` : `账号凭证已刷新：${title}`);

    const session = sessionFor(account.id);
    if (session.paused) return { id: account.id };
    try {
      await ensureConnected(session, account);
      emit(null, 'info', `${title} 的角色信息已读取（游戏那边会被顶下线一次，重进即可）`);
      if (created && account.automation.enabled) startLoop(session, account, { rounds: 0 });
      else if (!session.loop.running && !session.stages.view().running) {
        session.client?.stop();
        session.client = null;
        session.player = null;
      }
    } catch (error) {
      if (created) saveAutomation(account.id, { enabled: false });
      emit(null, 'warn', `读取角色信息失败，账号本身已经存好了：${error.message}`);
    }
    return { id: account.id };
  }

  // ---- 路由 -----------------------------------------------------------------

  async function handle(req, res, body) {
    const parsed = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${parsed.pathname}`;
    const json = (value, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const jsonBody = () => JSON.parse(body || '{}');
    const needConfirm = (payload) => {
      if (payload.confirm !== true) throw new Error('这个操作会改动游戏里的状态，需要先确认');
    };
    const longRunning = /^(GET|POST) \/api\/(heroes|dailies|tasks|world|overview|loop)(\/|$)/.test(route);
    let scoped = null;
    let releaseWrite;
    // 所有账号相关的路由都先过这里：拿到账号、对应会话，长请求再挂个忙碌标记。
    const scoped_ = (url) => {
      const found = resolve(url);
      scoped = found.session;
      if (longRunning) found.session.busy = route;
      return found;
    };
    try {
      if (['POST /api/dailies/run', 'POST /api/tasks/run', 'POST /api/world/run', 'POST /api/worlds/enter'].includes(route)) {
        const { session } = resolve(parsed);
        parsed.searchParams.set('account', session.id);
        await new Promise((acquired, reject) => {
          enqueue(session, () => new Promise(release => { releaseWrite = release; acquired(); })).catch(reject);
        });
      }
      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (route === 'GET /api/art/index') {
        json(iconIndex());
        return;
      }
      // 图标是游戏自己的贴图，从 FairyGUI 图集里按图集页整张给出去，裁切交给浏览器。
      if (route.startsWith('GET /api/art/atlas/')) {
        const [, , , , bundle, file] = route.split('/').map((part) => decodeURIComponent(part));
        const found = atlasFile(bundle, file);
        if (!found) {
          json({ error: 'not found' }, 404);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(fs.readFileSync(found));
        return;
      }
      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.account = parsed.searchParams.get('account');
        const since = Number(req.headers['last-event-id'] ?? 0);
        const entries = [...globalLog, ...(sessions.get(res.account)?.log ?? [])]
          .sort((a, b) => a.id - b.id).slice(-LOG_LIMIT);
        for (const entry of entries) {
          if (entry.id > since) res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
        }
        res.flushHeaders();
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }

      // ---- 账号 ----
      if (route === 'GET /api/accounts') {
        const store = loadStore();
        json({
          activeId: store.activeId,
          accounts: store.accounts.map((account) => ({
            ...describeAccount(account, { active: account.id === store.activeId }),
            status: accountStatus(sessionFor(account.id)),
          })),
        });
        return;
      }
      if (route === 'POST /api/accounts/export') {
        const { id, all } = jsonBody();
        const store = loadStore();
        const selected = all === true ? store.accounts : store.accounts.filter(a => a.id === id);
        if (!selected.length) throw new Error('没有可导出的账号');
        const backup = { version: store.version, activeId: selected.some(a => a.id === store.activeId) ? store.activeId : selected[0].id, accounts: selected };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="accounts.json"' });
        res.end(JSON.stringify(backup, null, 2));
        return;
      }
      if (route === 'GET /api/accounts/credential') {
        const store = loadStore();
        const account = pickAccount(store, parsed.searchParams.get('account'));
        if (!account) throw new Error('没有这个账号');
        json(parsed.searchParams.get('reveal') === '1' ? revealAccount(account) : describeAccount(account, { active: account.id === store.activeId }));
        return;
      }
      if (route === 'POST /api/accounts/active') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        setActive(store, account.id);
        saveStore(store);
        emit(null, 'info', `当前账号切到 ${describeAccount(account).title}`);
        json({ ok: true, activeId: account.id });
        return;
      }
      if (route === 'POST /api/accounts/label') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        account.label = String(payload.label ?? '').trim() || null;
        saveStore(store);
        json({ ok: true });
        return;
      }
      if (route === 'POST /api/accounts/remove') {
        const payload = jsonBody();
        needConfirm(payload);
        const store = loadStore();
        const account = pickAccount(store, payload.id);
        if (!account) throw new Error('没有这个账号');
        removeAccount(store, account.id);
        saveStore(store);
        const removed = sessions.get(account.id);
        removed?.loop.controller?.abort();
        removed?.stages.stop('账号已删除');
        removed?.client?.stop();
        sessions.delete(account.id);
        emit(null, 'info', `已删除账号 ${describeAccount(account).title}`);
        json({ ok: true });
        return;
      }

      // ---- 连接 ----
      if (route === 'POST /api/accounts/pause') {
        const { account, session } = scoped_(parsed);
        const { paused } = jsonBody();
        if (typeof paused !== 'boolean') throw new Error('请选择暂停或恢复');
        if (session.paused !== paused) {
          saveAutomation(account.id, { paused });
          session.paused = paused;
          const generation = ++session.generation;
          if (paused) {
            stopLoop(session, '账号暂停，结束挂机');
            session.stages.stop('账号已暂停');
            session.client?.stop();
            session.worldClient?.stop();
            session.connecting = session.client = session.player = null;
            emit(session, 'state', '账号已暂停，可以自行上号', { pauseChanged: true });
          } else {
            emit(session, 'state', '账号已恢复托管', { pauseChanged: true });
            if (account.automation?.enabled) {
              await session.loop.job;
              if (generation === session.generation && !session.loop.running) startLoop(session, account);
            }
          }
        }
        json(accountStatus(session));
        return;
      }
      if (route === 'POST /api/connect') {
        const payload = jsonBody();
        const { account, session } = scoped_(parsed);
        json(await connect(session, account));
        return;
      }
      if (route === 'POST /api/disconnect') {
        const { session } = scoped_(parsed);
        stopLoop(session, '账号已断开');
        session.stages.stop('账号已断开');
        session.client?.stop();
        session.connecting = null;
        session.client = null;
        session.player = null;
        json({ ok: true });
        return;
      }

      // ---- 从电脑微信采集登录 ----
      if (route === 'GET /api/capture') {
        json({ ...captureState(), qr: qrInfo() });
        return;
      }
      if (route === 'GET /api/capture/qrcode') {
        const file = path.join(DATA_DIR, 'qrcode.png');
        if (!fs.existsSync(file)) {
          json({ error: '没有 data/qrcode.png' }, 404);
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(file));
        return;
      }
      if (route === 'POST /api/capture/start') {
        const payload = jsonBody();
        needConfirm(payload);
        if (captureState().running) throw new Error('已经在抓包了');
        const platform = payload.platform ?? 'wechat';
        if (!['wechat', 'douyin'].includes(platform)) throw new Error('未知的采集渠道');
        emit(null, 'info', `开始抓包：本地 CA 与系统代理（127.0.0.1:${DEFAULT_PROXY_PORT}）都是当前用户范围，抓到即自动还原`);
        await startCapture({
          port: DEFAULT_PROXY_PORT,
          platform,
          onLog: (line) => emit(null, /失败|超时/.test(line) ? 'error' : 'info', line),
          onLogin: record => addCapturedAccount(record, platform),
        });
        json({ ...captureState(), qr: qrInfo() });
        return;
      }
      if (route === 'POST /api/capture/stop') {
        needConfirm(jsonBody());
        await stopCapture('用户点了停止');
        json({ ...captureState(), qr: qrInfo() });
        return;
      }

      // ---- 只读视图 ----
      if (route === 'GET /api/overview') {
        const { account, session } = scoped_(parsed);
        if (session.claiming) await session.claiming;
        session.overviewRead ??= overview(session, account).finally(() => { session.overviewRead = null; });
        json(await session.overviewRead);
        return;
      }
      if (route === 'GET /api/heroes') {
        const { account, session } = scoped_(parsed);
        json(await heroes(session, account));
        return;
      }
      if (route === 'GET /api/material-sources') {
        const config = loadConfigSafe();
        if (!config) throw new Error('缺少游戏材料配置');
        json(config.tables.ItemJumpCfg.data.map(r => ({ name: displayMaterial(config, r.id), sources: config.materialSources(r.id) }))
          .filter(r => r.name !== '未知材料' && r.sources.length));
        return;
      }
      if (route === 'GET /api/pirates') {
        const { account, session } = scoped_(parsed);
        const result = await progressionJob(session, account, route, null, client => pirateTracker(client, loadConfigSafe(), session.player));
        for (const message of result.errors) emit(session, 'warn', '海盗首杀查询：' + message);
        json(result);
        return;
      }
      if (route === 'GET /api/equipment/crafting') {
        const { account, session } = scoped_(parsed);
        json(await progressionJob(session, account, route, null, client => readEquipmentCrafting(client, loadConfigSafe(), session.player)));
        return;
      }
      if (route === 'POST /api/equipment/crafting/start' || route === 'POST /api/equipment/crafting/collect') {
        const { account, session } = scoped_(parsed);
        const payload = jsonBody();
        needConfirm(payload);
        const craft = parsed.pathname.endsWith('/start') ? startEquipmentCraft : collectEquipmentCraft;
        const key = JSON.stringify([route, payload.buildingId, payload.makeId, payload.previewKey]);
        json(await progressionJob(session, account, key, operationLabels[parsed.pathname], async (client, enabled) => {
          const result = await craft(client, loadConfigSafe(), session.player, { ...payload, enabled });
          emit(session, 'info', result.label);
          return result;
        }));
        return;
      }
      if (route === 'GET /api/trials' || route === 'GET /api/equipment' || route === 'GET /api/guild' || route === 'GET /api/pirates/hunt' || route === 'GET /api/fleets/formation') {
        const { account, session } = scoped_(parsed);
        json(await progressionJob(session, account, route, null, async client => {
          const config = loadConfigSafe(), player = session.player;
          if (route === 'GET /api/equipment') return readHeroEquipment(client, config, player.level);
          if (route === 'GET /api/guild') {
            const guild = await readGuild(client, config, player);
            if (guild.aidError) emit(session, 'warn', '读取联盟求助失败：' + guild.aidError);
            return guild;
          }
          if (route === 'GET /api/fleets/formation') return readFleetFormations(client, config, player);
          if (route === 'GET /api/pirates/hunt') return pirateHuntOptions(client, config, player);
          const rows = await trialProgress(client, config, player.level);
          for (const row of rows.filter(r => r.failed)) emit(session, 'warn', row.name + '：' + row.reason);
          return rows;
        }));
        return;
      }
      if (route === 'POST /api/equipment/wear' || route === 'POST /api/equipment/enhance' || route === 'POST /api/guild/welfare' || route === 'POST /api/pirates/hunt' || route === 'POST /api/fleets/formation') {
        const { account, session } = scoped_(parsed);
        const payload = jsonBody();
        needConfirm(payload);
        const label = operationLabels[parsed.pathname];
        const key = JSON.stringify([route, payload.heroId, payload.uid, payload.expectedLevel, payload.maxCost, payload.targetKey, payload.fleetKey, payload.buildingId, payload.previewKey]);
        json(await progressionJob(session, account, key, label, async (client, enabled) => {
          const config = loadConfigSafe(), player = session.player;
          if (route === 'POST /api/equipment/wear') {
            const result = await equipHeroEmptySlots(client, config, player.level, payload.heroId, enabled);
            for (const line of result.lines) emit(session, 'info', line);
            return result;
          }
          if (route === 'POST /api/equipment/enhance') {
            const result = await enhanceHeroEquipment(client, config, player.level, { ...payload, enabled });
            emit(session, 'info', result.label);
            return result;
          }
          if (route === 'POST /api/guild/welfare') {
            const result = await claimGuildWelfare(client, config, { player, enabled });
            emit(session, 'info', result.skipped ? result.reason : result.label);
            return result;
          }
          if (route === 'POST /api/fleets/formation') {
            const result = await initializeFleetFormation(client, config, player, { ...payload, enabled });
            emit(session, 'info', result.label);
            return result;
          }
          const result = await startPirateHunt(client, config, player, { ...payload, enabled, report: entry => emit(session, 'info', typeof entry === 'string' ? entry : entry.label) });
          emit(session, 'info', result.label);
          return result;
        }));
        return;
      }
      if (route === 'GET /api/activities') {
        const { account, session } = scoped_(parsed);
        const client = await ensureConnected(session, account);
        const view = await activityView(client, client.festivals, loadConfigSafe());
        view.newbie = newbieView(client);
        if (view.newbie) view.activities.push({ name: '新手七日登录', taskKey: 'newbieLogin', endTime: view.newbie.end });
        try { view.fish = await fishView(client, loadConfigSafe()); }
        catch (error) { emit(session, 'error', '读取钓鱼图鉴失败：' + error.message); }
        if (view.order?.materials.length && !view.order.finished) {
          const config = loadConfigSafe();
          const typeOf = makeTypeResolver(config);
          let buildings;
          try {
            const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
            buildings = (water.building ?? []).map(b => ({ ...b, type: typeOf(b.buildingId) }));
          } catch (error) {
            emit(session, 'error', '读取周订单工厂等级失败：' + error.message);
          }
          for (const row of view.order.materials) {
            row.factory = weekFactoryInfo(config, row.id, buildings);
            if (!row.seed) continue;
            const plots = buildings?.filter(b => b.type === '农田' && b.level > 0);
            const growing = plots?.find(b => b.farm?.productId === row.id);
            row.farmStatus = !plots ? '状态未知' : !plots.length ? '农田未建成' : growing ? '已种植，等待收获'
              : row.seed.count ? '种子库存 ' + row.seed.count : '缺' + row.seed.name;
          }
        }
        if (view.lotteryError) emit(session, 'error', '读取周抽奖进度失败：' + view.lotteryError);
        if (view.orderError) emit(session, 'error', '读取周订单失败：' + view.orderError);
        view.eventTasks = automationTasks.filter(task => task.group === '限时活动').map(({ key, label }) => ({ key, label, enabled: session.loop.tasks[key] }));
        view.serverNow = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
        json(view);
        return;
      }
      if (route === 'GET /api/dailies') {
        const { account, session } = scoped_(parsed);
        json(await enqueue(session, () => dailies(session, account)));
        return;
      }
      if (route === 'GET /api/tasks') {
        const { account, session } = scoped_(parsed);
        json(await tasks(session, account));
        return;
      }
      if (route === 'GET /api/world') {
        const { account, session } = scoped_(parsed);
        session.worldRead ??= enqueue(session, () => world(session, account)).finally(() => { session.worldRead = null; });
        json(await session.worldRead);
        return;
      }
      if (route === 'POST /api/world/order/submit') {
        const { session } = scoped_(parsed);
        const payload = jsonBody();
        needConfirm(payload);
        const { index, orderKey } = payload;
        if (!Number.isSafeInteger(index) || index < 0 || index > 2147483647 || typeof orderKey !== 'string' || !orderKey.length || orderKey.length > 512) {
          throw new Error('订单信息不完整，请刷新居民订单');
        }
        const key = index + ':' + orderKey;
        let job = session.residentJobs.get(key);
        if (!job) {
          const client = session.client, generation = session.generation;
          const enabled = () => client?.connected && session.client === client && !session.paused && session.generation === generation;
          job = enqueue(session, async () => {
            if (!enabled()) throw new Error('账号连接已变化，请刷新居民订单');
            const result = await submitResidentOrder(client, protocol, { index, orderKey, enabled,
              config: loadConfigSafe(), player: session.player, cargoEnabled: () => session.loop.tasks.cargo });
            emit(session, 'info', result.label, { worldUpdated: true });
            return { ok: true, ...result };
          }, '手动提交居民订单 #' + index).finally(() => session.residentJobs.delete(key));
          session.residentJobs.set(key, job);
        }
        json(await job);
        return;
      }
      if (route === 'GET /api/worlds') {
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        json({ ...(await listWorlds(instance)), currentPlayer: describeRole(session.player) });
        return;
      }
      // 进服自己开一条短连接，所以不会打扰控制台这边正在跑的会话。
      if (route === 'POST /api/worlds/enter') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        if (!payload.worldId) throw new Error('要指定 worldId');
        if (session.paused) throw new Error('账号已暂停，请先恢复托管');
        const client = new GameClient({ url: account.url, protocol });
        session.worldClient = client;
        try {
          const entered = await enterWorld({ client, login: account.login }, Number(payload.worldId));
          json({ player: describeRole(entered.player) });
        } finally {
          client.stop();
          session.worldClient = null;
        }
        return;
      }

      // ---- 写操作 ----
      if (route === 'POST /api/trials/challenge') {
        const { session, account } = scoped_(parsed);
        const { raidId, stageId } = jsonBody();
        const message = await progressionJob(session, account, JSON.stringify([route, raidId, stageId]), '试炼挑战', async (client, enabled) => {
          const message = await challengeTrial(client, loadConfigSafe(), session.player?.level ?? 0, raidId, stageId, enabled);
          emit(session, 'info', message);
          return message;
        });
        json({ message });
        return;
      }
      if (route === 'GET /api/appointments' || route === 'POST /api/appointments/run') {
        const assign = req.method === 'POST';
        if (assign) needConfirm(jsonBody());
        const { session, account } = scoped_(parsed);
        const previous = session.appointmentJob;
        // 查看可复用任命的最终状态；任命遇到在途查询则等它结束再写。
        if (previous && (!assign || previous.assign)) {
          json(await previous.promise);
          return;
        }
        const job = { assign };
        job.promise = enqueue(session, async () => {
          const client = await ensureConnected(session, account);
          const result = await appointments(client, loadConfigSafe(), session.player?.level, { assign });
          if (assign) emit(session, 'info', `英雄任命 · ${result.occupied}/${result.slots.length} 个开放职位有人，${result.changed} 个职位有变化`);
          return result;
        }).finally(() => {
          if (session.appointmentJob === job) session.appointmentJob = null;
        });
        session.appointmentJob = job;
        json(await job.promise);
        return;
      }
      if (route === 'POST /api/loot/run') {
        needConfirm(jsonBody());
        const { account, session } = scoped_(parsed);
        session.claiming ??= enqueue(session, async () => {
          if (session.overviewRead) await session.overviewRead;
          const instance = await ensureConnected(session, account);
          emit(session, 'info', '开始一键领取');
          const results = await claimRewards(instance, protocol, loadConfigSafe(), ({ label, ok, error }) =>
            emit(session, ok ? 'info' : 'error', ok ? `领取 · ${label}` : `领取 · ${label}失败：${error}`), undefined, undefined, undefined, session.player);
          const failed = results.filter((entry) => !entry.ok).length;
          const summary = `本轮完成 ${results.length - failed} 项，失败 ${failed} 项`;
          emit(session, failed ? 'warn' : 'info', summary);
          return { results, summary };
        }, '一键领取').finally(() => { session.claiming = null; });
        json(await session.claiming);
        return;
      }
      if (route === 'POST /api/heroes/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        session.heroJob ??= enqueue(session, async () => {
          const instance = await ensureConnected(session, account);
          const plan = await heroes(session, account);
          const started = Date.now();
          const steps = [];
          const results = await runHeroPlan(instance, protocol, plan, {
            allowMutate: true,
            timeout: 8000,
            onStep: (entry) => {
              const step = entry.step;
              const label = step.kind === 'level' ? `${step.heroId} 升级请求 · 目标 ${entry.targetLevel} 级` : step.kind === 'star' ? `${step.heroId} 升到 ${step.to} 星` : `${step.heroId} 技能 ${step.slot + 1}`;
              steps.push({ label, ok: entry.ok, skipped: entry.skipped === true, error: entry.error });
              if (entry.skipped) emit(session, 'warn', `英雄 ${label} 已跳过：${entry.error}`);
              else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `英雄 ${label}` : `英雄 ${label} 失败：${entry.error}`);
            },
          });
          const after = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
          const upgraded = new Set(results.filter((r) => r.targetLevel != null).map((r) => r.step.heroId));
          for (const hero of after.heroes ?? []) {
            if (upgraded.has(hero.heroId)) emit(session, 'info', `养成后 · ${hero.heroId} 当前 ${hero.level} 级`);
          }
          const skipped = results.filter((r) => r.skipped).length;
          return { sent: results.length - skipped, failed: results.filter((r) => !r.ok && !r.skipped).length,
            skipped, ms: Date.now() - started, steps, heroes: after.heroes ?? [] };
        }, '英雄养成').finally(() => { session.heroJob = null; });
        json(await session.heroJob);
        return;
      }
      if (route === 'POST /api/dailies/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const survey = await surveyDailies(instance, protocol, { config, player: session.player });
        const started = Date.now();
        const results = await runDailies(instance, protocol, survey, {
          allowMutate: true,
          allowPaid: payload.paid === true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `日常「${entry.title}」跳过：${entry.reason}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `日常「${entry.title}」${entry.note}` : `日常「${entry.title}」${entry.note ?? ''}失败：${entry.error}`,
              entry.ok ? undefined : { request: entry.request, way: entry.way });
          },
        });
        // 任务奖励、活跃度宝箱与每日赠礼的领取都在 runDailies 内部收尾，这里只把结果重新读一遍给页面。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await surveyDailies(instance, protocol, { config, player: session.player });
        const claimed = results
          .filter((entry) => entry.ok && (entry.request === 'DrawDailyTaskRewardRequest' || entry.id === 'activityChest' || entry.id === 'freeDailyPack'))
          .map((entry) => entry.note);
        json({ results, claimed, ms: Date.now() - started, tasks: after.tasks, chests: after.chests, gift: after.gift, ruby: after.ruby });
        return;
      }
      if (route === 'POST /api/tasks/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const instance = await ensureConnected(session, account);
        const survey = await tasks(session, account);
        const results = await runTasks(instance, protocol, survey, {
          allowMutate: true,
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `任务「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `领取 ${entry.step.label}` : `领取 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await tasks(session, account);
        json({ results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })), plan: after.plan, text: after.text });
        return;
      }
      if (route === 'POST /api/world/run') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        const generation = session.generation;
        const instance = await ensureConnected(session, account);
        const config = loadConfigSafe();
        const protectCargo = session.loop.tasks.cargo;
        const survey = await surveyWorld(instance, protocol, { config, player: session.player, includeCargo: protectCargo });
        const plan = planWorld(survey, { config, allowSpeedUp: payload.speedUp === true, allowReroll: payload.reroll === true });
        const { results } = await runWorldRound(instance, protocol, plan, {
          config, player: session.player, allowMutate: true,
          cargoEnabled: () => protectCargo || session.loop.tasks.cargo,
          enabled: kind => generation === session.generation && !session.paused &&
            (!['finishOrder', 'denyOrder'].includes(kind) || protectCargo || !session.loop.tasks.cargo),
          onStep: (entry) => {
            if (entry.skipped) emit(session, 'warn', `海面「${entry.step.label}」跳过：${entry.error}`);
            else emit(session, entry.ok ? 'info' : 'error', entry.ok ? `海面 ${entry.step.label}` : `海面 ${entry.step.label} 失败：${entry.error}`);
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        let after;
        try {
          if (generation !== session.generation || session.paused) throw new Error('账号托管状态已变更');
          after = await world(session, account);
        } catch (error) {
          emit(session, 'warn', '海面操作已结束，刷新状态失败：' + error.message);
          after = { refreshError: error.message };
        }
        json({ ...after, results: results.map((r) => ({ label: r.step.label, ok: r.ok, skipped: r.skipped, error: r.error })) });
        return;
      }
      if (route === 'GET /api/stages') {
        json(scoped_(parsed).session.stages.view());
        return;
      }
      if (route === 'POST /api/stages/start') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session, account } = scoped_(parsed);
        if (session.paused) throw new Error('账号已暂停，请先恢复托管');
        json(session.stages.start(payload, async () => {
          const client = await ensureConnected(session, account);
          const config = loadConfigSafe();
          let nextCheck = 0;
          return { client, player: session.player, config, schedule: work => enqueue(session, work), async beforeBattle(signal) {
            const enabled = key => key === 'afk' && session.loop.tasks.afk && !session.loop.running && !signal.aborted;
            if (!enabled('afk') || Date.now() < nextCheck) return;
            nextCheck = Date.now() + 60_000;
            await claimRewards(client, protocol, config, ({ label, ok, error }) =>
              emit(session, ok ? 'info' : 'error', ok ? label : label + '：' + error),
              enabled, time => { nextCheck = time; });
          } };
        }, (error) => emit(session, 'error', `主线推关失败：${error.message}`)));
        return;
      }
      if (route === 'POST /api/stages/stop') {
        needConfirm(jsonBody());
        json(scoped_(parsed).session.stages.stop());
        return;
      }
      // 循环：开启后立刻返回，进度走 /api/loop 与事件流。
      if (route === 'GET /api/loop') {
        const { session } = scoped_(parsed);
        json(loopView(session));
        return;
      }
      if (route === 'POST /api/loop/start') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        startLoop(session, account, { rounds: payload.rounds ?? 0, everySeconds: payload.everySeconds });
        json(loopView(session));
        return;
      }
      if (route === 'POST /api/loop/stop') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session } = scoped_(parsed);
        stopLoop(session, '已暂停挂机');
        json({ ok: true, running: session.loop.running });
        return;
      }

      if (route === 'POST /api/loop/fishing-reserve') {
        const { session } = scoped_(parsed);
        const { fishingGoldReserve } = jsonBody();
        if (!Number.isSafeInteger(fishingGoldReserve) || fishingGoldReserve < 0) throw new Error('预留金币必须是非负整数');
        saveAutomation(session.id, { fishingGoldReserve });
        session.loop.fishingGoldReserve = fishingGoldReserve;
        emit(session, 'info', '钓具强化将保留 ' + fishingGoldReserve.toLocaleString('zh-CN') + ' 金币');
        json({ fishingGoldReserve });
        return;
      }
      if (route === 'POST /api/loop/task') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session } = scoped_(parsed);
        const task = automationTasks.find(item => item.key === payload.key);
        if (!task || typeof payload.enabled !== 'boolean') throw new Error('无效的自动任务设置');
        const tasks = { ...session.loop.tasks, [task.key]: payload.enabled };
        saveAutomation(session.id, { tasks });
        session.loop.tasks = tasks;
        if (session.client && payload.enabled) rewardSchedule(session.client).clearTask(task.key);
        if (!Object.values(tasks).some(Boolean)) stopLoop(session, '全部自动项目已暂停');
        emit(session, 'info', task.label + (payload.enabled ? '已启用' : '已暂停'));
        json(loopView(session));
        return;
      }

      json({ error: 'not found' }, 404);
    } catch (error) {
      const entry = emit(scoped, 'error', (operationLabels[parsed.pathname] ?? '控制台操作') + '失败：' + error.message, { diagnostic: route });
      json({ error: error.message, log: entry }, 400);
    } finally {
      releaseWrite?.();
      if (scoped && scoped.busy === route) scoped.busy = null;
    }
  }

  function saveAutomation(id, change) {
    const store = loadStore();
    const account = store.accounts.find(item => item.id === id);
    if (!account) return;
    account.automation = { ...account.automation, ...change };
    saveStore(store);
  }

  function stopLoop(session, reason) {
    const loop = session.loop;
    if (!loop.running || loop.controller.signal.aborted) return;
    if (!session.paused) saveAutomation(session.id, { enabled: false });
    loop.controller.abort();
    emit(session, 'info', reason);
  }

  function startLoop(session, account, { rounds = 0, everySeconds = session.loop.everyMs / 1000 } = {}) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    const loop = session.loop;
    if (loop.running) throw new Error('这个账号的挂机已在运行');
    if (!Number.isSafeInteger(rounds) || rounds < 0) throw new Error('轮数必须是非负整数');
    if (!Number.isSafeInteger(everySeconds) || everySeconds < 1 || everySeconds > 86400) throw new Error('间隔秒数需要为 1–86400 的整数');
    if (!Object.values(loop.tasks).some(Boolean)) throw new Error('请至少启用一个自动项目');
    // Persist only continuous runs for restart. Reserve this account before login awaits.
    saveAutomation(account.id, { enabled: rounds === 0, everySeconds });
    Object.assign(loop, { running: true, rounds, completed: 0, everyMs: everySeconds * 1000,
      history: [], error: null, controller: new AbortController() });
    const { signal } = loop.controller;
    emit(session, 'info', `自动挂机开始，每 ${everySeconds} 秒检查一次`);
    loop.job = (async () => {
      try {
        const client = await ensureConnected(session, account);
        if (signal.aborted) return;
        const { appId, channelId, originVersion } = account.login?.eworldClientInfo ?? {};
        await runLoop(client, protocol, { config: loadConfigSafe(), player: session.player,
          adChannel: { clientInfo: { appId, channelId, originVersion }, language: account.login?.language },
          rounds, everyMs: loop.everyMs, allowMutate: true, stop: signal,
          schedule: work => enqueue(session, work),
          isEnabled: key => loop.tasks[key] === true,
          getFishingGoldReserve: () => loop.fishingGoldReserve,
          onRound(summary) {
            if (summary.world.factories?.length) {
              try {
                fs.writeFileSync(factoryReportFile(session.id), JSON.stringify({ time: new Date().toLocaleString('zh-CN'), lines: summary.world.factories }));
              } catch (error) { emit(session, 'warn', '保存工厂核对记录失败：' + error.message); }
            }
            loop.completed = summary.round;
            loop.history.push(summary);
            if (loop.history.length > 50) loop.history.shift();
            emit(session, 'info', formatLoopRound(summary), summary.world.population ? { worldUpdated: true } : undefined);
          },
          onStep(entry) {
            const production = entry.ok && !entry.skipped && entry.step?.kind === 'startProduce';
            const batch = production ? JSON.stringify([entry.round, entry.step.body.buildingId, entry.step.body.productId]) : undefined;
            emit(session, entry.skipped || entry.ok ? 'info' : 'error', formatLoopStep(entry),
              batch ? { batch, factory: entry.step.displayFactory, product: entry.step.displayProduct }
                : entry.request && entry.ok === false ? { request: entry.request, way: entry.way } : undefined);
          },
        });
      } catch (error) {
        if (!signal.aborted) {
          loop.error = error.message;
          saveAutomation(account.id, { enabled: false });
          emit(session, 'error', `自动挂机中止：${error.message}`);
        }
      } finally {
        loop.running = false;
        loop.controller = null;
        loop.job = null;
        emit(session, 'info', '自动挂机结束');
      }
    })();
  }

  function loopView(session) {
    const loop = session.loop;
    const rewards = session.client ? rewardSchedule(session.client) : null;
    return {
      running: loop.running,
      stopping: !!loop.controller?.signal.aborted,
      tasks: automationTasks.map(({ key, label, group }) => ({
        key, label, group, enabled: loop.tasks[key], nextCheck: loop.tasks[key] ? rewards?.nextCheck(key) : null,
      })),
      fishingGoldReserve: loop.fishingGoldReserve,
      rounds: loop.rounds,
      completed: loop.completed,
      everyMs: loop.everyMs,
      history: loop.history.map((summary) => ({ ...summary, text: formatLoopRound(summary) })),
      error: loop.error,
    };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handle(req, res, body));
  });

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          emit(null, 'info', `控制台已启动 http://${host}:${port}`);
          for (const account of loadStore().accounts) {
            if (!account.automation?.enabled || account.automation.paused) continue;
            const session = sessionFor(account.id);
            try { startLoop(session, account); }
            catch (error) { emit(session, 'error', `无法恢复挂机：${error.message}`); }
          }
          resolve(`http://${host}:${port}`);
        });
      }),
    close: () => {
      for (const session of sessions.values()) {
        session.loop.controller?.abort();
        session.stages.stop('控制台已关闭');
        session.client?.stop();
      }
      return new Promise((resolve) => server.close(resolve));
    },
    emit,
    sessions,
    captureState,
  };
}

export function openBrowser(url) {
  const attempts = [
    ['msedge', [`--app=${url}`]],
    ['chrome', [`--app=${url}`]],
    ['cmd', ['/c', 'start', '', url]],
  ];
  for (const [command, args] of attempts) {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return command;
    } catch {
      /* try next */
    }
  }
  return null;
}

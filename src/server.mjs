import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GameClient } from './client.mjs';
import { challengeTrial, trialProgress } from './trials.mjs';
import { readHeroEquipment, equipHeroEmptySlots, enhanceHeroEquipment } from './hero-equipment.mjs';
import { readGuild, claimGuildWelfare } from './guild.mjs';
import { readFleetFormations, initializeFleetFormation } from './fleet-formation.mjs';
import { loadProtocol } from './proto.mjs';
import { PAGE } from './page.mjs';
import { MOBILE_PAGE } from './mobile-page.mjs';
import { listWorlds, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState } from './game.mjs';
import { claimRewards } from './claim-rewards.mjs';
import { fishView, newbieView } from './collections.mjs';
import { normalize } from './worlds.mjs';
import { pirateTracker, pirateHuntOptions, startPirateHunt } from './pirates.mjs';
import { activityView } from './activities.mjs';
import { displayMaterial, getConfig } from './config.mjs';
import { planHeroes, formatHeroPlan } from './heroes.mjs';
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
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { startCapture, stopCapture, captureState, DEFAULT_PROXY_PORT } from './capture.mjs';
import { iconIndex, atlasFile, itemIcon, resourceIcon, materialIcon, heroIcon, heroCard, buildingIcon, workerIcon } from './art.mjs';
import { runAutomation, automationStatus, stopAutomation } from './automation/service.mjs';
import { loadSettings, saveSettings, LABELS, MODULES, selectModules, selectLoopModules } from './automation/settings.mjs';
import { automationFormOptions } from './automation/form-options.mjs';
import { sendWecomTextNotification } from './notifications.mjs';
import { appendMessage, createMessageStore, loadInitialMessages, messagesFromPush, snapshotMessages } from './messages.mjs';

const LOG_LIMIT = 400;
// 协议帧不再进界面，但仍然要能事后查。默认只写文件，CW_DEBUG=1 时才同时打到终端。
const TRACE_PATH = path.resolve(import.meta.dirname, '../data/protocol.log');
// 协议日志只用于故障取证；达到上限后轮转，避免长期挂机耗尽工作盘。
const TRACE_MAX_BYTES = 128 * 1024 * 1024;

const STATE_TEXT = {
  IDLE: '未连接',
  CONNECTING: '连接中',
  READY: '已连接',
  FAILED: '连接失败',
  REJECTED: '服务器拒绝登录',
  CLOSED: '连接已断开',
  STOPPED: '已停止',
};

// VIP免广告资格由当前登录角色实时状态判断：VIP 至少 3，角色等级至少 10。
const VIP_FREE_AD_MIN_ROLE_LEVEL = 10;
const VIP_FREE_AD_MIN_VIP_LEVEL = 3;

/** 创建本地账号控制台，网页执行与 CLI 共用自动化服务及持久化设置。 */
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
  let traceBytes = 0;
  let traceRotationPending = false;
  let traceDisabled = false;

  /**
   * 打开协议日志流，并在启动时清理上一次运行留下的超限日志。
   * 文件日志属于诊断数据，超过上限时保留最新运行空间比继续填满工作盘更重要。
   */
  function openTraceStream() {
    if (traceStream || traceDisabled || traceRotationPending) return;
    fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
    let existingBytes = 0;
    try {
      existingBytes = fs.statSync(TRACE_PATH).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existingBytes >= TRACE_MAX_BYTES) {
      fs.truncateSync(TRACE_PATH, 0);
      existingBytes = 0;
    }
    const stream = fs.createWriteStream(TRACE_PATH, { flags: 'a' });
    traceBytes = existingBytes;
    // WriteStream 的写入失败通过 error 事件异步报告；必须消费该事件，否则 Node 会崩溃。
    stream.on('error', () => {
      traceDisabled = true;
      if (traceStream === stream) traceStream = null;
    });
    traceStream = stream;
  }

  /**
   * 关闭当前协议日志流并在关闭后截断文件，保证下一轮从空文件继续记录。
   * 等待 close 再截断是为了避免 Windows 上仍持有文件句柄时轮转失败。
   */
  function rotateTraceStream() {
    if (!traceStream || traceRotationPending) return;
    const stream = traceStream;
    traceStream = null;
    traceRotationPending = true;
    stream.once('close', () => {
      try {
        fs.truncateSync(TRACE_PATH, 0);
        traceBytes = 0;
      } catch {
        traceDisabled = true;
      } finally {
        traceRotationPending = false;
      }
    });
    stream.end();
  }

  /**
   * 写入一行协议诊断信息，并在日志异常或达到上限时保护主业务流程。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {string} line 已格式化的协议帧或心跳诊断文本。
   */
  function trace(session, line) {
    const text = `${new Date().toISOString()} [${session.id.slice(0, 8)}] ${line}\n`;
    if (process.env.CW_DEBUG === '1') process.stdout.write(text);
    try {
      if (traceDisabled || traceRotationPending) return;
      openTraceStream();
      const bytes = Buffer.byteLength(text);
      if (traceBytes + bytes > TRACE_MAX_BYTES) {
        rotateTraceStream();
        return;
      }
      if (!traceStream?.writable) return;
      traceStream.write(text);
      traceBytes += bytes;
    } catch {
      // 磁盘或文件权限异常不能影响连接和自动化；后续调用只跳过诊断日志。
      traceDisabled = true;
      traceStream?.destroy();
      traceStream = null;
    }
  }

/** 串行执行同一账号的业务工作；暂停或切换角色后取消尚未开始的工作。 */
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
  /** 每个账号独立保存队列、消息、循环和重连状态，不在会话之间共享停止信号。 */
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
      // 浏览器刷新可能取消旧 HTTP 响应，但服务端采集仍在继续；新总览请求复用这条采集结果。
      overviewPromise: null,
      pushes: new Map(),
      // 消息只存在当前进程；按账号隔离，断线重连保留，进程重启自然清空。
      messages: createMessageStore(),
      messageErrors: [],
      log: [],
      loop: {
        running: false,
        rounds: 0,
        completed: 0,
        everyMs: (saved?.everySeconds ?? 60) * 1000,
        tasks: taskSettings(saved?.tasks),
        fishingGoldReserve: saved?.fishingGoldReserve ?? defaultFishingGoldReserve,
        controller: null, job: null,
        stop: { aborted: false, manuallyStopped: false },
        history: [],
        error: null,
        // 自动重连必须复用断线前这一次挂机的显式参数，不能改用页面当前值或默认值。
        options: null,
        promise: null,
        runId: 0,
      },
      // 同一条连接的 warn、fatal 和 close 可能连续到达；此标记保证只发起一次重连。
      reconnect: null,
      // 用户主动断开后禁止业务轮询隐式重连，必须由连接按钮重新解除这个状态。
      manualDisconnect: false,
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

  /**
   * 读取账号通知设置后异步投递企微消息，Webhook 故障不能影响连接或自动化状态。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {string} content 发送给企微机器人的文本内容。
   * @param {string} category 面向运行记录的通知类别。
   */
  function notifyWecom(session, content, category) {
    let settings;
    try {
      settings = loadSettings(session.id);
    } catch (error) {
      emit(session, 'error', `读取企微通知配置失败：${error.message}`);
      return;
    }
    sendWecomTextNotification(settings, content)
      .then((result) => { if (result.sent) emit(session, 'info', `已发送企微${category}通知`); })
      .catch((error) => emit(session, 'error', `企微${category}通知失败：${error.message}`));
  }

  /**
   * 判断自动化错误是否需要额外通知。
   * 断线已有专属通知；人工停止和重连期间的旧循环都不是新的异常停止事件。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {{manuallyStopped?: boolean, unexpectedDisconnect?: boolean}} stop 当前执行使用的停止信号。
   * @returns {boolean} 是否应发送自动化异常停止通知。
   */
  function shouldNotifyUnexpectedAutomationStop(session, stop) {
    return !stop?.manuallyStopped
      && !stop?.unexpectedDisconnect
      && !session.manualDisconnect
      && !session.reconnect;
  }

  /**
   * 发送非人工触发的自动化异常停止通知，帮助用户在离开控制台后定位停止原因。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {string} reason 自动化停止原因。
   * @param {string} execution 执行入口名称。
   */
  function notifyUnexpectedAutomationStop(session, reason, execution) {
    const nickname = session.player?.nickname || session.id.slice(0, 8);
    const content = [
      '【疯狂水世界】自动化异常停止',
      `账号：${nickname}`,
      `执行：${execution}`,
      `原因：${reason}`,
      `时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date())}`,
    ].join('\n');
    notifyWecom(session, content, '自动化停止');
  }

  /**
   * 把单条游戏连接接入账号会话，并把异常断线转交给一次性的重连恢复流程。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {object} account 当前账号的连接凭证。
   * @param {GameClient} instance 已创建但尚未登录的游戏连接。
   */
  function wire(session, account, instance) {
    let disconnectNotified = false;
    let connectionEstablished = false;
    /**
     * 非主动断线只通知一次，避免 fatal、心跳超时和 close 连续触发重复消息。
     *
     * @param {string} reason 面向用户的断线原因。
     */
    const notifyUnexpectedDisconnect = (reason) => {
      // 只有已经进入过 READY 的会话才算断线；初次连接失败由连接接口返回错误处理。
      if (!connectionEstablished || disconnectNotified || session.manualDisconnect) return;
      disconnectNotified = true;
      const nickname = session.player?.nickname || session.id.slice(0, 8);
      const content = [
        '【疯狂水世界】连接异常断开',
        `账号：${nickname}`,
        `原因：${reason}`,
        `时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date())}`,
        `挂机状态：${session.loop.running ? '运行中' : '未运行'}`,
      ].join('\n');
      notifyWecom(session, content, '断线');
    };
    instance.on('message', ({ name, body }) => {
      // 旧连接的迟到推送不能覆盖新角色状态或混入当前账号消息。
      if (session.client !== instance) return;
      if (name.startsWith('SC')) session.pushes.set(name, body);
      if (session.player) {
        if (name === 'SCJoinGuild') session.player.guildId = body.guildId;
        if (name === 'SCLeaveGuild') session.player.guildId = 0;
        // 循环持有登录对象引用，原地更新等级才能即时解锁上游功能。
        if (name === 'SCPlayerExpUpdate' && body.level > 0) {
          if (session.player.level !== body.level) {
            for (const key of ['adShop', 'weekPass', 'trialSweep', 'dailyRewards', 'chests']) rewardSchedule(instance).clearTask(key);
          }
          session.player.level = body.level;
          session.player.exp = body.exp;
        }
      }
      if (name === 'SCVipUpdate' && session.player) {
        // VIP推送只携带变化字段；合并到登录快照后，设置页和账号缓存立即使用最新等级。
        Object.assign(session.player.vip ??= {}, body);
        persistIdentity(account, session.player);
      }
      if (name === 'SCAllActivity' || name === 'SCNewbieActivityUpdate') instance.newbieActivity = normalize(body.newbieActivity);
      if (name === 'SCAllActivity') instance.festivals = body.festivalActivities ?? [];
      // 只处理四类面板消息；其他 SC 推送仍只保留给自动化状态使用。
      for (const message of messagesFromPush(name, body)) {
        if (!appendMessage(session.messages, message)) continue;
        emitGameMessage(session, message);
      }
    });
    instance.on('state', ({ state, detail }) => {
      if (state === 'READY') connectionEstablished = true;
      emit(session, 'state', STATE_TEXT[state] ?? state, detail ? { detail } : undefined);
    });
    instance.on('frame', ({ dir, name, seq, bytes }) => trace(session, `${dir === 'out' ? '->' : '<-'} [${name}] seq=${seq} ${bytes.byteLength}B`));
    instance.on('message', ({ seq, name, body }) => trace(session, `[${name}] seq=${seq} ${JSON.stringify(body).slice(0, 400)}`));
    instance.on('pong', ({ latencyMs, offsetMs }) => trace(session, `pong ${latencyMs}ms offset=${offsetMs}ms`));
    instance.on('drop', ({ name, reason }) => emit(session, 'warn', `漏收了一条 ${name} 的应答（${reason}），本轮跳过`));
    /**
     * 对已登录会话记录一次异常断线，并按原因决定是否允许后台重连。
     * 顶号是账号所有权变化，必须保留用户手动确认的边界，不能自行重新登录。
     *
     * @param {string} reason 面向通知和运行日志的断线原因。
     * @param {boolean} allowReconnect 此原因是否允许自动重连。
     */
    const handleUnexpectedDisconnect = (reason, allowReconnect) => {
      if (session.client !== instance) return;
      if (!connectionEstablished || disconnectNotified || session.manualDisconnect) return;
      // 旧循环可能正处在日常/海面阶段，没有 runAutomation 状态也必须立即停下。
      if (session.loop.running) {
        session.loop.stop.aborted = true;
        session.loop.stop.unexpectedDisconnect = true;
      }
      // 连接层负责这次异常的单独通知，同时立即阻止当前自动化模块继续写入。
      stopAutomation(session.id, { unexpectedDisconnect: true });
      session.stages.stop(reason);
      session.loop.controller?.abort();
      notifyUnexpectedDisconnect(reason);
      if (allowReconnect) scheduleReconnect(session, account, instance, reason);
    };
    instance.on('warn', (message) => {
      emit(session, 'warn', message === 'ping timeout' ? '服务器心跳超时，连接可能已经断了' : message);
      if (message === 'ping timeout') handleUnexpectedDisconnect('服务器心跳超时', true);
    });
    instance.on('fatal', ({ reason }) => {
      const replaced = reason === 'SCChannelExpired';
      emit(session, 'error', replaced ? '这个账号在别处登录了，本条连接被顶掉' : `连接被服务器中断（${reason}）`);
      handleUnexpectedDisconnect(replaced ? '账号在其他位置登录，连接被顶掉' : `服务器中断（${reason}）`, !replaced);
    });
    instance.on('error', (error) => {
      emit(session, 'error', error.message);
      // socket error 是传输层断线；decode failed 只表示单帧异常，连接仍可能有效。
      if (error.message === 'socket error') handleUnexpectedDisconnect('WebSocket 连接错误', true);
    });
    instance.on('close', ({ code, reason } = {}) => {
      emit(session, 'state', '连接已断开');
      handleUnexpectedDisconnect(`WebSocket 关闭（${code ?? '未知'}${reason ? `，${reason}` : ''}）`, true);
    });
  }

  /** 向当前账号的 SSE 订阅者推送一条归一化游戏消息。 */
  function emitGameMessage(session, message) {
    const payload = `data: ${JSON.stringify({ kind: 'game-message', account: session.id, message })}\n\n`;
    for (const res of streams) {
      if (res.account && res.account !== session.id) continue;
      res.write(payload);
    }
  }

  /**
   * 以断线前保存的参数启动自动挂机，并用 runId 隔离旧循环迟到的回调。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {object} account 当前账号的连接凭证。
   * @param {{automationOnly: boolean, rounds: number, everyMs: number, modules: string | string[], allowPaid: boolean, allowSpeedUp: boolean, allowReroll: boolean}} options 已校验的挂机参数。
   * @returns {Promise<void>} 循环已创建后返回；实际执行进度保存在 session.loop.promise。
   */
  async function startLoop(session, account, options = {}) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    const loop = session.loop;
    if (loop.running) throw new Error('这个账号的循环已经在跑了');
    const normalized = { automationOnly: false, rounds: 0, everyMs: loop.everyMs, modules: 'all', ...options };
    if (!Number.isSafeInteger(normalized.rounds) || normalized.rounds < 0
      || !Number.isSafeInteger(normalized.everyMs) || normalized.everyMs < 1000 || normalized.everyMs > 86400000) throw new Error('轮数或循环间隔无效');
    const instance = await ensureConnected(session, account);
    if (loop.running) throw new Error('这个账号的循环已经在跑了');
    const config = loadConfigSafe();
    const runId = loop.runId + 1;
    // 断线恢复只读取此快照；数组复制避免页面或请求对象后续被修改而改变恢复内容。
    const savedOptions = { ...normalized, modules: selectLoopModules(normalized.modules) };
    loop.running = true;
    loop.rounds = savedOptions.rounds;
    loop.completed = 0;
    loop.everyMs = savedOptions.everyMs;
    loop.history = [];
    loop.error = null;
    loop.stop = { aborted: false, manuallyStopped: false };
    loop.controller = new AbortController();
    loop.stop.signal = loop.controller.signal;
    // 上游暂停、关服和角色切换使用 AbortController；统一投递到自动化停止信号。
    loop.controller.signal.addEventListener('abort', () => { loop.stop.aborted = true; }, { once: true });
    saveAutomation(account.id, { enabled: !savedOptions.automationOnly && savedOptions.rounds === 0, everySeconds: savedOptions.everyMs / 1000 });
    loop.options = savedOptions;
    loop.runId = runId;
    const roundsLabel = loop.rounds > 0 ? `${loop.rounds} 轮` : '持续运行';
    emit(session, 'info', `自动挂机开始：${roundsLabel}，每轮间隔 ${Math.floor(loop.everyMs / 1000)} 秒`);
    loop.promise = runLoop(instance, protocol, {
      config,
      player: session.player,
      accountId: account.id,
      initialPushes: session.pushes,
      automationModules: savedOptions.modules,
      automationOnly: savedOptions.automationOnly,
      rounds: loop.rounds,
      everyMs: loop.everyMs,
      allowMutate: true,
      allowPaid: savedOptions.allowPaid,
      allowSpeedUp: savedOptions.allowSpeedUp,
      allowReroll: savedOptions.allowReroll,
      stop: loop.stop,
      schedule: work => enqueue(session, work),
      isEnabled: key => loop.tasks[key] === true,
      getFishingGoldReserve: () => loop.fishingGoldReserve,
      adChannel: { clientInfo: account.login?.eworldClientInfo, language: account.login?.language },
      onRound: (summary) => {
        // 旧连接的循环可能在重连后才结束，不能覆盖新一轮的进度或错误状态。
        if (loop.runId !== runId) return;
        loop.completed = summary.round;
        loop.history.push(summary);
        if (loop.history.length > 50) loop.history.shift();
        if (summary.automation?.error) {
          loop.error = summary.automation.error;
          emit(session, 'error', `自动化模块出错，挂机已停止：${summary.automation.error}`);
        }
        if (summary.world.factories?.length) {
          // 工厂核对结果仍按账号留在本地，便于下次启动展示；不进入版本库。
          try { fs.writeFileSync(factoryReportFile(session.id), JSON.stringify({ time: new Date().toLocaleString('zh-CN'), lines: summary.world.factories })); }
          catch (error) { emit(session, 'warn', '保存工厂核对记录失败：' + error.message); }
        }
        emit(session, 'info', formatLoopRound(summary), summary.world.population ? { worldUpdated: true } : undefined);
      },
      onStep: (entry) => {
        if (loop.runId !== runId || entry.status === 'disabled') return;
        if (entry.phase === 'automation') {
          const failed = ['error', 'uncertain', 'failed', 'rejected'].includes(entry.status);
          emit(session, failed ? 'error' : 'info', `[${LABELS[entry.module]}] ${entry.label ?? entry.request ?? ''} ${entry.status}${entry.reason ? '：' + entry.reason : ''}`);
          return;
        }
        // 上游工厂合并日志和拒绝诊断继续保留，不用模块日志覆盖其结构化信息。
        const production = entry.ok && !entry.skipped && entry.step?.kind === 'startProduce';
        const batch = production ? JSON.stringify([entry.round, entry.step.body.buildingId, entry.step.body.productId]) : undefined;
        emit(session, entry.skipped || entry.ok ? 'info' : 'error', formatLoopStep(entry),
          batch ? { batch, factory: entry.step.displayFactory, product: entry.step.displayProduct }
            : entry.request && entry.ok === false ? { request: entry.request, way: entry.way } : undefined);
      },
    })
      .then(() => {
        if (loop.runId !== runId) return;
        if (loop.error && shouldNotifyUnexpectedAutomationStop(session, loop.stop)) notifyUnexpectedAutomationStop(session, loop.error, '自动挂机');
        emit(session, 'info', '自动挂机结束');
      })
      .catch((error) => {
        if (loop.runId !== runId) return;
        loop.error = error.message;
        saveAutomation(account.id, { enabled: false });
        emit(session, 'error', `自动挂机中止：${error.message}`);
        if (shouldNotifyUnexpectedAutomationStop(session, loop.stop)) notifyUnexpectedAutomationStop(session, error.message, '自动挂机');
      })
      .finally(() => {
        if (loop.runId === runId) {
          loop.running = false;
          loop.promise = null;
          loop.job = null;
          loop.controller = null;
        }
      });
    loop.job = loop.promise;
  }

  /**
   * 处理非顶号断线：先中止旧连接的写入，再重连，并按断线前快照恢复自动挂机。
   * 重连等待期间用户主动停止或启动新循环时，旧循环的恢复意图随即失效。
   *
   * @param {object} session 当前账号的本地会话。
   * @param {object} account 当前账号的连接凭证。
   * @param {GameClient} instance 发生断线的旧连接。
   * @param {string} reason 断线原因，仅用于运行日志。
   */
  function scheduleReconnect(session, account, instance, reason) {
    if (session.reconnect || session.manualDisconnect || session.client !== instance) return;
    // 保留旧停止信号的引用，避免重连期间的主动停止被 startLoop 创建的新信号覆盖。
    const interruptedStop = session.loop.stop;
    // 必须在调用 stop() 前判断，stop 会使旧循环 finally 将 running 改为 false。
    const resumeOptions = session.loop.running && session.loop.options
      ? { ...session.loop.options, modules: Array.isArray(session.loop.options.modules) ? [...session.loop.options.modules] : session.loop.options.modules }
      : null;
    session.reconnect = { instance };
    void (async () => {
      try {
        if (session.loop.running) {
          // 旧循环收到停止信号后才会释放在途写操作，确保新连接不与它并发操作同一账号。
          session.loop.stop.aborted = true;
          stopAutomation(session.id);
        }
        instance.stop();
        await session.loop.promise;
        if (session.manualDisconnect || session.client !== instance) return;

        await connect(session, account);
        emit(session, 'info', `已自动重连：${reason}`);
        // 断线本身会设置 aborted，恢复只检查人工停止；信号已替换则说明有新循环接管。
        if (resumeOptions && !interruptedStop.manuallyStopped && session.loop.stop === interruptedStop) {
          await startLoop(session, account, resumeOptions);
          emit(session, 'info', '已恢复断线前的自动挂机');
        }
      } catch (error) {
        // 用户在重连期间点击断开属于主动操作，不把它显示成自动重连失败。
        if (!session.manualDisconnect) emit(session, 'error', `自动重连失败：${error.message}`);
      } finally {
        if (session.reconnect?.instance === instance) session.reconnect = null;
      }
    })();
  }

  /**
   * 将登录或 VIP 更新后的角色身份写回账号缓存，供未连接时的账号列表展示。
   *
   * @param {object} account 当前账号凭证记录。
   * @param {object|null} player 当前角色协议对象。
   */
  function persistIdentity(account, player) {
    try {
      const store = loadStore();
      const target = store.accounts.find((entry) => entry.id === account.id);
      if (!target) return;
      const role = describeRole(player);
      target.lastSeen = { nickname: role?.nickname ?? null, level: role?.level ?? null, vipLevel: role?.vipLevel ?? null, power: role?.power ?? null, worldId: role?.worldId ?? null, at: new Date().toISOString() };
      if (!target.label && role?.nickname) target.label = role.nickname;
      saveStore(store);
    } catch {
      /* 回填失败不影响连接 */
    }
  }

  /** 同一登录先同步上游初始化信号再加载历史；取消后拒绝任何迟到的身份回填。 */
  async function loginSession(session, account) {
    if (session.client?.connected) throw new Error('这个账号已经连上了');
    // 显式连接代表用户重新授权本次会话，解除主动断开锁定。
    session.manualDisconnect = false;
    const client = new GameClient({ url: account.url, protocol });
    wire(session, account, client);
    session.client = client;
    session.player = null;
    session.pushes.clear();
    const response = await client.connect(account.login);
    // 登录等待期间也可能收到断开请求；旧回包不能恢复已取消或已替换的会话。
    if (session.manualDisconnect || session.client !== client) {
      client.stop();
      throw new Error('连接已取消');
    }
    session.player = response.playerInfo || null;
    client.send('LoginFinishRequest', {});
    persistIdentity(account, session.player);
    const role = describeRole(session.player);
    emit(session, 'info', `已进入游戏：${role?.nickname ?? '未知角色'}（${role?.level ?? '?'} 级）`);
    // 登录成功后串行加载历史；wire 已经先挂好实时监听，历史回包期间也不会漏掉推送。
    const initial = await loadInitialMessages(client, protocol);
    // 历史查询期间可能收到用户断开或账号替换；迟到的历史不能回填已取消的会话。
    if (session.manualDisconnect || session.client !== client) {
      client.stop();
      throw new Error('连接已取消');
    }
    session.messageErrors = initial.errors;
    for (const message of initial.messages) {
      if (appendMessage(session.messages, message)) emitGameMessage(session, message);
    }
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

  /** 业务入口可复用连接，但不能越过用户主动断开的登录边界。 */
  async function ensureConnected(session, account) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    if (session.manualDisconnect) throw new Error('已手动断开，请先点击“连接”');
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

  /** 状态面板轮询本身不计为业务执行，否则空闲页面会一直显示忙碌。 */
  /** 对外只暴露当前会话运行状态，不包含账号凭证。 */
  function accountStatus(session) {
    return {
      paused: session.paused,
      connected: Boolean(session.client?.connected),
      state: session.client?.snapshot?.().state ?? (session.manualDisconnect ? 'STOPPED' : 'IDLE'),
      busy: session.busy === 'GET /api/overview' ? null : session.busy,
      looping: session.loop.running,
    };
  }

  /**
   * 读取当前连接角色的 VIP 免广告资格；断线或缺少任一等级时必须隐藏开关。
   *
   * @param {object} session 当前账号的本地会话。
   * @returns {{connected: boolean, roleLevel: number|null, vipLevel: number|null, minRoleLevel: number, minVipLevel: number, eligible: boolean}} 当前资格快照。
   */
  function vipFreeAdEligibility(session) {
    const role = describeRole(session.player);
    const pushedVipLevel = session.pushes.get('SCVipUpdate')?.vipLevel;
    const roleLevel = Number.isSafeInteger(role?.level) ? role.level : null;
    const rawVipLevel = pushedVipLevel ?? role?.vipLevel;
    const vipLevel = Number.isSafeInteger(rawVipLevel) ? rawVipLevel : null;
    const connected = Boolean(session.client?.connected);
    return {
      connected,
      roleLevel,
      vipLevel,
      minRoleLevel: VIP_FREE_AD_MIN_ROLE_LEVEL,
      minVipLevel: VIP_FREE_AD_MIN_VIP_LEVEL,
      eligible: connected
        && roleLevel !== null
        && vipLevel !== null
        && roleLevel >= VIP_FREE_AD_MIN_ROLE_LEVEL
        && vipLevel >= VIP_FREE_AD_MIN_VIP_LEVEL,
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

  /** 后台总览只读取现有连接；状态刷新不能使用保存的凭证重新登录游戏。 */
  async function overview(session, account) {
    const instance = session.client;
    if (!instance?.connected) {
      // 返回本机会话状态供页面清空旧数据，避免轮询因断线不断报错或触发登录。
      return { account: describeAccount(account), status: accountStatus(session), player: null };
    }
    const { ok, failed } = await collectState(instance, protocol, { timeout: 15000, includeChat: false });
    const config = loadConfigSafe();
    // VIP 推送会在角色升档后覆盖登录快照，确保下一次总览立即使用新农作物容量。
    const cropVipLevel = session.pushes.get('SCVipUpdate')?.vipLevel ?? session.player?.vip?.vipLevel ?? 0;
    const view = summarize({ ok }, {
      config,
      scenarioId: Number(session.player?.scenarioId ?? 0),
      rawMaterialUpperBoundId: protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND,
      cropVipLevel,
    });
    const daily = view.daily;
    // 总览需要复用人工设置的种植水位，让页面能区分“低于目标”与“达到目标”。
    const cropKeepStock = loadSettings(account.id).modules?.farm?.cropKeepStock ?? {};
    // 总览只返回已经归一化的摘要，避免网页重复理解 protobuf 字段并把整份协议暴露到浏览器。
    return {
      account: describeAccount(account, { active: account.id === loadStore().activeId }),
      status: accountStatus(session),
      player: describeRole(session.player),
      resources: view.resources.map((entry) => ({ ...entry, sources: config?.materialSources(entry.res), icon: resourceIcon(entry.res) })),
      items: {
        ...view.items,
        top: view.items.top.map((item) => ({ itemId: item.itemId, name: displayMaterial(config, item.itemId), num: item.num, sources: config?.materialSources(item.itemId), icon: itemIcon(item.itemId) })),
      },
      // 原材料单独返回，避免总览只显示数量靠前的 12 种库存时漏掉鱼、木材等基础材料。
      materials: view.materials.map((item) => ({ itemId: item.itemId, num: item.num, capacity: item.capacity, icon: materialIcon(item.itemId) })),
      // 农作物单独返回，并附带按 VIP 计算的真实库存上限和人工种植水位，避免被前 12 种库存排序隐藏。
      crops: view.crops.map((item) => ({
        itemId: item.itemId,
        num: item.num,
        capacity: item.capacity,
        plantTarget: cropKeepStock[item.itemId] ?? null,
        icon: itemIcon(item.itemId),
      })),
      claimable: {
        mainTask: view.mainTask ? 1 : 0,
        daily: daily?.claimable ?? 0,
        achievement: view.achievements?.claimable ?? 0,
        email: view.email?.unclaimed ?? 0,
        afk: view.afk ? Math.max((view.afk.level ?? 0) - (view.afk.rewardedLevel ?? 0), 0) : 0,
      },
      afk: view.afk,
      clickGold: view.clickGold,
      daily: view.daily,
      achievements: view.achievements,
      mainTask: view.mainTask,
      email: view.email,
      heroes: {
        count: view.heroes.count,
        power: view.heroes.power,
        list: view.heroes.list.slice(0, 12).map((hero) => ({ ...hero, icon: heroCard(hero.heroId) ?? heroIcon(hero.heroId) })),
        formation: view.heroes.formation,
        appointed: view.heroes.appointed,
      },
      buildings: view.buildings,
      // 总览的生产面板只接收归一化后的农田与工厂状态，并在服务端补齐图标索引。
      production: {
        farms: view.buildings.filter((building) => building.farm).map((building) => ({
          buildingId: building.buildingId,
          productId: building.farm.productId,
          ripeTime: building.farm.ripeTime,
          icon: itemIcon(building.farm.productId),
        })),
        factories: view.buildings.filter((building) => building.factory).map((building) => ({
          buildingId: building.buildingId,
          autoProductId: building.factory.autoProductId ?? null,
          autoIcon: itemIcon(building.factory.autoProductId),
          queue: (building.factory.queue ?? []).map((job) => ({ ...job, icon: itemIcon(job.productId) })),
          finished: (building.factory.finished ?? []).map((product) => ({ ...product, icon: itemIcon(product.id) })),
        })),
      },
      water: view.water,
      resFields: view.resFields,
      fleets: { count: view.fleets, list: view.fleetList },
      cargo: { count: view.cargo, list: view.cargoList },
      trade: view.trade,
      tradeRadar: view.tradeRadar,
      pirates: view.pirates,
      radar: view.radar,
      worldBoss: view.worldBoss,
      guild: view.guild,
      guildTech: view.guildTech,
      guildOrder: view.guildOrder,
      counters: view.counters,
      recruit: view.recruit,
      dailyGift: view.dailyGift,
      antiques: view.antiques,
      pets: view.pets,
      equips: view.equips,
      season: view.season,
      week: view.week,
      pass: view.pass,
      weekOrder: view.weekOrder,
      monthCard: view.monthCard,
      guide: view.guide,
      guideDone: view.guideDone,
      fish: view.fish,
      updatedAt: new Date().toISOString(),
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

  /** 英雄计划只包含账号设置里明确选择的英雄，不再隐式培养全部英雄。 */
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
    const selected = loadSettings(account.id).modules.hero;
    const plan = planHeroes({ config, heroes: heroList.heroes ?? [], itemNum: (id) => counts.get(id) ?? 0, playerLevel: describeRole(session.player)?.level ?? 1, heroIds: selected.heroes, allowUniversal: selected.universal });
    return {
      steps: plan.steps,
      notes: plan.notes,
      maxLevel: plan.maxLevel,
      maxStar: plan.maxStar,
      selected: selected.heroes,
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
  /** 保存采集结果到本机账号库，验证角色后仅为显式启用的账号启动托管。 */
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
      if (created && account.automation.enabled) await startLoop(session, account, { rounds: 0 });
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

  /** 账号业务请求互斥；状态、停止和本地设置接口不占用游戏请求通道。 */
  /** 路由统一实施确认、账号隔离和队列控制；只读轮询不触发隐式登录。 */
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
    const localRoute = /\/api\/(automation\/(settings|status|stop)|loop(?:\/stop)?$)/.test(parsed.pathname);
    // 手动交单有自己的账号队列和重复点击合并，不能在只读查询尚未返回时提前拒绝。
    const longRunning = !localRoute && route !== 'POST /api/world/order/submit'
      && /\/api\/(connect|heroes|dailies|tasks|world|worlds|overview|automation|loop\/start|action)(\/|$)/.test(parsed.pathname);
    let scoped = null;
    let releaseWrite;
    let ownsBusy = false;
    // 所有账号相关的路由都先过这里：拿到账号、对应会话，长请求再挂个忙碌标记。
    const scoped_ = (url) => {
      const found = resolve(url);
      scoped = found.session;
      if (longRunning) {
        // 总览是只读采集；页面刷新时允许新请求加入同一条在途采集，避免旧请求取消后留下忙碌错误。
        const joiningOverview = route === 'GET /api/overview'
          && found.session.busy === route
          && found.session.overviewPromise;
        const overviewDuringLoop = route === 'GET /api/overview' && found.session.loop.running;
        if ((found.session.busy && !joiningOverview) || (found.session.loop.running && !overviewDuringLoop) || automationStatus(found.account.id).running) throw new Error('这个账号正在执行操作，请等待或先停止');
        if (!joiningOverview) {
          found.session.busy = route;
          ownsBusy = true;
        }
      }
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
      // 移动端原型独立挂载，先验证手机信息架构，不改变现有桌面控制台入口。
      if (route === 'GET /mobile' || route === 'GET /mobile/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(MOBILE_PAGE);
        return;
      }
      if (route === 'GET /favicon.ico') {
        // 原型没有单独的图标资源，返回空响应避免浏览器把缺失图标记为页面错误。
        res.writeHead(204);
        res.end();
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
      if (route === 'GET /api/messages') {
        const { account, session } = scoped_(parsed);
        json({ account: account.id, connected: Boolean(session.client?.connected), errors: session.messageErrors, messages: snapshotMessages(session.messages) });
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
      if (route === 'GET /api/accounts/notifications') {
        const { account } = scoped_(parsed);
        // 账号页只需要通知配置，不能把完整自动化设置取回再原样写入。
        json({ notifications: loadSettings(account.id).notifications });
        return;
      }
      if (route === 'POST /api/accounts/notifications') {
        const payload = jsonBody(); needConfirm(payload);
        const { account } = scoped_(parsed);
        const settings = loadSettings(account.id);
        // 仅替换企微配置，保留同一账号既有的模块、预算及其他自动化设置。
        settings.notifications = payload.notifications;
        json({ notifications: saveSettings(account.id, settings).notifications });
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
        const session = sessions.get(account.id);
        if (session) {
          // 删除本机凭证前必须终止仍持有旧 session/client 的后台链，不能让无界面账号继续写入游戏。
          session.loop.stop.aborted = true;
          session.loop.stop.manuallyStopped = true;
          session.manualDisconnect = true;
          session.generation++;
          stopAutomation(account.id, { manual: true });
          session.client?.stop();
          session.client = null;
          session.player = null;
          session.pushes.clear();
        }
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
              if (generation === session.generation && !session.loop.running) await startLoop(session, account);
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
        // 先设置锁定再停止客户端，避免并发轮询在清理窗口里抢先触发自动登录。
        session.manualDisconnect = true;
        session.loop.stop.aborted = true;
        session.loop.stop.manuallyStopped = true;
        stopAutomation(session.id, { manual: true });
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
      if (route === 'GET /api/automation/settings') {
        const { account, session } = scoped_(parsed);
        // 选项只读取本地缓存，不为渲染设置页面建立游戏连接或查询角色状态。
        json({ settings: loadSettings(account.id), labels: LABELS, modules: MODULES, options: automationFormOptions(loadConfigSafe()), vipAd: vipFreeAdEligibility(session) });
        return;
      }
      if (route === 'POST /api/automation/settings') {
        const payload = jsonBody(); needConfirm(payload);
        const { account } = scoped_(parsed);
        json({ settings: saveSettings(account.id, payload.settings) });
        return;
      }
      if (route === 'GET /api/automation/status') {
        const { account, session } = scoped_(parsed);
        const state = automationStatus(account.id, session.player?.playerId);
        json({ ...state, running: state.running || session.loop.running, looping: session.loop.running }); return;
      }
      if (route === 'POST /api/automation/stop') {
        const payload = jsonBody(); needConfirm(payload);
        const { account, session } = scoped_(parsed);
        session.loop.stop.aborted = true;
        session.loop.stop.manuallyStopped = true;
        stopLoop(session, '已停止自动化');
        json(stopAutomation(account.id, { manual: true })); return;
      }
      if (route === 'POST /api/automation/plan' || route === 'POST /api/automation/run') {
        const payload = jsonBody();
        const dryRun = route.endsWith('/plan');
        if (!dryRun) needConfirm(payload);
        const selector = payload.modules ?? 'all';
        selectModules(selector);
        const { account, session } = scoped_(parsed);
        const client = await ensureConnected(session, account);
        // 单次执行也持有独立停止来源，确保用户主动取消不会被当作异常停止通知。
        const stop = { aborted: false, manuallyStopped: false };
        const promise = runAutomation({ client, protocol, config: getConfig(), player: session.player, accountId: account.id, selector, dryRun, initialPushes: session.pushes, stop, onStep: row => emit(session, row.status === 'error' || row.status === 'uncertain' ? 'error' : 'info', `[${LABELS[row.module]}] ${row.label ?? row.request ?? ''} ${row.status}${row.reason ? '：' + row.reason : ''}`) });
        if (dryRun) json(await promise);
        else {
          void promise
            .then((result) => {
              if (!result.error || !shouldNotifyUnexpectedAutomationStop(session, stop)) return;
              emit(session, 'error', `自动化已停止：${result.error}`);
              notifyUnexpectedAutomationStop(session, result.error, '单次自动化');
            })
            // 启动前校验失败不会形成可停止的自动化，仍写运行记录但不发送停止通知。
            .catch(error => emit(session, 'error', error.message));
          json({ running: true });
        }
        return;
      }
      if (route === 'GET /api/overview') {
        const { account, session } = scoped_(parsed);
        // 共享同一账号的在途总览，避免刷新页面时重复向游戏发送整组只读请求。
        if (!session.overviewPromise) {
          const promise = overview(session, account);
          session.overviewPromise = promise;
        }
        json(await session.overviewPromise);
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
        json(await dailies(session, account));
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
        const { account, session } = scoped_(parsed);
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
            const result = await submitResidentOrder(client, protocol, { index, orderKey, enabled, accountId: account.id,
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
            emit(session, ok ? 'info' : 'error', ok ? `领取 · ${label}` : `领取 · ${label}失败：${error}`), undefined, undefined, undefined, session.player, { accountId: account.id });
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
        const instance = await ensureConnected(session, account);
        const selected = loadSettings(account.id).modules.hero;
        if (!selected.enabled || !selected.heroes.length) throw new Error('请在自动化设置开启英雄模块并选择英雄');
        const started = Date.now();
        const run = await runAutomation({ client: instance, protocol, config: getConfig(), player: session.player, accountId: account.id, selector: 'hero', initialPushes: session.pushes });
        const results = run.results;
        const after = await instance.request('AllHeroRequest', {}, 'AllHeroResponse', 15000);
        json({ sent: results.filter(r => r.request).length, failed: results.filter(r => !['success', 'planned', 'skipped', 'disabled'].includes(r.status)).length, ms: Date.now() - started, steps: results, error: run.error, heroes: after.heroes ?? [] });
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
          accountId: account.id,
          player: session.player,
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
          accountId: account.id, player: session.player, config: loadConfigSafe(),
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
          config, player: session.player, accountId: account.id, allowMutate: true,
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
              enabled, time => { nextCheck = time; }, undefined, session.player, { accountId: account.id, stop: signal });
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
        const automationOnly = payload.automationOnly === true;
        // 主挂机缺省为持续运行；自动化模块的独立循环仍保持单轮，避免改变该入口的现有语义。
        const rounds = payload.rounds ?? (automationOnly ? 1 : 0);
        if (!Number.isSafeInteger(Number(rounds)) || Number(rounds) < 0 || !Number.isFinite(Number(payload.everySeconds ?? 60)) || Number(payload.everySeconds ?? 60) < 1) throw new Error('循环轮数必须为非负整数，间隔至少 1 秒');
        // 循环只接受当前仍可运营的模块，并把规范化结果传给后台任务。
        const modules = selectLoopModules(payload.modules ?? 'all');
        await startLoop(session, account, {
          automationOnly,
          rounds: Number(rounds),
          everyMs: Number(payload.everySeconds ?? 60) * 1000,
          modules,
          allowPaid: payload.paid === true,
          allowSpeedUp: payload.speedUp === true,
          allowReroll: payload.reroll === true,
        });
        json({ ok: true, running: true });
        return;
      }
      if (route === 'POST /api/loop/stop') {
        const payload = jsonBody();
        needConfirm(payload);
        const { session } = scoped_(parsed);
        session.loop.stop.aborted = true;
        session.loop.stop.manuallyStopped = true;
        stopAutomation(session.id, { manual: true });
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
        // 上游开关全部关闭时，已启用的新版模块仍应继续运行。
        if (!Object.values(tasks).some(Boolean) && !Object.values(loadSettings(session.id).modules).some(options => options.enabled)) stopLoop(session, '全部自动项目已暂停');
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
      if (ownsBusy && scoped?.busy === route) {
        scoped.busy = null;
        // 只由创建采集的请求释放共享标记；加入者不能清掉仍在返回中的结果。
        if (route === 'GET /api/overview') scoped.overviewPromise = null;
      }
    }
  }

  function saveAutomation(id, change) {
    const store = loadStore();
    const account = store.accounts.find(item => item.id === id);
    if (!account) return;
    account.automation = { ...account.automation, ...change };
    saveStore(store);
  }

  /** 取消调度等待及当前自动化，使停止后不再排入新的游戏写操作。 */
  function stopLoop(session, reason) {
    const loop = session.loop;
    if (!loop.running) return;
    if (!session.paused) saveAutomation(session.id, { enabled: false });
    loop.stop.aborted = true;
    loop.controller?.abort();
    stopAutomation(session.id);
    emit(session, 'info', reason);
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
        server.listen(port, host, async () => {
          emit(null, 'info', `控制台已启动 http://${host}:${port}`);
          for (const account of loadStore().accounts) {
            if (!account.automation?.enabled || account.automation.paused) continue;
            const session = sessionFor(account.id);
            try { await startLoop(session, account); }
            catch (error) { emit(session, 'error', `无法恢复挂机：${error.message}`); }
          }
          resolve(`http://${host}:${port}`);
        });
      }),
    /** 关闭控制台先取消所有后台写入，再断开连接及事件订阅。 */
    close: () => {
      for (const session of sessions.values()) {
        session.manualDisconnect = true;
        session.loop.stop.aborted = true;
        stopAutomation(session.id, { manual: true });
        session.loop.controller?.abort();
        session.stages.stop('控制台已关闭');
        session.client?.stop();
      }
      for (const stream of streams) stream.end();
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

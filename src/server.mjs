import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GameClient, toNumber } from './client.mjs';
import { challengeTrial, trialProgress } from './trials.mjs';
import { readHeroEquipment, equipHeroEmptySlots, enhanceHeroEquipment, uidText } from './hero-equipment.mjs';
import { readEquipmentCrafting, startEquipmentCraft, collectEquipmentCraft } from './equipment-crafting.mjs';
import { readGuild, claimGuildWelfare } from './guild.mjs';
import { readFleetFormations, initializeFleetFormation } from './fleet-formation.mjs';
import { readLineups, applyLineup } from './lineups.mjs';
import { loadProtocol } from './proto.mjs';
import { PAGE } from './page.mjs';
import { MOBILE_PAGE } from './mobile-page.mjs';
import { listWorlds, enterWorld, describeRole } from './worlds.mjs';
import { collectState, summarize, formatState, ENTRY_QUERIES } from './game.mjs';
import { claimRewards } from './claim-rewards.mjs';
import { fishView, newbieView } from './collections.mjs';
import { normalize } from './worlds.mjs';
import { pirateDailySweepLimit, pirateSweepProgress, pirateTracker, pirateHuntOptions, startPirateHunt } from './pirates.mjs';
import { activityView, runActivity } from './activities.mjs';
import { applyActiveScore, syncFestivalDay } from './free-rewards.mjs';
import { pirateBoard, claimCampaignReports } from './pirate-board.mjs';
import { displayMaterial, getConfig } from './config.mjs';
import { planHeroes, runHeroPlan, formatHeroPlan } from './heroes.mjs';
import { appointments } from './appointments.mjs';
import { surveyDailies, runDailies, formatSurvey } from './dailies.mjs';
import { surveyTasks, runTasks, formatTaskPlan } from './tasks.mjs';
import { makeTypeResolver, weekFactoryInfo, surveyWorld, planWorld, runWorldRound, submitResidentOrder, formatWorldPlan, formatFieldReport, loadMapAsset } from './world.mjs';
import { runLoop, formatLoopRound, formatLoopStep } from './loop.mjs';
import { describeLogError } from './log-errors.mjs';
import { operationLabels } from './operation-labels.mjs';
import { automationTasks, defaultFishingGoldReserve, defaultCompassSpinCount, maxCompassSpinCount, taskSettings, worldTaskKey } from './automation.mjs';
import { rewardSchedule } from './reward-schedule.mjs';
import { normalizeReconnect, parseReconnect, reconnectDelaySeconds, recoveryDecision } from './reconnect.mjs';
import { createNotifier, loadNotifySettings, notifyEvents, parseNotifySettings, saveNotifySettings, webhookFormats } from './notify.mjs';
import { incomeView, readIncomeSnapshot, recordIncome } from './income-report.mjs';
import { createStageTask } from './stages.mjs';
import { runAction } from './actions.mjs';
import { loadStore, saveStore, upsertAccount, removeAccount, setActive, pickAccount, describeAccount, revealAccount, DATA_DIR } from './accounts.mjs';
import { startCapture, stopCapture, captureState, DEFAULT_PROXY_PORT } from './capture.mjs';
import { iconIndex, atlasFile, itemIcon, resourceIcon, materialIcon, heroIcon, heroCard, buildingIcon, workerIcon } from './art.mjs';
import { runAutomation, automationStatus, stopAutomation } from './automation/service.mjs';
import { loadSettings, saveSettings, LABELS, MODULES, selectModules, selectLoopModules } from './automation/settings.mjs';
import { automationFormOptions } from './automation/form-options.mjs';
import { appendMessage, createMessageStore, loadInitialMessages, messagesFromPush, snapshotMessages } from './messages.mjs';

const LOG_LIMIT = 400;
const CACHE_REFRESH_MS = 30_000;
const CORE_CACHE_QUERIES = new Set([
  'AllItemRequest', 'AllResourceRequest', 'AllHeroRequest', 'GetFormationRequest',
  'GameEffectRequest', 'OnWaterRequest', 'CargoShipsRequest', 'MyFleetsRequest',
]);
const CACHE_QUERY_CATEGORIES = {
  AllItemRequest: 'inventory', AllResourceRequest: 'inventory', GameEffectRequest: 'inventory',
  AllHeroRequest: 'heroes', GetFormationRequest: 'heroes', EquipsRequest: 'heroes', BadgesRequest: 'heroes',
  RecruitInfoRequest: 'heroes', AppointInfoRequest: 'heroes', OnWaterRequest: 'production', CargoShipsRequest: 'cargo',
  MyFleetsRequest: 'fleets', TreasureLootStatsRequest: 'world', TreasureLootListRequest: 'world', TreasureLootRankRequest: 'world',
  TradeInfoRequest: 'world', TradeGuildRadarRequest: 'world', PirateKillRecordRequest: 'world', MyResFieldsRequest: 'world',
  WorldBossInfoRequest: 'world', LimitedBossOpenRequest: 'world', RadarInfoRequest: 'world', AllPirateRequest: 'world',
  MyFormationPresetRequest: 'world', EmailBoxRequest: 'tasks', AchievementInfoRequest: 'tasks', DailyTaskInfoRequest: 'tasks',
  DailyGiftPackRequest: 'tasks', MainTaskInfoRequest: 'tasks', AfkInfoRequest: 'tasks', MonthCardRequest: 'tasks',
  CounterInfoRequest: 'tasks', ChannelRewardInfoRequest: 'tasks', LimitTicketRequest: 'tasks', SeasonTaskStageRequest: 'activities',
  SeasonRankInfoRequest: 'activities', PassStageStateRequest: 'activities', WeekInfoRequest: 'activities', WeekOrderInfoRequest: 'activities',
  SeasonCardRequest: 'activities', AllAntiqueRequest: 'activities', AllPetRequest: 'activities', FishEncyclopediaRequest: 'activities',
  AllGuildAbstractionRequest: 'guild', GuildTechInfoRequest: 'guild', GuildOrderRequest: 'guild', GuideInfoRequest: 'tasks',
  EnvSkinListRequest: 'activities', BlackListRequest: 'activities', UltraOpenRequest: 'activities', ChurnInfoRequest: 'activities',
};
const MODULE_CACHE_CATEGORIES = {
  farm: ['production', 'inventory'], island: ['production', 'inventory'], cargo: ['cargo', 'inventory'], world: ['fleets', 'world', 'inventory'],
  gather: ['production', 'fleets', 'inventory'], resident: ['production', 'tasks', 'inventory'], welfare: ['tasks', 'inventory'],
  hero: ['heroes', 'inventory'], antique: ['activities', 'inventory'], pet: ['heroes', 'inventory'], equip: ['heroes', 'inventory'],
  battle: ['heroes', 'world', 'inventory'], guild: ['guild', 'inventory'], activity: ['activities', 'inventory'], afk: ['tasks', 'inventory'],
};
const OUTAGE_ALERT_ATTEMPT = 3;
const TASK_FAILURE_ALERT_ROUNDS = 5;
const INCOME_SAMPLE_MS = 10 * 60 * 1000;
const VIP_FREE_AD_MIN_ROLE_LEVEL = 10;
const VIP_FREE_AD_MIN_VIP_LEVEL = 3;
const GIFT_CODE_BATCH_ROUTE = 'POST /api/gift-codes/redeem';
const validSpinCount = count => Number.isSafeInteger(count) && count >= 1 && count <= maxCompassSpinCount;
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

/** Parse comma- or line-separated gift codes without changing server-significant case. */
export function parseGiftCodes(value) {
  const unique = new Set();
  for (const item of String(value ?? '').split(/[,，\r\n]+/)) {
    const code = item.trim();
    if (code) unique.add(code);
  }
  return [...unique];
}

/** Format a redeemed reward using local configuration without exposing raw protocol objects to the log. */
export function formatGiftCodeRewards(reward, config, protocol) {
  const assets = Array.isArray(reward?.asset) ? reward.asset : [];
  if (!assets.length) return '服务器未返回奖励明细';
  return assets.map((asset) => {
    const id = asset?.id;
    const amount = toNumber(asset?.num);
    const name = Number(asset?.type) === 1
      ? config?.resourceName?.(Number(id)) ?? `资源 #${id}`
      : config?.materialName?.(id) ?? String(id ?? '未知道具');
    return `${name} × ${Number.isFinite(amount) ? amount.toLocaleString('zh-CN') : String(asset?.num ?? '?')}`;
  }).join('、');
}

/** Keep confirmed battle losses visually distinct from malformed or uncertain automation results. */
export function automationEntryLogLevel(entry) {
  if (['ChallengeStageRequest', 'TrialRaidChallengeRequest'].includes(entry.request)
    && entry.status === 'failed' && !entry.reason) return 'info';
  return ['error', 'uncertain', 'failed', 'rejected'].includes(entry.status) ? 'error' : 'info';
}

export function createConsole({ host = '127.0.0.1', port = 17321 }) {
  const protocol = loadProtocol();
  const globalLog = [];
  const streams = new Set();
  const sessions = new Map();
  let logId = 0;
  // Only one cross-account redemption batch may be active because each code response has no account ID.
  let giftCodeBatch = null;
  const notifier = createNotifier({ onError: message => emit(null, 'warn', '通知发送失败：' + message) });

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

  /** Create a blank per-account overview cache that is safe to discard when a connection changes. */
  function createOverviewCache() {
    return {
      queries: new Map(),
      stagedQueries: new Map(),
      categories: new Map(),
      updatedAt: null,
      syncing: false,
      initialSync: true,
      lastError: null,
      syncPromise: null,
      refreshTimer: null,
    };
  }

  /** Map a low-level read request to the user-facing overview section it refreshes. */
  function cacheCategoryForQuery(name) {
    return CACHE_QUERY_CATEGORIES[name] ?? 'other';
  }

  /** Save successful reads and retain older values after a failed category read. */
  function recordCachedQuery(session, name, body, error = null) {
    const cache = session.cache;
    const category = cacheCategoryForQuery(name);
    const previous = cache.categories.get(category) ?? { updatedAt: null, stale: true, error: null };
    if (!error) {
      cache.queries.set(name, normalize(body));
      cache.stagedQueries.delete(name);
      cache.categories.set(category, { updatedAt: new Date().toISOString(), stale: false, error: null });
      cache.updatedAt = new Date().toISOString();
      return;
    }
    cache.categories.set(category, { ...previous, stale: true, error: error.message || String(error) });
    cache.lastError = error.message || String(error);
  }

  /** Stage reads made inside a write batch until its matching category refresh has completed. */
  function stageCachedQuery(session, name, body) {
    session.cache.stagedQueries.set(name, normalize(body));
  }

  /** Return only JSON-safe cache metadata to the browser. */
  function cacheStatus(session) {
    return {
      updatedAt: session.cache.updatedAt,
      syncing: session.cache.syncing,
      initialSync: session.cache.initialSync,
      lastError: session.cache.lastError,
      categories: Object.fromEntries(session.cache.categories),
    };
  }

  /** Select the protocol reads necessary to refresh one or more summary categories. */
  function cacheQueriesForCategories(categories) {
    const wanted = new Set(categories);
    return ENTRY_QUERIES.filter(query => wanted.has(cacheCategoryForQuery(query.name)));
  }

  /**
   * Refresh a session cache serially. A partial failure marks that category stale while leaving
   * the last successful snapshot visible, which is safer than replacing game state with blanks.
   */
  async function syncOverviewCache(session, account, { queries = ENTRY_QUERIES, reason = 'full' } = {}) {
    if (!session.client?.connected || session.manualDisconnect || session.paused) return;
    if (session.cache.syncPromise) return session.cache.syncPromise;
    const client = session.client;
    const cache = session.cache;
    cache.syncing = true;
    const work = (async () => {
      const failedCategories = new Set();
      const reportedFailures = new Set();
      const [{ ok, failed }] = await Promise.all([
        collectState(client, protocol, {
          timeout: 15_000,
          includeChat: false,
          queries,
          onResult: (name, body, error) => {
            if (session.cache !== cache || session.client !== client) return;
            if (error) {
              failedCategories.add(cacheCategoryForQuery(name));
              reportedFailures.add(name);
            }
            recordCachedQuery(session, name, body, error);
          },
        }),
        // Keep the live power value in the same cache refresh; the UI must never revive the retired direct-read path.
        refreshPlayerPower(session, client),
      ]);
      if (session.cache !== cache || session.client !== client) return { ok, failed };
      for (const [name, message] of Object.entries(failed)) {
        failedCategories.add(cacheCategoryForQuery(name));
        if (!reportedFailures.has(name)) recordCachedQuery(session, name, null, new Error(message));
      }
      for (const category of failedCategories) {
        const previous = cache.categories.get(category) ?? { updatedAt: null, stale: true, error: null };
        cache.categories.set(category, { ...previous, stale: true, error: previous.error ?? '分类查询失败' });
      }
      // Merchant rank is keyed by the currently visible ship, so it belongs to the same cache refresh.
      if (reason !== 'core' && ok.TreasureLootListRequest?.treasure) {
        const target = ok.TreasureLootListRequest.treasure.find(entry => Number(entry.color) === 5);
        if (target && protocol.TreasureLootRankRequest && protocol.TreasureLootRankResponse) {
          try {
            const rank = await client.request('TreasureLootRankRequest', { uid: target.uid }, 'TreasureLootRankResponse', 15_000);
            if (session.cache === cache && session.client === client) recordCachedQuery(session, 'TreasureLootRankRequest', rank);
          } catch (error) {
            if (session.cache === cache && session.client === client) recordCachedQuery(session, 'TreasureLootRankRequest', null, error);
          }
        }
      }
      return { ok, failed };
    })();
    cache.syncPromise = work;
    try { return await work; }
    finally {
      if (session.cache === cache) {
        if (cache.syncPromise === work) cache.syncPromise = null;
        cache.syncing = false;
      }
    }
  }

  /** Stop the account's idle cache timer before a session is discarded or replaced. */
  function stopOverviewCacheTimer(session) {
    if (!session.cache.refreshTimer) return;
    clearInterval(session.cache.refreshTimer);
    session.cache.refreshTimer = null;
  }

  /** Refresh an otherwise idle connection every 30 seconds without restarting a manual disconnect. */
  function startOverviewCacheTimer(session, account) {
    stopOverviewCacheTimer(session);
    session.cache.refreshTimer = setInterval(() => {
      if (!session.client?.connected || session.paused || session.loop.running || session.busy || automationStatus(session.id).running) return;
      void syncOverviewCache(session, account).catch(error => { session.cache.lastError = error.message; });
    }, CACHE_REFRESH_MS);
    session.cache.refreshTimer.unref?.();
  }

  /** Refresh categories affected by a completed automation module and then discard its staged reads. */
  async function refreshOverviewCategories(session, account, categories) {
    const queries = cacheQueriesForCategories(categories);
    if (!queries.length) return;
    const cache = session.cache;
    try {
      await syncOverviewCache(session, account, { queries, reason: 'category' });
    } catch (error) {
      if (session.cache === cache) {
        for (const category of categories) {
          const previous = cache.categories.get(category) ?? { updatedAt: null, stale: true, error: null };
          cache.categories.set(category, { ...previous, stale: true, error: error.message });
        }
        cache.lastError = error.message;
      }
    } finally {
      if (session.cache === cache) for (const query of queries) cache.stagedQueries.delete(query.name);
    }
  }

  /** Start core cache warmup after login, then finish the rest of the summary in the background. */
  async function startOverviewCacheLifecycle(session, account) {
    stopOverviewCacheTimer(session);
    session.cache = createOverviewCache();
    const cache = session.cache;
    void (async () => {
      try {
        await syncOverviewCache(session, account, { queries: ENTRY_QUERIES.filter(query => CORE_CACHE_QUERIES.has(query.name)), reason: 'core' });
        if (session.cache !== cache) return;
        cache.initialSync = false;
        await syncOverviewCache(session, account);
        if (session.cache === cache && session.client?.connected && !session.manualDisconnect && !session.paused
          && !session.loop.running && !session.busy && !automationStatus(session.id).running) startOverviewCacheTimer(session, account);
      } catch (error) {
        if (session.cache !== cache) return;
        cache.lastError = error.message;
        cache.initialSync = false;
        cache.syncing = false;
      }
    })();
  }

  /** Identify existing work that must finish before a redemption request may use this account connection. */
  function hasActiveGiftRedeemConflict(session) {
    return Boolean(session.busy || session.loop.running || session.stages.view().running || automationStatus(session.id).running);
  }

  /** Wait for an already-connected account to become idle without using its stored credentials to reconnect. */
  async function acquireGiftRedeemSlot(session, account, batch) {
    let announced = false;
    while (session.client?.connected) {
      if (!hasActiveGiftRedeemConflict(session)) {
        session.busy = GIFT_CODE_BATCH_ROUTE;
        return session.client;
      }
      if (!announced) {
        announced = true;
        emitGiftRedeemLog('warn', account, batch, 'waiting', '这个账号正在执行操作，请等待或先停止');
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }

  /** Publish cross-account redemption progress through the global SSE log for the account page. */
  function emitGiftRedeemLog(level, account, batch, phase, message, details = {}) {
    const title = account ? describeAccount(account).title : null;
    const prefix = title ? `批量兑换 · ${title} · ` : '批量兑换 · ';
    emit(null, level, prefix + message, {
      batchRedeem: { id: batch.id, phase, accountId: account?.id ?? null, accountTitle: title, ...details },
    });
  }

  /** Submit a batch's codes serially for one account so a late response cannot be assigned to a later code. */
  async function redeemGiftCodesForAccount(session, account, batch, codes, summary) {
    const client = await acquireGiftRedeemSlot(session, account, batch);
    if (!client) {
      summary.offline += 1;
      emitGiftRedeemLog('warn', account, batch, 'offline', '账号已离线，未调用兑换接口');
      return;
    }
    summary.online += 1;
    try {
      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index];
        try {
          const response = await client.request('GotGiftCodeRequest', { giftCode: code }, 'GotRewardResponse');
          const rewards = formatGiftCodeRewards(response?.reward, loadConfigSafe(), protocol);
          summary.succeeded += 1;
          emitGiftRedeemLog('info', account, batch, 'result', `兑换码 ${code} 兑换成功：${rewards}`, { status: 'success', code, rewards });
        } catch (error) {
          summary.failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          emitGiftRedeemLog('error', account, batch, 'result', `兑换码 ${code} 兑换失败：${reason}`, { status: 'failed', code, reason });
          // Only a server prompt conclusively belongs to this code. Unknown outcomes stop this account to avoid response mixups.
          if (!error?.prompt) {
            const remaining = codes.length - index - 1;
            if (remaining > 0) emitGiftRedeemLog('warn', account, batch, 'result', `兑换结果未确认，已停止该账号剩余 ${remaining} 个兑换码`, { status: 'stopped', remaining });
            break;
          }
        }
      }
    } finally {
      if (session.busy === GIFT_CODE_BATCH_ROUTE) session.busy = null;
    }
  }

  /** Run one frozen account/code batch in saved-account order and report a concise aggregate result. */
  async function runGiftCodeBatch(batch, codes, accounts) {
    const summary = { online: 0, offline: 0, succeeded: 0, failed: 0 };
    emitGiftRedeemLog('info', null, batch, 'start', `开始处理 ${codes.length} 个兑换码；仅调用当前在线账号`, { codes: codes.length, accounts: accounts.length });
    for (const account of accounts) {
      const session = sessionFor(account.id);
      if (!session.client?.connected) {
        summary.offline += 1;
        emitGiftRedeemLog('warn', account, batch, 'offline', '账号未在线，未调用兑换接口');
        continue;
      }
      try {
        await enqueue(session, () => redeemGiftCodesForAccount(session, account, batch, codes, summary), '批量兑换');
      } catch (error) {
        summary.offline += 1;
        const reason = error instanceof Error ? error.message : String(error);
        emitGiftRedeemLog('warn', account, batch, 'offline', `账号任务已取消，未调用剩余兑换码：${reason}`, { reason, status: 'stopped' });
      }
    }
    emitGiftRedeemLog(summary.failed || summary.offline ? 'warn' : 'info', null, batch, 'summary',
      `本批结束：在线 ${summary.online} 个，离线 ${summary.offline} 个，成功 ${summary.succeeded} 次，失败 ${summary.failed} 次`, summary);
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
      claiming: null,
      heroJob: null,
      queueTail: null,
      appointmentJob: null,
      residentJobs: new Map(),
      progressionJobs: new Map(),
      pushes: new Map(),
      // The overview cache and message history are process-local and always isolated by account session.
      cache: createOverviewCache(),
      messages: createMessageStore(),
      messageErrors: [],
      recovery: null,
      failStreak: new Map(),
      stats: { rounds: 0, failures: 0, outages: 0 },
      incomeAt: 0,
      log: [],
      // An explicit disconnect prevents background reads and queued work from silently logging in again.
      manualDisconnect: false,
      loop: {
        running: false,
        rounds: 0,
        completed: 0,
        everyMs: (saved?.everySeconds ?? 60) * 1000,
        tasks: taskSettings(saved?.tasks),
        fishingGoldReserve: saved?.fishingGoldReserve ?? defaultFishingGoldReserve,
        compassSpinCount: saved?.compassSpinCount ?? defaultCompassSpinCount,
        reconnect: normalizeReconnect(saved?.reconnect),
        controller: null, job: null,
        stop: { aborted: false, manuallyStopped: false },
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
      // A replaced connection can still emit delayed pushes; never let it mutate the active role cache.
      if (session.client !== instance) return;
      if (name.startsWith('SC')) session.pushes.set(name, body);
      for (const message of messagesFromPush(name, body)) {
        if (appendMessage(session.messages, message)) emitGameMessage(session, message);
      }
      if (session.client === instance && session.player) {
        if (name === 'SCJoinGuild') session.player.guildId = body.guildId;
        if (name === 'SCLeaveGuild') session.player.guildId = 0;
      }
      // The loop keeps a reference to this login's player object. Update it in place
      // so crossing an unlock level takes effect without restarting the console.
      if (name === 'SCPlayerExpUpdate' && session.client === instance && session.player && body.level > 0) {
        if (session.player.level !== body.level) {
          for (const key of ['adShop', 'weekPass', 'trialSweep', 'dailyRewards', 'chests',
            'museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'worldOnline', 'tradeTasks', 'seasonTasks',
            'museumRevenue', 'museumAchievements', 'heroGrowth', 'stageAuto', 'treasureLoot']) rewardSchedule(instance).clearTask(key);
        }
        session.player.level = body.level;
        session.player.exp = body.exp;
      }
      if (name === 'SCPlayerPower' && session.client === instance && session.player && toNumber(body.power) > 0) {
        session.player.power = body.power;
      }
      if (name === 'SCVipUpdate' && session.client === instance && session.player) {
        Object.assign(session.player.vip ??= {}, { vipLevel: body.vipLevel, vipExp: body.vipExp });
      }
      if (name === 'SCAllActivity' || name === 'SCNewbieActivityUpdate') instance.newbieActivity = normalize(body.newbieActivity);
      if (name === 'SCActivityActiveScoreUpdate') applyActiveScore(instance, body);
      // A finished battle should pay out even when idle is off, as long as the switch is on.
      if (name === 'SCNewCampaignReport' && session.client === instance) {
        emit(session, 'info', '收到新战报', { pirateUpdated: true });
        if (session.loop.tasks.campaignReports && !session.reportClaim) {
          session.reportClaim = enqueue(session, () => claimCampaignReports(instance, loadConfigSafe(), session.player,
            key => key === 'campaignReports' && session.client === instance && session.loop.tasks.campaignReports,
            entry => emit(session, 'info', entry.label, { pirateUpdated: true })))
            .catch(error => emit(session, 'warn', '领取战报奖励失败：' + error.message))
            .finally(() => { session.reportClaim = null; });
        }
      }
      if (name === 'SCAllActivity') {
        instance.tradeActivity = normalize(body.trade);
        instance.festivals = body.festivalActivities ?? [];
        instance.festivalDay = undefined;
        syncFestivalDay(instance);
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
      instance.fatalReason = reason;
      emit(session, 'error', message);
      // 有些传输层在 fatal 后不会再触发 close；立即走同一恢复策略，避免挂机悬挂。
      connectionLost(session, instance);
    });
    instance.on('error', (error) => emit(session, 'error', error.message));
    instance.on('close', () => {
      connectionLost(session, instance);
      emit(session, 'state', '连接已断开');
    });
  }

  /** Send a normalized game message only to subscribers watching its owning account. */
  function emitGameMessage(session, message) {
    const payload = `data: ${JSON.stringify({ kind: 'game-message', account: session.id, message })}\n\n`;
    for (const res of streams) {
      if (res.account && res.account !== session.id) continue;
      res.write(payload);
    }
  }

  function alert(session, event, title, message) {
    const account = loadStore().accounts.find(item => item.id === session.id);
    const name = account ? describeAccount(account).title : session.id;
    notifier.send(event, session.id, name + '：' + title, message)
      .catch(error => emit(session, 'warn', '通知发送失败：' + error.message));
  }

  function cancelRecovery(session) {
    const waiting = Boolean(session.recovery?.timer);
    clearTimeout(session.recovery?.timer);
    session.recovery = null;
    return waiting;
  }

  function connectionLost(session, instance) {
    if (instance.lostHandled || instance.stopping || session.client !== instance) return;
    instance.lostHandled = true;
    const kicked = instance.fatalReason === 'SCChannelExpired';
    const reason = kicked ? '账号在别处登录，连接被顶掉' : '连接已断开';
    session.stages.stop(reason);
    // Detailed automation has its own abort signal; mark this transport failure so it stops promptly
    // without reporting a second user-facing "manual stop" result.
    stopAutomation(session.id, { unexpectedDisconnect: true });
    const loop = session.loop;
    if (!loop.running || loop.controller?.signal.aborted) return;
    if (loop.rounds !== 0) { stopLoop(session, reason); return; }
    session.stats.outages += 1;
    loop.controller.abort();
    emit(session, 'info', reason);
    requestRecovery(session, kicked ? 'kicked' : 'network', reason);
  }

  // 只有持续挂机才恢复。有限轮数的任务和用户主动停止都不会走到这里。
  function requestRecovery(session, kind, reason) {
    const settings = session.loop.reconnect;
    const attempt = (session.recovery?.attempts ?? 0) + 1;
    const decision = recoveryDecision(settings, kind, attempt);
    clearTimeout(session.recovery?.timer);
    if (decision.action === 'stop') {
      session.recovery = null;
      saveAutomation(session.id, { enabled: false });
      if (decision.reason === 'kicked') {
        emit(session, 'warn', '账号被顶号，已停止挂机。需要时请在挂机页重新开始，或在设置中改为自动重连');
        alert(session, 'kicked', '账号被顶号', '已停止挂机，需要时请手动恢复。');
      } else {
        const message = decision.reason === 'exhausted' ? '已重连 ' + settings.maxAttempts + ' 次仍未恢复，已停止挂机' : '未开启自动重连，已停止挂机';
        emit(session, 'warn', message);
        alert(session, 'disconnect', '挂机已停止', message + '（' + reason + '）');
      }
      return;
    }
    const seconds = reconnectDelaySeconds(settings, attempt, kind);
    const recovery = { kind, attempts: attempt, reason, nextAt: Date.now() + seconds * 1000, connected: false, timer: null };
    recovery.timer = setTimeout(() => recoverSession(session, recovery), seconds * 1000);
    recovery.timer.unref?.();
    session.recovery = recovery;
    emit(session, 'info', seconds + ' 秒后自动重连（第 ' + attempt + ' 次）');
    if (kind === 'kicked' && attempt === 1) alert(session, 'kicked', '账号被顶号', settings.kickedMinutes + ' 分钟后自动重连，这可能把正在玩的游戏顶下线。');
    if (kind !== 'kicked' && attempt === OUTAGE_ALERT_ATTEMPT) alert(session, 'disconnect', '掉线后仍未恢复', '已尝试重连 ' + attempt + ' 次，会继续重试。原因：' + reason);
  }

  async function recoverSession(session, recovery) {
    recovery.timer = null;
    recovery.nextAt = null;
    await session.loop.job;
    if (session.recovery !== recovery || session.loop.running) return;
    const account = loadStore().accounts.find(item => item.id === session.id);
    if (session.paused || !account) { cancelRecovery(session); return; }
    if (!session.client?.connected) {
      session.client?.stop();
      session.client = null;
      session.player = null;
    }
    try { startLoop(session, account); }
    catch (error) { requestRecovery(session, recovery.kind, error.message); }
  }

  function trackRound(session, summary) {
    if (session.recovery && !session.recovery.timer) session.recovery = null;
    const results = [...summary.tasks.results, ...summary.dailies.results, ...summary.world.results];
    const failed = results.filter(entry => !entry.skipped && entry.ok === false);
    session.stats.rounds += 1;
    session.stats.failures += failed.length;
    const streak = new Map();
    for (const entry of failed) {
      const id = entry.key || entry.label || entry.title || entry.step?.label || '自动任务';
      const count = (session.failStreak.get(id) ?? 0) + 1;
      streak.set(id, count);
      if (count === TASK_FAILURE_ALERT_ROUNDS) {
        alert(session, 'taskFailing', '自动任务连续失败', (entry.label || entry.title || id) + ' 已连续 ' + count + ' 轮失败：' + (entry.error || '未返回原因'));
      }
    }
    session.failStreak = streak;
    if (Date.now() - session.incomeAt < INCOME_SAMPLE_MS) return;
    session.incomeAt = Date.now();
    enqueue(session, async () => {
      const client = session.client;
      if (!client?.connected) return;
      const snapshot = await readIncomeSnapshot(client, session.player);
      recordIncome(session.id, snapshot, session.stats);
      session.stats = { rounds: 0, failures: 0, outages: 0 };
    }).catch(error => emit(session, 'warn', '记录收益日报失败：' + error.message));
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
    // An explicit connect is the only operation that may clear the manual-disconnect boundary.
    session.manualDisconnect = false;
    const client = new GameClient({ url: account.url, protocol });
    wire(session, client);
    session.client = client;
    session.player = null;
    session.pushes.clear();
    const response = await client.connect(account.login);
    if (session.manualDisconnect || session.client !== client) {
      client.stop();
      throw new Error('连接已取消');
    }
    session.player = response.playerInfo || null;
    client.send('LoginFinishRequest', {});
    persistIdentity(account, session.player);
    const role = describeRole(session.player);
    emit(session, 'info', `已进入游戏：${role?.nickname ?? '未知角色'}（${role?.level ?? '?'} 级）`);
    // Realtime handlers are already attached; load history after login so the page receives both past and new messages.
    const initial = await loadInitialMessages(client, protocol);
    if (session.manualDisconnect || session.client !== client) {
      client.stop();
      throw new Error('连接已取消');
    }
    session.messageErrors = initial.errors;
    for (const message of initial.messages) {
      if (appendMessage(session.messages, message)) emitGameMessage(session, message);
    }
    await startOverviewCacheLifecycle(session, account);
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

  function accountStatus(session) {
    return {
      paused: session.paused,
      connected: Boolean(session.client?.connected),
      state: session.client?.snapshot?.().state ?? (session.manualDisconnect ? 'STOPPED' : 'IDLE'),
      busy: session.busy,
      looping: session.loop.running,
      recovering: Boolean(session.recovery?.timer),
    };
  }

  function loadConfigSafe() {
    try {
      return getConfig();
    } catch {
      return null;
    }
  }

  /**
   * Return the live VIP free-ad eligibility used to reveal the optional automation setting.
   * Stored settings alone cannot establish this entitlement after an account switches roles.
   *
   * @param {object} session Account-local game session.
   * @returns {{connected: boolean, roleLevel: number|null, vipLevel: number|null, minRoleLevel: number, minVipLevel: number, eligible: boolean}} Eligibility snapshot.
   */
  function vipFreeAdEligibility(session) {
    const role = describeRole(session.player);
    // The VIP push arrives after a role upgrade while the login snapshot stays unchanged for this connection.
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
      eligible: connected && roleLevel !== null && vipLevel !== null
        && roleLevel >= VIP_FREE_AD_MIN_ROLE_LEVEL && vipLevel >= VIP_FREE_AD_MIN_VIP_LEVEL,
    };
  }

  /**
   * Read the configured price for one paid gold click. Missing or invalid local config must not
   * be replaced with a guessed price in the automation settings page.
   *
   * @param {object|null} config Loaded local game configuration.
   * @returns {number|null} Verified positive price, if available.
   */
  function clickGoldUnitPrice(config) {
    const value = config?.tables?.OfflineParamCfg?.data?.find(row => row.paramName === '点金价格')?.paramValue;
    const price = Number(value);
    return Number.isSafeInteger(price) && price > 0 ? price : null;
  }

  // ---- 只读汇总 -------------------------------------------------------------

  // The login snapshot can lag far behind the server, so read power the way the game's
  // player info popup does. A failed read keeps the last known value.
  async function refreshPlayerPower(session, instance) {
    if (!session.player?.playerId) return;
    try {
      const reply = await instance.request('OtherPlayerInfoRequest', { playerId: uidText(session.player.playerId) }, 'OtherPlayerInfoResponse', 8000);
      if (session.client === instance && session.player && toNumber(reply.power) > 0) session.player.power = reply.power;
    } catch (error) {
      emit(session, 'warn', `总览：未能读取最新战力：${error.message}`, { diagnostic: 'OtherPlayerInfoRequest' });
    }
  }

  /** Build the overview exclusively from the account cache so page polling never creates an implicit login. */
  function buildOverviewFromCache(session, account) {
    const ok = Object.fromEntries(session.cache.queries);
    const failed = Object.fromEntries([...session.cache.categories]
      .flatMap(([category, state]) => state.error ? [[category, state.error]] : []));
    const config = loadConfigSafe();
    const vipLevel = session.pushes.get('SCVipUpdate')?.vipLevel ?? session.player?.vip?.vipLevel ?? 0;
    const view = summarize({ ok }, {
      config,
      scenarioId: Number(session.player?.scenarioId ?? 0),
      rawMaterialUpperBoundId: protocol.GameEffectId.RAW_MATERIAL_UPPER_BOUND,
      cropVipLevel: vipLevel,
      pirateVipLevel: vipLevel,
    });
    const merchantRankItems = ok.TreasureLootRankRequest?.items ?? [];
    const playerId = describeRole(session.player)?.id;
    const merchantRank = merchantRankItems.find(item => String(item.playerId) === String(playerId))?.rank ?? null;
    const merchantShip = {
      ...(view.merchantShip ?? {}),
      rank: merchantRank,
      reward: (view.merchantShip?.reward ?? []).map(asset => ({ ...asset, name: displayMaterial(config, asset.id) })),
    };
    const daily = view.daily;
    const cropKeepStock = loadSettings(account.id).modules?.farm?.cropKeepStock ?? {};
    return {
      account: describeAccount(account, { active: account.id === loadStore().activeId }),
      status: accountStatus(session),
      player: describeRole(session.player),
      resources: (view.resources ?? []).map(entry => ({ ...entry, sources: config?.materialSources(entry.res), icon: resourceIcon(entry.res) })),
      items: {
        ...view.items,
        top: (view.items?.top ?? []).map(item => ({ itemId: item.itemId, name: displayMaterial(config, item.itemId), num: item.num,
          sources: config?.materialSources(item.itemId), icon: itemIcon(item.itemId) })),
      },
      materials: (view.materials ?? []).map(item => ({ itemId: item.itemId, num: item.num, capacity: item.capacity, icon: materialIcon(item.itemId) })),
      crops: (view.crops ?? []).map(item => ({ itemId: item.itemId, num: item.num, capacity: item.capacity,
        plantTarget: cropKeepStock[item.itemId] ?? null, icon: itemIcon(item.itemId) })),
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
        count: view.heroes?.count ?? 0,
        power: view.heroes?.power ?? 0,
        list: (view.heroes?.list ?? []).slice(0, 12).map(hero => ({ ...hero, icon: heroCard(hero.heroId) ?? heroIcon(hero.heroId) })),
        formation: view.heroes?.formation,
        appointed: view.heroes?.appointed,
      },
      buildings: view.buildings,
      production: {
        farms: (view.buildings ?? []).filter(building => building.farm).map(building => ({ buildingId: building.buildingId,
          productId: building.farm.productId, ripeTime: building.farm.ripeTime, icon: itemIcon(building.farm.productId) })),
        factories: (view.buildings ?? []).filter(building => building.factory).map(building => ({ buildingId: building.buildingId,
          autoProductId: building.factory.autoProductId ?? null, autoIcon: itemIcon(building.factory.autoProductId),
          queue: (building.factory.queue ?? []).map(job => ({ ...job, icon: itemIcon(job.productId) })),
          finished: (building.factory.finished ?? []).map(product => ({ ...product, icon: itemIcon(product.id) })),
        })),
      },
      water: view.water,
      resFields: view.resFields,
      fleets: { count: view.fleets, list: view.fleetList },
      cargo: { count: view.cargo, list: view.cargoList },
      merchantShip,
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
      updatedAt: session.cache.updatedAt,
      unreadable: Object.keys(failed),
      text: formatState(view),
      cache: cacheStatus(session),
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
      futurePopulation: survey.futurePopulation > survey.population ? survey.futurePopulation : null,
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
    // These routes only read or adjust local control state, so they must remain usable while a loop owns the game connection.
    const automationControlRoute = /^\/api\/(automation\/(settings|status|stop)|messages|overview|loop(?:\/(?:stop|reconnect|fishing-reserve|compass-spin-count|task))?$)/.test(parsed.pathname);
    const longRunning = /^(GET|POST) \/api\/(heroes|dailies|tasks|world|overview|loop|automation)(\/|$)/.test(route);
    let scoped = null;
    let releaseWrite;
    let ownsBusy = false;
    // 所有账号相关的路由都先过这里：拿到账号、对应会话，长请求再挂个忙碌标记。
    const scoped_ = (url) => {
      const found = resolve(url);
      scoped = found.session;
      const overviewRead = route === 'GET /api/overview';
      // Status, stop and cached overview reads must remain available to recover from an in-flight operation.
      const readOrControlRoute = overviewRead || automationControlRoute;
      const advancedAutomationRequest = /^POST \/api\/automation\/(plan|run)$/.test(route);
      // Advanced automation bypasses the ordinary request queue, so it must not begin while a queued console operation owns the account.
      if (advancedAutomationRequest && found.session.busy) {
        throw new Error('这个账号正在执行操作，请等待或先停止');
      }
      // The advanced automation service owns an account-wide role lock. Do not start a separate
      // console operation that could interleave game requests while it is still applying a plan.
      if (!readOrControlRoute && automationStatus(found.account.id, found.session.player?.playerId).running) {
        throw new Error('这个账号正在执行高级自动化，请等待或先停止');
      }
      // Cached overview reads are allowed during an existing operation and must not replace its write lock.
      if (longRunning && !readOrControlRoute) {
        found.session.busy = route;
        ownsBusy = true;
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
      // Mobile remains a separate information-architecture prototype and does not replace the desktop console.
      if (route === 'GET /mobile' || route === 'GET /mobile/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(MOBILE_PAGE);
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

      // ---- 批量兑换码 ------------------------------------------------------
      if (route === GIFT_CODE_BATCH_ROUTE) {
        const payload = jsonBody();
        needConfirm(payload);
        if (giftCodeBatch) throw new Error('批量兑换码任务正在执行，请等待当前批次结束');
        const codes = parseGiftCodes(payload.codes);
        if (!codes.length) throw new Error('请至少输入一个兑换码（使用逗号或换行分隔）');
        // Freeze both the account order and code order before asynchronous queue waits begin.
        const accounts = [...loadStore().accounts];
        const batch = { id: `gift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
        giftCodeBatch = batch;
        batch.promise = Promise.resolve().then(() => runGiftCodeBatch(batch, codes, accounts))
          .catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            emitGiftRedeemLog('error', null, batch, 'summary', `本批异常中止：${reason}`, { reason });
          })
          .finally(() => { if (giftCodeBatch === batch) giftCodeBatch = null; });
        json({ started: true, batchId: batch.id, codes });
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
        if (removed) {
          cancelRecovery(removed);
          stopOverviewCacheTimer(removed);
          removed.manualDisconnect = true;
          removed.generation += 1;
          removed.cache = createOverviewCache();
          // Deletion invalidates the account session even when the loop has not created its AbortController yet.
          stopLoop(removed, '账号已删除');
        }
        // Removing an account must also abort its account-scoped automation lock before discarding the session.
        stopAutomation(account.id, { manual: true });
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
            stopAutomation(account.id, { manual: true });
            stopLoop(session, '账号暂停，结束挂机');
            session.stages.stop('账号已暂停');
            stopOverviewCacheTimer(session);
            session.cache = createOverviewCache();
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
        const { account, session } = scoped_(parsed);
        stopAutomation(account.id, { manual: true });
        stopLoop(session, '账号已断开');
        session.stages.stop('账号已断开');
        // Cancel delayed login/cache callbacks before releasing the connection reference.
        session.manualDisconnect = true;
        session.generation += 1;
        session.loop.stop.aborted = true;
        stopOverviewCacheTimer(session);
        session.cache = createOverviewCache();
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

      // ---- 高级自动化 -------------------------------------------------------
      if (route === 'GET /api/automation/settings') {
        const { account, session } = scoped_(parsed);
        // The settings page only uses locally cached configuration and must not log in just to render form choices.
        const config = loadConfigSafe();
        json({
          settings: loadSettings(account.id), labels: LABELS, modules: MODULES,
          options: automationFormOptions(config), clickGoldUnitPrice: clickGoldUnitPrice(config),
          vipAd: vipFreeAdEligibility(session),
        });
        return;
      }
      if (route === 'GET /api/automation/pirate-sweep-status') {
        const { session } = scoped_(parsed);
        // Saving settings must not create an implicit connection; only reuse an existing role session for its live quota.
        if (!session.client?.connected) {
          json({ connected: false });
          return;
        }
        const state = await session.client.request('AllPirateRequest', {}, 'AllPirateResponse');
        const vipLevel = session.player?.vip?.vipLevel;
        json({ connected: true, ...pirateSweepProgress(state.sweepTimes, pirateDailySweepLimit(loadConfigSafe()?.tables, vipLevel)) });
        return;
      }
      if (route === 'POST /api/automation/settings') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        // When online, revalidate against the current VIP tier so an old browser tab cannot exceed today's sweep quota.
        const vipLevel = session.client?.connected
          ? session.pushes.get('SCVipUpdate')?.vipLevel ?? session.player?.vip?.vipLevel
          : null;
        const pirateDailyLimit = vipLevel == null ? null : pirateDailySweepLimit(loadConfigSafe()?.tables, vipLevel);
        json({ settings: saveSettings(account.id, payload.settings, { pirateDailyLimit }) });
        return;
      }
      if (route === 'GET /api/automation/status') {
        const { account, session } = scoped_(parsed);
        const state = automationStatus(account.id, session.player?.playerId);
        json({ ...state, running: state.running || session.loop.running, looping: session.loop.running });
        return;
      }
      if (route === 'POST /api/automation/stop') {
        const payload = jsonBody();
        needConfirm(payload);
        const { account, session } = scoped_(parsed);
        stopAutomation(account.id, { manual: true });
        if (session.loop.running) stopLoop(session, '已停止自动化');
        const state = automationStatus(account.id, session.player?.playerId);
        json({ ...state, running: state.running || session.loop.running, looping: session.loop.running });
        return;
      }
      if (route === 'POST /api/automation/plan' || route === 'POST /api/automation/run') {
        const payload = jsonBody();
        const dryRun = route.endsWith('/plan');
        if (!dryRun) needConfirm(payload);
        const selector = payload.modules ?? 'all';
        selectModules(selector);
        const { account, session } = scoped_(parsed);
        if (session.loop.running) throw new Error('当前账号正在挂机，请先停止挂机后再执行高级自动化');
        const config = loadConfigSafe();
        if (!config) throw new Error('缺少游戏配置，无法执行高级自动化');
        const client = await ensureConnected(session, account);
        // A dedicated stop source preserves the reason for this manual run without affecting the main idle-loop controller.
        const stop = { aborted: false, manuallyStopped: false, unexpectedDisconnect: false };
        const promise = runAutomation({
          client, protocol, config, player: session.player, accountId: account.id, selector, dryRun, stop,
          onQuery: (name, value) => { if (session.client === client) stageCachedQuery(session, name, value); },
          onModuleComplete: async moduleId => refreshOverviewCategories(session, account, MODULE_CACHE_CATEGORIES[moduleId] ?? []),
          onStep: row => emit(session, ['error', 'uncertain', 'failed', 'rejected'].includes(row.status) ? 'error' : 'info',
            '[' + (LABELS[row.module] ?? row.module) + '] ' + (row.label ?? row.request ?? '') + ' ' + row.status + (row.reason ? '：' + row.reason : '')),
        });
        if (dryRun) {
          json(await promise);
        } else {
          void promise.then((result) => {
            if (!result.error || stop.manuallyStopped || stop.unexpectedDisconnect) return;
            emit(session, 'error', '高级自动化已停止：' + result.error);
            alert(session, 'loopError', '高级自动化异常停止', result.error);
          }).catch(error => emit(session, 'error', '高级自动化启动失败：' + error.message));
          json({ running: true });
        }
        return;
      }

      // ---- 只读视图 ----
      if (route === 'GET /api/overview') {
        const { account, session } = scoped_(parsed);
        // A paused account must behave like every other protected operation, rather than serving a stale managed snapshot.
        if (session.paused) throw new Error('账号已暂停，请先恢复托管');
        // Reading the overview must remain safe while disconnected, busy, or recovering; login owns cache population.
        json(buildOverviewFromCache(session, account));
        return;
      }
      if (route === 'GET /api/heroes') {
        const { account, session } = scoped_(parsed);
        json(await heroes(session, account));
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
      if (route === 'GET /api/pirates/board') {
        const { account, session } = scoped_(parsed);
        json(await progressionJob(session, account, route, null, client => pirateBoard(client, loadConfigSafe(), session.player)));
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
          const result = await startPirateHunt(client, config, player, { ...payload, enabled, report: entry => emit(session, 'info', typeof entry === 'string' ? entry : entry.label, { pirateUpdated: true }) });
          emit(session, 'info', result.label);
          return result;
        }));
        return;
      }
      if (route === 'GET /api/lineups') {
        const { account, session } = scoped_(parsed);
        json(await progressionJob(session, account, route, null, client => readLineups(client, loadConfigSafe(), session.player)));
        return;
      }
      if (route === 'POST /api/lineups/apply') {
        const { account, session } = scoped_(parsed);
        const payload = jsonBody();
        needConfirm(payload);
        const key = JSON.stringify([route, payload.targetKey, payload.previewKey]);
        json(await progressionJob(session, account, key, operationLabels[parsed.pathname], async (client, enabled) => {
          const result = await applyLineup(client, loadConfigSafe(), session.player, { targetKey: payload.targetKey, previewKey: payload.previewKey, enabled });
          emit(session, 'info', result.label);
          return result;
        }));
        return;
      }
      if (route === 'POST /api/activities/run') {
        const { account, session } = scoped_(parsed);
        const payload = jsonBody();
        needConfirm(payload);
        if (payload.spinCount !== undefined && !validSpinCount(payload.spinCount)) throw new Error('抽奖券张数必须是 1 到 ' + maxCompassSpinCount + ' 的整数');
        const key = JSON.stringify([route, payload.activityId, payload.taskKey]);
        json(await progressionJob(session, account, key, '单次执行活动', (client, enabled) =>
          runActivity(client, loadConfigSafe(), {
            activityId: payload.activityId, taskKey: payload.taskKey, enabled, playerLevel: session.player?.level, player: session.player, spinCount: payload.spinCount ?? session.loop.compassSpinCount,
            report: entry => emit(session, entry.error ? 'error' : 'info',
              [entry.label, entry.error || entry.reason].filter(Boolean).join(' · ')),
          })));
        return;
      }
      if (route === 'GET /api/activities') {
        const { account, session } = scoped_(parsed);
        const client = await ensureConnected(session, account);
        const view = await activityView(client, client.festivals, loadConfigSafe(), session.player);
        view.vipLevel = session.player?.vip?.vipLevel ?? 0;
        view.compassSpinCount = session.loop.compassSpinCount;
        view.newbie = newbieView(client);
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
        const activityTasks = new Set(['fishBook', 'vipDaily', 'campaignReports', 'openRankRewards', ...view.activities.flatMap(row => row.taskKeys)]);
        view.eventTasks = automationTasks.filter(task => activityTasks.has(task.key)).map(({ key, label }) => ({ key, label, enabled: session.loop.tasks[key] }));
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
            const result = await submitResidentOrder(client, protocol, { index, orderKey, enabled,
              // 居民订单执行会进入账号级业务锁，必须沿用当前请求的账号范围。
              accountId: account.id, config: loadConfigSafe(), player: session.player, cargoEnabled: () => session.loop.tasks.cargo });
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
          // The cache owns overview reads; reward collection only needs the serialized game connection.
          const instance = await ensureConnected(session, account);
          emit(session, 'info', '开始一键领取');
          const results = await claimRewards(instance, protocol, loadConfigSafe(), ({ label, ok, error }) =>
            emit(session, ok ? 'info' : 'error', ok ? `领取 · ${label}` : `领取 · ${label}失败：${error}`), undefined, undefined, undefined, session.player,
          // 领奖会通过账号级业务锁串行写入，不能把当前账号上下文留空。
          { accountId: account.id });
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
          // 海面计划可触发账号级写入上下文，手动执行与挂机使用同一账号隔离规则。
          accountId: account.id, config, player: session.player, allowMutate: true,
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
              enabled, time => { nextCheck = time; }, undefined, session.player, { accountId: account.id });
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
        cancelRecovery(session);
        const automationOnly = payload.automationOnly === true;
        const rounds = payload.rounds ?? (automationOnly ? 1 : 0);
        startLoop(session, account, {
          rounds,
          everySeconds: payload.everySeconds,
          automationModules: payload.modules ?? 'all',
          automationOnly,
        });
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

      if (route === 'POST /api/loop/reconnect') {
        const { session } = scoped_(parsed);
        const reconnect = parseReconnect(jsonBody());
        saveAutomation(session.id, { reconnect });
        session.loop.reconnect = reconnect;
        if (!reconnect.enabled && cancelRecovery(session)) {
          saveAutomation(session.id, { enabled: false });
          emit(session, 'info', '已关闭自动重连，取消等待中的重连');
        } else emit(session, 'info', '自动重连设置已保存');
        json(loopView(session));
        return;
      }
      if (route === 'GET /api/notify') {
        json({ settings: loadNotifySettings(), events: notifyEvents, formats: webhookFormats });
        return;
      }
      if (route === 'POST /api/notify/save') {
        const settings = parseNotifySettings(jsonBody());
        saveNotifySettings(settings);
        emit(null, 'info', '通知设置已保存');
        json({ settings });
        return;
      }
      if (route === 'POST /api/notify/test') {
        const result = await notifier.test();
        if (result.failures.length) throw new Error(result.failures.join('；'));
        emit(null, 'info', '测试通知已发送');
        json(result);
        return;
      }
      if (route === 'GET /api/income') {
        json(incomeView(scoped_(parsed).session.id));
        return;
      }
      if (route === 'POST /api/loop/compass-spin-count') {
        const { session } = scoped_(parsed);
        const { compassSpinCount } = jsonBody();
        if (!validSpinCount(compassSpinCount)) throw new Error('抽奖券张数必须是 1 到 ' + maxCompassSpinCount + ' 的整数');
        saveAutomation(session.id, { compassSpinCount });
        session.loop.compassSpinCount = compassSpinCount;
        emit(session, 'info', '风水罗盘每次最多使用 ' + compassSpinCount + ' 张抽奖券');
        json({ compassSpinCount });
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
      if (ownsBusy && scoped && scoped.busy === route) scoped.busy = null;
    }
  }

  function saveAutomation(id, change) {
    const store = loadStore();
    const account = store.accounts.find(item => item.id === id);
    if (!account) return;
    account.automation = { ...account.automation, ...change };
    saveStore(store);
  }

  /** Cancel pending recovery and signal the loop before aborting its optional in-flight wait controller. */
  function stopLoop(session, reason) {
    if (cancelRecovery(session)) {
      if (!session.paused) saveAutomation(session.id, { enabled: false });
      emit(session, 'info', reason);
    }
    const loop = session.loop;
    if (!loop.running || loop.controller?.signal.aborted) return;
    if (!session.paused) saveAutomation(session.id, { enabled: false });
    loop.stop.aborted = true;
    loop.stop.manuallyStopped = true;
    // A just-created or test-restored loop can be running before its controller is attached.
    loop.controller?.abort();
    emit(session, 'info', reason);
  }

  /** Start an account-isolated idle loop after validating module scope, scheduling and stop controls. */
  function startLoop(session, account, {
    rounds = 0,
    everySeconds = session.loop.everyMs / 1000,
    automationModules = 'all',
    automationOnly = false,
  } = {}) {
    if (session.paused) throw new Error('账号已暂停，请先恢复托管');
    if (session.manualDisconnect) throw new Error('已手动断开，请先点击“连接”');
    const loop = session.loop;
    if (loop.running) throw new Error('这个账号的挂机已在运行');
    if (!Number.isSafeInteger(rounds) || rounds < 0) throw new Error('轮数必须是非负整数');
    if (!Number.isSafeInteger(everySeconds) || everySeconds < 1 || everySeconds > 86400) throw new Error('间隔秒数需要为 1–86400 的整数');
    const selectedAutomationModules = selectLoopModules(automationModules);
    if (!automationOnly && !Object.values(loop.tasks).some(Boolean)) throw new Error('请至少启用一个自动项目');
    // Detailed-only runs are explicitly started from the automation page and must not silently resume after a restart.
    saveAutomation(account.id, { enabled: !automationOnly && rounds === 0, everySeconds });
    Object.assign(loop, { running: true, rounds, completed: 0, everyMs: everySeconds * 1000,
      history: [], error: null, controller: new AbortController(), stop: { aborted: false, manuallyStopped: false } });
    const { signal } = loop.controller;
    // The loop exposes status through the stop object, while its waits need the controller signal to wake immediately.
    loop.stop.signal = signal;
    signal.addEventListener('abort', () => { loop.stop.aborted = true; }, { once: true });
    const runScope = rounds === 0 ? '持续运行' : `共 ${rounds} 轮`;
    emit(session, 'info', `自动挂机开始：${runScope}，每 ${everySeconds} 秒检查一次`);
    let credentialFailed = false, retryReason = null;
    loop.job = (async () => {
      try {
        const client = await ensureConnected(session, account);
        if (signal.aborted) return;
        if (session.recovery && !session.recovery.connected) {
          session.recovery.connected = true;
          emit(session, 'info', '已自动重连，继续挂机');
          if (session.recovery.attempts >= OUTAGE_ALERT_ATTEMPT || session.recovery.kind === 'kicked') {
            alert(session, 'recovered', '已恢复挂机', '重连 ' + session.recovery.attempts + ' 次后恢复。');
          }
        }
        const { appId, channelId, originVersion } = account.login?.eworldClientInfo ?? {};
        await runLoop(client, protocol, { config: loadConfigSafe(), player: session.player,
          // 统一自动化的设置、账本和业务锁都按账号隔离，循环不能丢失当前账号上下文。
          accountId: account.id,
          automationModules: selectedAutomationModules,
          automationOnly,
          adChannel: { clientInfo: { appId, channelId, originVersion }, language: account.login?.language },
          rounds, everyMs: loop.everyMs, allowMutate: true, stop: loop.stop,
          schedule: work => enqueue(session, work),
          onQuery: (name, value) => { if (session.client === client) stageCachedQuery(session, name, value); },
          onModuleComplete: async moduleId => refreshOverviewCategories(session, account, MODULE_CACHE_CATEGORIES[moduleId] ?? []),
          isEnabled: key => loop.tasks[key] === true,
          getFishingGoldReserve: () => loop.fishingGoldReserve,
          getCompassSpinCount: () => loop.compassSpinCount,
          isStageBusy: () => session.stages.view().running,
          onRound(summary) {
            trackRound(session, summary);
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
          if (error.loginResponse) credentialFailed = true;
          else if (rounds === 0 && loop.reconnect.enabled) retryReason = error.message;
          else {
            saveAutomation(account.id, { enabled: false });
            alert(session, 'loopError', '挂机异常停止', error.message);
          }
          emit(session, retryReason ? 'warn' : 'error', `自动挂机中止：${error.message}`);
        }
      } finally {
        loop.running = false;
        loop.controller = null;
        loop.job = null;
        emit(session, 'info', '自动挂机结束');
        if (credentialFailed) {
          cancelRecovery(session);
          saveAutomation(account.id, { enabled: false });
          emit(session, 'error', '服务器拒绝登录，凭证可能已失效。请在账号页重新采集后再开始挂机');
          alert(session, 'credential', '登录凭证可能已失效', '服务器拒绝登录，挂机已停止。请重新采集账号凭证。');
        } else if (retryReason) requestRecovery(session, session.recovery?.kind === 'kicked' ? 'kicked' : 'network', retryReason);
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
      reconnect: loop.reconnect,
      recovery: session.recovery ? { kind: session.recovery.kind, attempts: session.recovery.attempts,
        nextAt: session.recovery.nextAt, reason: session.recovery.reason } : null,
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
        cancelRecovery(session);
        stopAutomation(session.id, { manual: true });
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

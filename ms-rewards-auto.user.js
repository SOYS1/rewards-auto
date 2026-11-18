// ==UserScript==
// @name         Microsoft Rewards 自动助手（核心）
// @namespace    https://github.com/soys/ms-rewards-auto
// @version      1.0.0
// @description  Bing 搜索与 Rewards 每日任务自动化核心；不含 UI，面板可通过 window.MSRewards 事件接入
// @author       soys
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @match        https://*.bing.com/*
// @match        https://rewards.bing.com/*
// @icon         https://www.bing.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 设计说明
 * ------------------------------------------------------------------
 * 1. 整个自动化是「单标签页状态机」：脚本跟随页面跳转，每次加载都从
 *    GM 存储里恢复状态并推进一步，因此不需要常驻后台、也不受标签页
 *    节流影响（真正的动作永远发生在当前活动标签页）。
 * 2. 阶段流转：
 *      每日任务（dashboard/earn 扫卡片 → 逐个访问）→ 搜索（N 次随机查询）
 *      → 回 Rewards 复核积分 → 结束
 * 3. 只访问白名单域名，绝不点击兑换、抽奖、aka.ms 推广等链接。
 * 4. UI 层只需要监听 window 上的 msr:* 事件，即可显示状态与日志。
 */

(function () {
  'use strict';

  /* ================= 常量与默认配置 ================= */

  const VERSION = '1.0.0';
  const STATE_KEY = 'msr:state:v1';
  const SETTINGS_KEY = 'msr:settings:v1';

  const REWARDS_DASHBOARD = 'https://rewards.bing.com/dashboard';
  const REWARDS_EARN = 'https://rewards.bing.com/earn';

  const CARD_SELECTOR = 'a[data-react-aria-pressable="true"]';
  const SUCCESS_CLASS = 'bg-statusSuccessRewardsBg';

  // 卡片上的导航项，不能当成每日任务。
  const SKIP_PATHS = new Set([
    '/', '/dashboard', '/earn', '/redeem', '/about', '/refer',
    '/sweeps/promotion', '/faq', '/sitemap', '/redeem/orderhistory'
  ]);

  // 只有这些域名下的卡片才可能发放每日积分，其余一律跳过。
  const TASK_HOSTS = ['www.bing.com', 'cn.bing.com', 'rewards.bing.com', 'www.msn.com', 'www.microsoft.com'];

  const NEXT_TEXTS = [
    '下一个', '下一题', '下一页', '继续', '提交', '完成', '查看结果', '开始',
    'next', 'continue', 'submit', 'finish', 'done', 'see results', 'start'
  ];

  const OPTION_SELECTOR = [
    '[role="radio"]',
    '[role="option"]',
    'input[type="radio"]',
    '.rqOption',
    '[class*="answer"] button',
    '[class*="Answer"] button',
    '[class*="option"] button'
  ].join(',');

  const QUIZ_ROOT_SELECTOR = [
    '#rqQuiz',
    '#bep-quiz',
    '#quiz',
    '[id*="quiz" i]',
    '[class*="quiz" i]',
    '[data-testid*="quiz" i]'
  ].join(',');

  const ACTION_SELECTOR = 'button, [role="button"], a[role="button"], input[type="submit"], input[type="button"]';

  const DEFAULT_SETTINGS = {
    // 搜索
    searchEnabled: true,
    desktopTarget: 30,      // 每日 PC 搜索次数（各地区额度不同，按需调整）
    mobileTarget: 0,        // 移动端搜索需要移动 UA，脚本无法在桌面浏览器完成
    minDelayMs: 4500,       // 两次搜索之间的最小间隔
    maxDelayMs: 9000,       // 两次搜索之间的最大间隔
    // 每日任务
    dailySet: true,         // 访问 dashboard/earn 上的每日活动卡片
    quizzes: true,          // 在答题页尝试自动作答
    punchcards: false,      // 拼图卡片（/earn/quest/）大多需要桌面应用，默认跳过
    // 行为
    maxAttemptsPerTask: 2,  // 同一任务最多访问次数，用于判定失败
    stallAfter: 6,          // 连续多少次搜索没有涨分就停止
    maxRuntimeMin: 45,      // 单次运行的最长时间
    autoStart: false,       // 每天首次打开 Rewards 时自动运行
    showPanel: true         // 是否在页面上显示悬浮面板
  };

  /* ================= 存储 ================= */

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readRaw(key) {
    try {
      if (hasGM) {
        const raw = GM_getValue(key, '');
        return raw ? JSON.parse(raw) : null;
      }
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('[MSR] 读取存储失败', error);
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      const raw = JSON.stringify(value);
      if (hasGM) GM_setValue(key, raw);
      else localStorage.setItem(key, raw);
    } catch (error) {
      console.warn('[MSR] 写入存储失败', error);
    }
  }

  /* ================= 工具 ================= */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  function todayKey() {
    return new Date().toLocaleDateString('en-CA');
  }

  function parsePoints(text) {
    if (!text) return null;
    const digits = String(text).replace(/[^\d]/g, '');
    if (!digits) return null;
    const value = parseInt(digits, 10);
    return Number.isFinite(value) ? value : null;
  }

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  }

  async function waitFor(probe, timeoutMs = 6000, intervalMs = 300) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  function isRewardsPage() {
    return location.hostname === 'rewards.bing.com';
  }

  function isBingPage() {
    return /(^|\.)bing\.com$/i.test(location.hostname) && !isRewardsPage();
  }

  /* ================= 日志 / 事件 ================= */

  let state = loadState();
  let settings = loadSettings();

  const subscribers = new Set();

  function emit(type, detail) {
    const payload = { type, detail, state: publicState() };
    for (const fn of subscribers) {
      try {
        fn(payload);
      } catch (error) {
        console.warn('[MSR] 事件订阅者异常', error);
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('msr:' + type, { detail: payload }));
    } catch { /* 忽略事件派发异常 */ }
    // 面板已经挂载时顺手刷新一下，保证状态与日志即时可见。
    if (type !== 'stats') renderPanel();
  }

  function log(message, level = 'info') {
    const entry = { at: Date.now(), level, message };
    state.log = (state.log || []).slice(-199).concat(entry);
    persist();
    if (level === 'error') console.error('[MSR]', message);
    else if (level === 'warn') console.warn('[MSR]', message);
    else console.log('[MSR]', message);
    emit('log', entry);
  }

  /* ================= 状态 ================= */

  function emptySearch() {
    return { done: 0, target: 0, pointsStart: null, pointsLast: null, stall: 0, inFlight: false, lastQuery: '' };
  }

  function createState() {
    return {
      version: VERSION,
      running: false,
      stopRequested: false,
      phase: 'idle',          // idle | daily | search | search-review | done | error
      date: todayKey(),
      startedAt: 0,
      lastRunAt: 0,
      navCount: 0,
      search: emptySearch(),
      scanned: { dashboard: false, earn: false },
      stats: { date: todayKey(), at: 0, today: null, total: null, streak: null, tasks: [] },
      tasks: {},
      log: []
    };
  }

  function loadState() {
    const saved = readRaw(STATE_KEY);
    const base = createState();
    const next = { ...base, ...(saved || {}) };
    next.search = { ...base.search, ...((saved && saved.search) || {}) };
    next.scanned = { ...base.scanned, ...((saved && saved.scanned) || {}) };
    next.stats = { ...base.stats, ...((saved && saved.stats) || {}) };
    next.tasks = (saved && saved.tasks) || {};
    next.log = (saved && saved.log) || [];
    // 跨天时清掉当天的任务与搜索进度，但保留运行中的会话。
    if (next.date !== todayKey()) resetDaily(next);
    return next;
  }

  function resetDaily(target) {
    target.date = todayKey();
    target.tasks = {};
    target.search = emptySearch();
    target.scanned = { dashboard: false, earn: false };
    target.navCount = 0;
    if (target.running) target.phase = 'daily';
  }

  function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(readRaw(SETTINGS_KEY) || {}) };
  }

  function persist() {
    writeRaw(STATE_KEY, state);
  }

  function publicState() {
    return JSON.parse(JSON.stringify({
      version: state.version,
      running: state.running,
      phase: state.phase,
      date: state.date,
      startedAt: state.startedAt,
      search: state.search,
      scanned: state.scanned,
      stats: state.stats,
      tasks: Object.values(state.tasks),
      log: state.log.slice(-40)
    }));
  }

  /* ================= 每日任务：扫描 ================= */

  function cardTitle(card) {
    const heading = card.querySelector('h1,h2,h3,h4,[role="heading"],[data-testid*="title"],[class*="title"],[class*="Title"]');
    const fromHeading = (heading?.innerText || '').trim();
    if (fromHeading) return fromHeading.split('\n')[0].trim();
    const lines = (card.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const useful = lines.find((line) => !/^已完成$|^Completed$/i.test(line));
    return (useful || '').slice(0, 80);
  }

  // 成功状态类是最可靠的信号；部分卡片（例如搜索类任务）只渲染「已完成」文案。
  function isCardCompleted(card) {
    if (card.querySelector('.' + SUCCESS_CLASS)) return true;
    const text = (card.innerText || '').trim();
    return /(^|\n)\s*(已完成|Completed)\s*$/i.test(text);
  }

  function isAllowedTaskUrl(url) {
    if (!TASK_HOSTS.includes(url.hostname)) return false;
    if (SKIP_PATHS.has(url.pathname)) return false;
    if (/\/(redeem|sweeps)(\/|$)/.test(url.pathname)) return false;
    // 账号/语言设置等入口也带 data-react-aria-pressable，必须排除。
    if (/^\/(account|profile|preferences|signin|login)/i.test(url.pathname)) return false;
    return true;
  }

  function taskKind(url) {
    if (/\/earn\/quest\//.test(url.pathname)) return 'quest';
    if (/bing\.com$/i.test(url.hostname) && url.pathname === '/search') return 'search';
    return 'page';
  }

  function scanCards() {
    if (!isRewardsPage()) return [];
    const found = new Map();
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const rawHref = card.getAttribute('href');
      if (!rawHref) continue;
      let url;
      try {
        url = new URL(rawHref, location.href);
      } catch {
        continue;
      }
      if (!isAllowedTaskUrl(url)) continue;
      const title = cardTitle(card);
      if (!title) continue;
      const id = hash(url.href);
      if (found.has(id)) continue;
      found.set(id, {
        id,
        title,
        url: url.href,
        kind: taskKind(url),
        completed: isCardCompleted(card)
      });
    }
    return [...found.values()];
  }

  // 把页面上的卡片状态合并进持久化任务表，并推进「访问过但未完成」的任务。
  function syncTasks(cards) {
    const now = Date.now();
    for (const card of cards) {
      const existing = state.tasks[card.id];
      if (!existing) {
        state.tasks[card.id] = {
          id: card.id,
          title: card.title,
          url: card.url,
          kind: card.kind,
          completed: card.completed,
          status: card.completed ? 'done' : 'pending',
          attempts: 0,
          firstSeen: now,
          lastSeen: now
        };
        continue;
      }
      existing.title = card.title;
      existing.url = card.url;
      existing.completed = card.completed;
      existing.lastSeen = now;
      if (card.completed) {
        existing.status = 'done';
        continue;
      }
      // active / visited 都表示「本次已经访问过」，回到 Rewards 后按访问次数决定重试或放弃。
      if (existing.status === 'visited' || existing.status === 'active') {
        existing.status = existing.attempts >= settings.maxAttemptsPerTask ? 'failed' : 'pending';
      }
    }
  }

  function pickTask() {
    for (const task of Object.values(state.tasks)) {
      if (task.status !== 'pending') continue;
      if (task.kind === 'quest' && !settings.punchcards) {
        task.status = 'skipped';
        log(`跳过拼图卡片（需要桌面应用）：${task.title}`);
        continue;
      }
      return task;
    }
    return null;
  }

  /* ================= 每日任务：页面处理 ================= */

  async function dismissConsent() {
    const direct = document.querySelector('#bnp_btn_accept, #bnp_btn_accept_all');
    if (direct && isVisible(direct)) {
      direct.click();
      await sleep(400);
      return;
    }
    for (const button of document.querySelectorAll('button')) {
      if (!isVisible(button)) continue;
      const text = (button.innerText || '').trim();
      if (text === '接受' || text === 'Accept') {
        button.click();
        await sleep(400);
        return;
      }
    }
  }

  async function humanScroll(times = 3) {
    for (let i = 0; i < times; i++) {
      window.scrollBy({ top: rand(220, 520), behavior: 'smooth' });
      await sleep(rand(350, 850));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(rand(150, 400));
  }

  function detectOfferKind() {
    if (/imagepuzzle|\/puzzle/i.test(location.href)) return 'puzzle';
    if (/quiz|dailyoffer|form=ML/i.test(location.href)) return 'quiz';
    if (document.querySelector(QUIZ_ROOT_SELECTOR)) return 'quiz';
    return 'page';
  }

  function findQuizRoot() {
    for (const node of document.querySelectorAll(QUIZ_ROOT_SELECTOR)) {
      if (isVisible(node) && (node.innerText || '').trim().length > 8) return node;
    }
    return null;
  }

  function pickVisible(root, selector, predicate) {
    for (const el of root.querySelectorAll(selector)) {
      if (!isVisible(el) || el.disabled) continue;
      if (predicate && !predicate(el)) continue;
      return el;
    }
    return null;
  }

  function isNextLike(el) {
    const text = (el.innerText || el.value || '').trim().toLowerCase();
    if (!text || text.length > 20) return false;
    return NEXT_TEXTS.some((candidate) => text === candidate || text.includes(candidate));
  }

  function clickEl(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch { /* 忽略滚动失败 */ }
    el.click();
  }

  function clickOption(el) {
    if (el.tagName === 'INPUT' && !isVisible(el)) {
      const label = el.closest('label') || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
      if (label) {
        clickEl(label);
        return;
      }
    }
    clickEl(el);
  }

  async function solveQuiz() {
    const root = await waitFor(findQuizRoot, 8000, 400);
    if (!root) {
      log('未检测到答题区域，按普通页面访问处理', 'warn');
      return;
    }
    log('检测到答题区域，尝试自动作答');
    const used = new WeakSet();
    let clicks = 0;
    for (let step = 0; step < 30; step++) {
      if (!root.isConnected) break;

      const option = pickVisible(root, OPTION_SELECTOR, (el) => !used.has(el) && (el.innerText || el.value || '').trim().length <= 120);
      if (option) {
        used.add(option);
        clickOption(option);
        clicks++;
        await sleep(rand(500, 1100));
        continue;
      }

      const next = pickVisible(root, ACTION_SELECTOR, isNextLike);
      if (next && !next.disabled) {
        clickEl(next);
        clicks++;
        await sleep(rand(1200, 2400));
        continue;
      }
      break;
    }
    log(`答题交互完成，共点击 ${clicks} 次`);
    await sleep(1500);
  }

  async function runTaskPage(task) {
    log(`访问任务：${task.title}`);
    await sleep(1200);
    await dismissConsent();
    await humanScroll(2);

    const kind = detectOfferKind();
    if (kind === 'puzzle') {
      log('图片拼图无法自动完成，已跳过（可手动完成后再次运行）', 'warn');
      await sleep(1500);
    } else if (kind === 'quiz' && settings.quizzes) {
      await solveQuiz();
    } else {
      await sleep(rand(2500, 4000));
      await humanScroll(1);
    }

    task.status = 'visited';
    task.completedAt = Date.now();
    persist();
    log('返回 Rewards 复核任务状态');
    return go(REWARDS_DASHBOARD, { delay: rand(800, 1600) });
  }

  /* ================= 搜索 ================= */

  const QUERY_SUBJECTS = [
    '国家公园', '手冲咖啡', '城市骑行', '零基础学吉他', '极光观测', '宋代瓷器',
    '量子计算', '深海生物', '老房子改造', '露营装备', '咖啡豆产地', '胶片摄影',
    '爵士乐历史', '云南旅行', '家庭健身', '笔记本电脑选购', '碳中和', '新能源汽车',
    '围棋入门', '纪录片推荐', '昆虫观察', '夜观星空', '地铁线路规划', '烘焙面包',
    '北欧设计', '古建筑保护', '野生动物摄影', '开源软件', '天文望远镜', '蔬菜种植',
    'city walk 路线', '马拉松训练', '睡眠科学', '书籍装帧', '海洋塑料污染',
    '小型犬饲养', '茶文化', '冷门博物馆', '民谣吉他谱', '空气净化器',
    'excel 技巧', '徒步路线', '葡萄酒入门', '雨林生态', '室内绿植',
    '钢琴练习方法', '古典音乐入门', '短视频剪辑', '方言研究', '瀑布景观'
  ];

  const QUERY_TEMPLATES = [
    '{s}', '{s} 推荐', '{s} 入门指南', '{s} 有什么技巧', '{s} 2026',
    '{s} 怎么选', '{s} 科普', '{s} 历史', '{s} 攻略', '{s} 最新消息',
    '{s} 常见问题', '{s} 对比', '{s} 教程', '{s} 经验分享'
  ];

  function nextQuery() {
    const history = new Set(state.queryHistory || []);
    for (let attempt = 0; attempt < 60; attempt++) {
      const subject = QUERY_SUBJECTS[rand(0, QUERY_SUBJECTS.length - 1)];
      const template = QUERY_TEMPLATES[rand(0, QUERY_TEMPLATES.length - 1)];
      const query = template.replace('{s}', subject).trim();
      if (history.has(query)) continue;
      history.add(query);
      state.queryHistory = [...history].slice(-400);
      return query;
    }
    return 'bing rewards ' + Date.now().toString(36);
  }

  function readPoints() {
    try {
      if (isRewardsPage()) {
        const match = (document.body.innerText || '').match(/可用积分\s*([\d,]+)/);
        if (match) return parsePoints(match[1]);
      }
      const node = document.querySelector('#rh_rwm, #id_rc');
      if (node) return parsePoints(node.textContent);
    } catch { /* 忽略解析异常 */ }
    return null;
  }

  function nextSearch() {
    const target = Math.max(0, Number(settings.desktopTarget) || 0);
    state.search.target = target;
    if (state.search.done >= target) {
      state.phase = 'search-review';
      persist();
      return go(REWARDS_DASHBOARD);
    }
    const query = nextQuery();
    if (state.search.pointsStart == null) state.search.pointsStart = readPoints();
    state.search.inFlight = true;
    state.search.lastQuery = query;
    state.phase = 'search';
    persist();
    log(`搜索 ${state.search.done + 1}/${target}：${query}`);
    return go('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&form=QBLH', { delay: rand(settings.minDelayMs, settings.maxDelayMs) });
  }

  async function onSearchResult() {
    state.search.inFlight = false;
    state.search.done += 1;

    // Bing 的结果页右上角有积分挂件，用它判断「这次搜索是否真的加分」。
    const points = readPoints();
    if (points != null) {
      if (state.search.pointsLast != null) {
        const gain = points - state.search.pointsLast;
        if (gain > 0) {
          state.search.stall = 0;
          log(`搜索加分 +${gain}，当前 ${points}`);
        } else {
          state.search.stall += 1;
        }
      }
      state.search.pointsLast = points;
      if (state.search.pointsStart == null) state.search.pointsStart = points;
    }
    persist();
    emit('change', { phase: state.phase, search: state.search });

    await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
    await humanScroll(1);

    const done = state.search.done >= state.search.target;
    const stalled = state.search.stall >= settings.stallAfter && state.search.done >= 8;
    if (done || stalled) {
      if (stalled) log(`连续 ${state.search.stall} 次搜索没有加分，提前收尾`, 'warn');
      state.phase = 'search-review';
      persist();
      return go(REWARDS_DASHBOARD, { delay: 800 });
    }
    return nextSearch();
  }

  // 回到 Rewards 后做最后一次确认，并记录本次积分变化。
  function reviewSearches() {
    const points = readPoints();
    if (points != null) {
      const gained = state.search.pointsStart == null ? 0 : points - state.search.pointsStart;
      log(`本次共搜索 ${state.search.done} 次，积分 ${state.search.pointsStart ?? '-'} → ${points}（+${Math.max(gained, 0)}）`);
    }
    state.phase = 'done';
    return finish('搜索额度已完成');
  }

  /* ================= 导航 / 阶段推进 ================= */

  function go(url, options = {}) {
    const delay = options.delay == null ? rand(900, 1800) : options.delay;
    state.navCount = (state.navCount || 0) + 1;
    persist();
    if (state.navCount > 120) return finish('跳转次数过多，已中止', 'error');
    return sleep(delay).then(() => {
      // 用户可能在等待期间点了停止，此时不再跳转。
      if (!state.running) return;
      location.assign(url);
    });
  }

  function detectBlock() {
    const text = (document.body.innerText || '').slice(0, 2000);
    return /验证你(是|不是)人类|请输入验证码|unusual traffic|verify you are human|are you a robot/i.test(text);
  }

  async function rewardsStep() {
    if (state.phase === 'search-review') return reviewSearches();
    if (state.phase === 'done') return finish('已完成');

    // 落在拼图详情页：只做访问，然后回首页继续。
    const activeQuest = Object.values(state.tasks).find((task) => task.status === 'active' && task.kind === 'quest');
    if (activeQuest && location.pathname.includes('/earn/quest/')) {
      await sleep(rand(2000, 3500));
      activeQuest.status = 'visited';
      activeQuest.completedAt = Date.now();
      persist();
      return go(REWARDS_DASHBOARD);
    }

    // 目标是 Rewards 站内的其他页面（非拼图）：同样只做一次访问。
    const activeInternal = Object.values(state.tasks).find((task) => task.status === 'active' && task.kind !== 'quest');
    if (activeInternal && location.pathname !== '/dashboard' && location.pathname !== '/earn') {
      await sleep(rand(1500, 3000));
      activeInternal.status = 'visited';
      activeInternal.completedAt = Date.now();
      persist();
      return go(REWARDS_DASHBOARD);
    }

    // React 卡片是懒加载的：首次为空时等一会儿再判断，避免把「还没渲染」当成「没有任务」。
    let cards = scanCards();
    if (!cards.length && state.phase !== 'search') {
      cards = await waitFor(() => {
        const list = scanCards();
        return list.length ? list : null;
      }, 8000, 500) || [];
    }
    if (cards.length) syncTasks(cards);
    else log('当前页面没有扫描到任务卡片', 'warn');

    if (settings.dailySet && state.phase !== 'search') {
      state.phase = 'daily';
      const surface = location.pathname.toLowerCase().startsWith('/earn') ? 'earn' : 'dashboard';
      state.scanned[surface] = true;
      persist();

      const task = pickTask();
      if (task) {
        task.status = 'active';
        task.startedAt = Date.now();
        task.attempts = (task.attempts || 0) + 1;
        persist();
        log(`开始每日任务（${task.attempts}/${settings.maxAttemptsPerTask}）：${task.title}`);
        return go(task.url, { delay: rand(1500, 3000) });
      }

      // dashboard 与 earn 的卡片集合并不完全相同，补齐另一个入口后再进入搜索阶段。
      const missingSurface = ['earn', 'dashboard'].find((key) => !state.scanned[key]);
      if (missingSurface) {
        log(`继续扫描 ${missingSurface} 页面以补全任务`);
        return go(missingSurface === 'earn' ? REWARDS_EARN : REWARDS_DASHBOARD, { delay: rand(1200, 2200) });
      }
      log('每日任务已处理完毕');
    }

    if (!settings.searchEnabled) return finish('搜索已在设置中关闭');

    state.phase = 'search';
    const target = Math.max(0, Number(settings.desktopTarget) || 0);
    if (target === 0) return finish('搜索目标为 0');
    if (state.search.done >= target) return finish('搜索额度已完成');
    return nextSearch();
  }

  async function bingStep() {
    if (detectBlock()) return finish('被 Bing 要求人机验证，已停止', 'error');

    const activeTask = Object.values(state.tasks).find((task) => task.status === 'active' && task.kind !== 'quest');
    if (activeTask) return runTaskPage(activeTask);

    if (state.search.inFlight && /\/search/.test(location.pathname)) {
      return onSearchResult();
    }

    log('当前页面不是预期目标，返回 Rewards');
    return go(REWARDS_DASHBOARD);
  }

  function finish(reason, level = 'info') {
    state.running = false;
    state.stopRequested = false;
    state.phase = level === 'error' ? 'error' : 'done';
    state.lastRunAt = Date.now();
    state.search.inFlight = false;
    log(`本次运行结束：${reason}`, level);
    persist();
    emit('finish', { reason });
    if (isBingPage()) {
      return sleep(1200).then(() => location.assign(REWARDS_DASHBOARD));
    }
    return Promise.resolve();
  }

  /* ================= 入口 ================= */

  async function boot() {
    if (!state.running) {
      if (settings.autoStart && isRewardsPage() && state.lastRunAt < startOfToday()) {
        return start({ silent: true });
      }
      return;
    }

    const runtime = Date.now() - state.startedAt;
    if (runtime > (Number(settings.maxRuntimeMin) || 45) * 60 * 1000) {
      return finish('超过单次运行时限', 'error');
    }

    // 每日任务可能把页面带到 msn.com / microsoft.com 等站点，
    // 只要当前页面就是正在处理的任务目标，就直接执行页面处理。
    const activeTask = Object.values(state.tasks).find((task) => task.status === 'active');
    if (activeTask && !isRewardsPage() && TASK_HOSTS.includes(location.hostname)) {
      return runTaskPage(activeTask);
    }

    try {
      if (isRewardsPage()) await rewardsStep();
      else if (isBingPage()) await bingStep();
      else finish('当前页面不受支持，已停止');
    } catch (error) {
      console.error('[MSR] 运行异常', error);
      finish('运行异常：' + (error && error.message ? error.message : error), 'error');
    }
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  /* ================= 对外 API（给未来的 UI 面板用） ================= */

  function start(options = {}) {
    if (options && typeof options === 'object') {
      const { silent, ...rest } = options;
      if (Object.keys(rest).length) configure(rest);
      if (!silent) log('启动自动化');
    }
    state = {
      ...createState(),
      queryHistory: state.queryHistory || [],
      log: state.log || [],
      stats: state.stats || createState().stats
    };
    state.running = true;
    state.stopRequested = false;
    state.phase = 'daily';
    state.startedAt = Date.now();
    state.date = todayKey();
    persist();

    if (!isRewardsPage()) {
      log('正在打开 Rewards 面板页');
      return sleep(600).then(() => location.assign(REWARDS_DASHBOARD));
    }
    return boot();
  }

  function stop(reason = '用户手动停止') {
    state.running = false;
    state.stopRequested = true;
    state.phase = 'paused';
    state.search.inFlight = false;
    log(reason, 'warn');
    persist();
    emit('stop');
  }

  function configure(patch) {
    if (!patch || typeof patch !== 'object') return { ...settings };
    settings = { ...settings, ...patch };
    writeRaw(SETTINGS_KEY, settings);
    emit('change', { settings });
    return { ...settings };
  }

  function api() {
    return {
      version: VERSION,
      start,
      stop,
      configure,
      getSettings: () => ({ ...settings }),
      getState: publicState,
      isRunning: () => Boolean(state.running),
      subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      }
    };
  }

  /* ================= UI 面板（Shadow DOM） ================= */

  const PANEL_KEY = 'msr:panel:v1';

  const PANEL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .capsule {
      --panel: rgba(15, 27, 46, .92);
      --panel-fallback: #11223b;
      --line: rgba(155, 184, 220, .16);
      --muted: #8ea4c1;
      --blue: #5eb9ff;
      --blue-strong: #2789e8;
      --green: #6de1b1;
      --amber: #ffc66d;
      --red: #ff8d93;
      --capsule-left: calc(100vw - 376px);
      --capsule-top: 72px;
      position: fixed;
      z-index: 2147483000;
      left: var(--capsule-left);
      top: var(--capsule-top);
      width: min(22rem, calc(100vw - 2rem));
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel-fallback);
      background: var(--panel);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .4), inset 0 1px rgba(255, 255, 255, .06);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      color: #edf5ff;
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    @supports not (backdrop-filter: blur(1px)) {
      .capsule { background: var(--panel-fallback); }
    }
    button { font: inherit; }
    .capsule-header { display: flex; align-items: center; gap: .7rem; min-height: 4.35rem; padding: .9rem 1rem; border-bottom: 1px solid var(--line); }
    .brand-mark { display: grid; flex: 0 0 auto; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 11px; color: #fff; background: linear-gradient(145deg, #39a9fb, #1e68bd); box-shadow: 0 5px 18px rgba(39, 137, 232, .35); }
    .brand-mark svg { width: 1.35rem; height: 1.35rem; }
    .brand-copy { min-width: 0; flex: 1; }
    .brand-copy strong, .brand-copy span { display: block; }
    .brand-copy strong { font-size: .88rem; }
    .brand-copy span { margin-top: .08rem; color: var(--muted); font-size: .7rem; }
    .icon-button, .drag-handle { display: grid; place-items: center; border: 0; color: var(--muted); background: transparent; cursor: pointer; }
    .icon-button { width: 2rem; height: 2rem; border-radius: 9px; }
    .icon-button:hover, .icon-button:focus-visible { color: #edf5ff; background: rgba(255, 255, 255, .08); }
    #collapseIcon { transition: transform .2s ease; }
    .is-collapsed #collapseIcon { transform: rotate(180deg); }
    .drag-handle { width: 2.25rem; height: 2.25rem; border-radius: 9px; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
    .drag-handle:hover, .drag-handle:focus-visible { background: rgba(255, 255, 255, .08); outline: none; }
    .drag-handle:active, .drag-handle.dragging { cursor: grabbing; }
    .drag-handle svg { width: 1rem; }
    .header-actions { display: flex; align-items: center; gap: .1rem; }
    :is(button, input):focus-visible { outline: 2px solid #5eb9ff; outline-offset: 3px; }
    .panel-body { display: block; }
    .is-collapsed .panel-body { display: none; }
    .summary { display: grid; grid-template-columns: 1fr 6.5rem; gap: 1rem; align-items: center; padding: 1.2rem 1rem .9rem; }
    .summary-copy small { color: var(--muted); font-size: .72rem; }
    .summary-copy strong { display: block; margin: .15rem 0 .15rem; font-size: 2.25rem; line-height: 1.08; letter-spacing: -.04em; }
    .summary-copy .delta { color: var(--muted); font-size: .73rem; }
    .ring-wrap { position: relative; display: grid; place-items: center; width: 6.5rem; height: 6.5rem; }
    .ring { width: 100%; height: 100%; transform: rotate(-90deg); }
    .ring-track, .ring-value { fill: none; stroke-width: 9; }
    .ring-track { stroke: rgba(126, 162, 202, .15); }
    .ring-value { stroke: var(--blue); stroke-linecap: round; transition: stroke-dashoffset .35s ease; }
    .ring-center { position: absolute; text-align: center; }
    .ring-center strong, .ring-center span { display: block; }
    .ring-center strong { font-size: 1.25rem; line-height: 1; }
    .ring-center span { margin-top: .22rem; color: var(--muted); font-size: .62rem; }
    .task-segments { padding: 0 1rem 1rem; }
    .task-segments-title { display: flex; justify-content: space-between; margin-bottom: .42rem; color: var(--muted); font-size: .68rem; }
    .segment-track { display: grid; grid-template-columns: repeat(6, 1fr); gap: .3rem; min-height: .35rem; }
    .segment-track span { height: .35rem; border-radius: 99px; background: rgba(137, 171, 211, .14); }
    .segment-track span.done { background: var(--blue); }
    .daily-activities { margin: 0 1rem 1rem; padding: .75rem .8rem; border: 1px solid var(--line); border-radius: 13px; background: rgba(255, 255, 255, .025); }
    .daily-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .45rem; }
    .daily-heading strong { font-size: .74rem; }
    .daily-heading span { color: var(--muted); font-size: .68rem; }
    .daily-pending { margin: 0; color: var(--muted); font-size: .7rem; line-height: 1.55; overflow-wrap: anywhere; }
    .daily-pending.has-items { color: var(--amber); }
    .daily-pending.is-complete { color: var(--green); }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: .55rem; padding: 0 1rem 1rem; }
    .stat { padding: .7rem .75rem; border: 1px solid var(--line); border-radius: 13px; background: rgba(255, 255, 255, .025); }
    .stat-label { display: flex; align-items: center; gap: .35rem; color: var(--muted); font-size: .68rem; }
    .stat-label svg { width: .75rem; color: var(--blue); }
    .stat strong { display: block; margin-top: .15rem; font-size: 1.05rem; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .72rem 1rem .8rem; border-top: 1px solid var(--line); background: rgba(2, 10, 21, .18); }
    .status { display: flex; align-items: center; gap: .45rem; min-width: 0; color: var(--muted); font-size: .7rem; }
    .status-dot { flex: 0 0 auto; width: .45rem; height: .45rem; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 .22rem rgba(109, 225, 177, .12); }
    .status-dot[data-status="paused"] { background: var(--amber); box-shadow: 0 0 0 .22rem rgba(255, 198, 109, .12); }
    .status-dot[data-status="refreshing"] { background: var(--blue); box-shadow: 0 0 0 .22rem rgba(94, 185, 255, .12); }
    .status-dot[data-status="error"] { background: var(--red); box-shadow: 0 0 0 .22rem rgba(255, 141, 147, .12); }
    .switch { position: relative; display: inline-flex; align-items: center; gap: .5rem; flex: 0 0 auto; color: var(--muted); font-size: .7rem; cursor: pointer; }
    .switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .track { width: 2.25rem; height: 1.25rem; padding: .16rem; border-radius: 99px; background: #30425b; transition: background .2s ease; }
    .track::after { content: ""; display: block; width: .93rem; height: .93rem; border-radius: 50%; background: #d9e6f5; box-shadow: 0 1px 3px rgba(0, 0, 0, .3); transition: transform .2s ease; }
    .switch input:checked + .track { background: var(--blue-strong); }
    .switch input:checked + .track::after { transform: translateX(1rem); }
    @keyframes msr-spin { to { transform: rotate(360deg); } }
    .icon-button.spinning svg { animation: msr-spin .6s linear; }
    @media (max-width: 620px) {
      .capsule { left: 1rem !important; top: auto !important; bottom: 1rem; width: calc(100vw - 2rem); border-radius: 18px; max-height: calc(100dvh - 2rem); overflow-y: auto; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
    }
  `;

  const PANEL_HTML = `
    <div class="capsule" id="capsule">
      <header class="capsule-header">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none"><path d="M7 5h8.2v8.2H7V5Zm9.8 0H25v8.2h-8.2V5ZM7 14.8h8.2V23H7v-8.2Zm9.8 0H25V23h-8.2v-8.2Z" fill="currentColor"/><path d="M7 24.8h8.2V27H7v-2.2Zm9.8 0H25V27h-8.2v-2.2Z" fill="currentColor" opacity=".72"/></svg>
        </span>
        <div class="brand-copy"><strong>Rewards Assistant</strong><span>今日积分概览</span></div>
        <div class="header-actions">
          <button class="drag-handle" id="dragHandle" type="button" aria-label="移动面板" title="拖拽移动面板">
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/></svg>
          </button>
          <button class="icon-button" id="collapseButton" type="button" aria-label="折叠面板" aria-expanded="true" title="折叠面板">
            <svg id="collapseIcon" viewBox="0 0 24 24" width="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button class="icon-button" id="refreshButton" type="button" aria-label="刷新积分状态" title="刷新积分状态">
            <svg viewBox="0 0 24 24" width="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4"/></svg>
          </button>
        </div>
      </header>
      <div class="panel-body">
        <section class="summary">
          <div class="summary-copy">
            <small>今日已获得积分</small>
            <strong id="todayPoints">--</strong>
            <span class="delta" id="deltaText">等待 Rewards 数据</span>
          </div>
          <div class="ring-wrap">
            <svg class="ring" viewBox="0 0 100 100" role="progressbar" aria-label="每日任务完成度" aria-valuemin="0" aria-valuemax="100">
              <circle class="ring-track" cx="50" cy="50" r="42"></circle>
              <circle class="ring-value" id="ringValue" cx="50" cy="50" r="42" pathLength="100"></circle>
            </svg>
            <div class="ring-center"><strong id="progressText">--</strong><span>每日任务</span></div>
          </div>
        </section>
        <section class="task-segments">
          <div class="task-segments-title"><span>任务分段</span><span id="taskCount">等待扫描</span></div>
          <div class="segment-track" id="segmentTrack"></div>
        </section>
        <section class="daily-activities">
          <div class="daily-heading"><strong>每日任务</strong><span id="dailyCount">等待扫描</span></div>
          <p class="daily-pending" id="dailyPending">正在读取此刻的 Rewards 页面数据。</p>
        </section>
        <section class="stats">
          <div class="stat">
            <span class="stat-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>连续天数</span>
            <strong id="streakDays">--</strong>
          </div>
          <div class="stat">
            <span class="stat-label"><svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2-2.2 6L4 10l5.8 2L12 18l2.2-6L20 10l-5.8-2L12 2Z"/></svg>总积分</span>
            <strong id="totalPoints">--</strong>
          </div>
        </section>
      </div>
      <footer class="footer">
        <div class="status"><i class="status-dot" id="statusDot"></i><span id="statusText">待机中</span></div>
        <label class="switch"><span>自动运行</span><input id="enabledInput" type="checkbox"><span class="track" aria-hidden="true"></span></label>
      </footer>
    </div>
  `;

  let panelRoot = null;
  let panelCapsule = null;
  let panelDrag = null;
  let statsSignature = '';

  function readPanelPrefs() {
    return readRaw(PANEL_KEY) || {};
  }

  function savePanelPrefs(patch) {
    writeRaw(PANEL_KEY, { ...readPanelPrefs(), ...patch });
  }

  function applyPanelPosition(left, top, persistValue) {
    if (!panelCapsule) return;
    const width = panelCapsule.offsetWidth || 352;
    const height = panelCapsule.offsetHeight || 240;
    const clampedLeft = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const clampedTop = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    panelCapsule.style.setProperty('--capsule-left', clampedLeft + 'px');
    panelCapsule.style.setProperty('--capsule-top', clampedTop + 'px');
    if (persistValue) savePanelPrefs({ position: { left: clampedLeft, top: clampedTop } });
  }

  function parseMatch(text, pattern) {
    const match = String(text).match(pattern);
    return match ? parsePoints(match[1]) : null;
  }

  // 读取面板数据：Rewards 页面解析文字，Bing 页面只更新总积分。
  function refreshStats(force = false) {
    let stats = { ...(state.stats || {}) };
    if (stats.date !== todayKey()) {
      stats = { date: todayKey(), at: 0, today: null, total: stats.total || null, streak: null, tasks: [] };
    }
    let changed = false;

    if (isRewardsPage()) {
      const text = document.body?.innerText || '';
      const today = parseMatch(text, /今日积分\s*([\d,]+)/);
      const total = parseMatch(text, /可用积分\s*([\d,]+)/);
      const streak = parseMatch(text, /每日连续(?:打卡|记录)\s*([\d,]+)\s*天/);
      if (today != null && today !== stats.today) { stats.today = today; changed = true; }
      if (total != null && total !== stats.total) { stats.total = total; changed = true; }
      if (streak != null && streak !== stats.streak) { stats.streak = streak; changed = true; }

      const cards = scanCards();
      if (cards.length) {
        const merged = new Map();
        for (const task of [...(stats.tasks || []), ...cards]) {
          const key = String(task.title).trim().toLowerCase();
          const previous = merged.get(key);
          merged.set(key, previous
            ? { ...previous, completed: previous.completed || task.completed }
            : { title: task.title, url: task.url, kind: task.kind, completed: task.completed });
        }
        const tasks = [...merged.values()];
        const signature = tasks.map((task) => task.title + '|' + task.completed).join(';');
        if (signature !== statsSignature) {
          statsSignature = signature;
          stats.tasks = tasks;
          changed = true;
        }
      }
    } else if (isBingPage()) {
      const points = readPoints();
      if (points != null && points !== stats.total) { stats.total = points; changed = true; }
    }

    if (changed || force) {
      stats.at = Date.now();
      state.stats = stats;
      persist();
      renderPanel();
      emit('stats', stats);
    }
  }

  function panelStatus() {
    if (state.phase === 'error') return { key: 'error', text: '运行出错' };
    if (state.running) {
      if (state.phase === 'daily') return { key: 'refreshing', text: '正在处理每日任务' };
      if (state.phase === 'search') {
        return { key: 'refreshing', text: '自动搜索 ' + state.search.done + '/' + (state.search.target || settings.desktopTarget) };
      }
      if (state.phase === 'search-review') return { key: 'refreshing', text: '复核积分' };
      return { key: 'refreshing', text: '运行中' };
    }
    if (state.phase === 'done') return { key: 'ready', text: '今日已完成' };
    if (state.phase === 'paused') return { key: 'paused', text: '已暂停' };
    return { key: 'ready', text: '待机中' };
  }

  function renderPanel() {
    if (!panelRoot) return;
    const $ = (selector) => panelRoot.querySelector(selector);
    const stats = state.stats || {};
    const tasks = Array.isArray(stats.tasks) ? stats.tasks : [];
    const total = tasks.length;
    const completed = tasks.filter((task) => task.completed).length;
    const percent = total ? Math.round((completed / total) * 100) : 0;

    $('#todayPoints').textContent = stats.today != null ? '+' + stats.today : '--';
    $('#totalPoints').textContent = stats.total != null ? Number(stats.total).toLocaleString('zh-CN') : '--';
    $('#streakDays').textContent = stats.streak != null ? stats.streak + ' 天' : '--';
    $('#deltaText').textContent = stats.at
      ? '更新于 ' + new Date(stats.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '等待 Rewards 数据';

    const ringValue = $('#ringValue');
    ringValue.style.strokeDasharray = '100';
    ringValue.style.strokeDashoffset = String(100 - percent);
    $('#progressText').textContent = total ? percent + '%' : '--';

    $('#taskCount').textContent = total ? completed + ' / ' + total : '等待扫描';
    const track = $('#segmentTrack');
    track.style.gridTemplateColumns = 'repeat(' + Math.max(total, 1) + ', 1fr)';
    track.innerHTML = tasks.map((task) => '<span class="' + (task.completed ? 'done' : '') + '"></span>').join('');

    const pending = tasks.filter((task) => !task.completed).map((task) => task.title);
    const pendingNode = $('#dailyPending');
    $('#dailyCount').textContent = total ? '每日任务 ' + completed + '/' + total : '等待扫描';
    pendingNode.textContent = pending.length
      ? '未完成：' + pending.join('、')
      : (total ? '今日任务已全部完成' : '暂未检测到每日任务卡片');
    pendingNode.classList.toggle('has-items', pending.length > 0);
    pendingNode.classList.toggle('is-complete', total > 0 && pending.length === 0);

    const status = panelStatus();
    $('#statusText').textContent = status.text;
    $('#statusDot').dataset.status = status.key;
    $('#enabledInput').checked = Boolean(state.running);
    const lastLog = (state.log || [])[state.log.length - 1];
    panelCapsule.title = lastLog ? lastLog.message : '';
  }

  function bindPanelEvents() {
    const $ = (selector) => panelRoot.querySelector(selector);
    const handle = $('#dragHandle');
    const capsule = panelCapsule;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = capsule.getBoundingClientRect();
      panelDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!panelDrag || panelDrag.id !== event.pointerId) return;
      const dx = event.clientX - panelDrag.x;
      const dy = event.clientY - panelDrag.y;
      if (!panelDrag.moved && Math.hypot(dx, dy) < 3) return;
      panelDrag.moved = true;
      handle.classList.add('dragging');
      applyPanelPosition(panelDrag.left + dx, panelDrag.top + dy, false);
    });
    const endDrag = () => {
      if (!panelDrag) return;
      const moved = panelDrag.moved;
      panelDrag = null;
      handle.classList.remove('dragging');
      if (moved) {
        const rect = capsule.getBoundingClientRect();
        savePanelPrefs({ position: { left: rect.left, top: rect.top } });
      }
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);

    $('#collapseButton').addEventListener('click', () => {
      const collapsed = !capsule.classList.contains('is-collapsed');
      capsule.classList.toggle('is-collapsed', collapsed);
      savePanelPrefs({ collapsed });
      const button = $('#collapseButton');
      button.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? '展开面板' : '折叠面板';
      button.setAttribute('aria-label', label);
      button.title = label;
    });

    $('#refreshButton').addEventListener('click', () => {
      const button = $('#refreshButton');
      button.classList.add('spinning');
      refreshStats(true);
      setTimeout(() => button.classList.remove('spinning'), 650);
    });

    $('#enabledInput').addEventListener('change', (event) => {
      if (event.target.checked) start();
      else stop();
      renderPanel();
    });

    window.addEventListener('resize', () => {
      if (!panelCapsule || panelCapsule.classList.contains('is-collapsed')) return;
      const rect = panelCapsule.getBoundingClientRect();
      applyPanelPosition(rect.left, rect.top, false);
    });
  }

  function mountPanel() {
    if (panelRoot || document.getElementById('msr-capsule-host')) return;
    const host = document.createElement('div');
    host.id = 'msr-capsule-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.body.appendChild(host);

    panelRoot = shadow;
    panelCapsule = shadow.querySelector('.capsule');

    const prefs = readPanelPrefs();
    if (prefs.collapsed) {
      panelCapsule.classList.add('is-collapsed');
      const button = shadow.querySelector('#collapseButton');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', '展开面板');
    }
    const position = prefs.position;
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
      applyPanelPosition(position.left, position.top, false);
    } else {
      applyPanelPosition(window.innerWidth - 376, 72, false);
    }

    bindPanelEvents();
    renderPanel();
    refreshStats();

    // SPA 路由（Rewards 站内点击导航）不会重新加载脚本，靠轮询补充刷新。
    setInterval(() => {
      refreshStats();
      renderPanel();
    }, 5000);
  }

  window.MSRewards = api();

  if (settings.showPanel !== false) {
    if (document.body) mountPanel();
    else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
  }

  // 也可以直接用 ?msr=start 或 #msr-start 从地址栏触发一次运行。
  function startFromUrl() {
    try {
      const params = new URLSearchParams(location.search);
      const flagged = params.get('msr') === 'start' || location.hash === '#msr-start';
      if (!flagged) return false;
      params.delete('msr');
      const clean = location.pathname + (params.toString() ? '?' + params.toString() : '');
      history.replaceState(null, '', clean);
      start();
      return true;
    } catch {
      return false;
    }
  }

  // 让 UI 能够挂载：先派发 ready，再由 boot 继续自动化。
  try {
    window.dispatchEvent(new CustomEvent('msr:ready', { detail: { version: VERSION, api: window.MSRewards } }));
  } catch { /* 忽略 */ }

  // start() 内部会自行接管流程，避免与 boot() 重复推进。
  if (!startFromUrl()) boot();
})();
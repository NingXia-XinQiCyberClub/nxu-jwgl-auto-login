/**
 * 弹出面板逻辑。
 *
 * 只做三件事：读状态 → 渲染 → 把用户动作转成消息。
 * 所有跨上下文调用都走 shared 的 api / send，避免各自拼消息类型。
 */

import { api } from '../shared/messaging.js';
import { normalizeOrigin, deepMerge, onStorageChanged } from '../shared/storage.js';
import { CONTENT_MSG, STATUS, DEFAULT_SETTINGS, DEFAULT_STATE } from '../shared/constants.js';

/** 面板上的日志条数：popup 高度有限，只留最近的几条 */
const LOG_LIMIT = 4;
/** 错误横幅停留时间 */
const BANNER_TTL_MS = 3000;
/** 超时兜底：tabs.sendMessage 在页面无响应时可能永久挂起 */
const TAB_MESSAGE_TIMEOUT_MS = 5000;

const STATUS_LABELS = {
  [STATUS.IDLE]: '待命',
  [STATUS.RUNNING]: '正在登录',
  [STATUS.NEED_INPUT]: '需要处理',
  [STATUS.SUCCESS]: '登录成功',
  [STATUS.FAILED]: '登录失败',
};

/** status → 圆点/文字配色 */
const STATUS_TONES = {
  [STATUS.IDLE]: 'idle',
  [STATUS.RUNNING]: 'running',
  [STATUS.NEED_INPUT]: 'warn',
  [STATUS.SUCCESS]: 'success',
  [STATUS.FAILED]: 'error',
};

const els = {
  enabled: document.getElementById('enabled-toggle'),
  banner: document.getElementById('banner'),
  dot: document.getElementById('status-dot'),
  title: document.getElementById('status-title'),
  attempts: document.getElementById('status-attempts'),
  message: document.getElementById('status-message'),
  lastSuccess: document.getElementById('last-success'),
  pageHint: document.getElementById('page-hint'),
  modeHint: document.getElementById('mode-hint'),
  primary: document.getElementById('primary-btn'),
  captchaCard: document.getElementById('captcha-card'),
  captchaImg: document.getElementById('captcha-img'),
  captchaForm: document.getElementById('captcha-form'),
  captchaInput: document.getElementById('captcha-input'),
  captchaSubmit: document.getElementById('captcha-submit'),
  logList: document.getElementById('log-list'),
  logEmpty: document.getElementById('log-empty'),
  openOptions: document.getElementById('open-options'),
  clearState: document.getElementById('clear-state'),
};

/** 内存快照：storage.onChanged 只给变化的那部分，渲染需要完整视图 */
const view = {
  settings: null,
  state: null,
  /** 当前活动标签页；null 表示查不到 */
  tab: null,
  /** 当前标签页是否是教务系统（含 serverUrls 里的备用地址） */
  onJwglPage: false,
  /** 正在跑一个面板级操作，避免重复点击 */
  busy: false,
};

let bannerTimer = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function formatClock(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 相对时间：popup 生命周期短，不在打开期间轮询，够用了 */
function formatRelative(timestamp) {
  const at = Number(timestamp) || 0;
  if (at <= 0) return '暂无';
  const diff = Date.now() - at;
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(at);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function errorText(error) {
  return String(error?.message ?? error ?? '未知错误');
}

/**
 * 把错误显示在面板顶部；3 秒后自动消失。
 * kind=info 用于「正在登录中」这类不算错误但需要告知的情况。
 */
function showBanner(text, kind = 'error') {
  if (!els.banner) return;
  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  els.banner.textContent = String(text ?? '');
  els.banner.dataset.kind = kind;
  els.banner.hidden = false;
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    hideBanner();
  }, BANNER_TTL_MS);
}

function hideBanner() {
  if (!els.banner) return;
  els.banner.hidden = true;
  els.banner.textContent = '';
}

function setBusy(busy) {
  view.busy = busy;
  if (els.primary) {
    els.primary.disabled = busy;
    els.primary.textContent = busy ? '处理中…' : primaryLabel();
  }
  if (els.enabled) els.enabled.disabled = busy;
  if (els.clearState) els.clearState.disabled = busy;
  if (els.captchaSubmit) els.captchaSubmit.disabled = busy;
  if (els.captchaInput) els.captchaInput.disabled = busy;
}

// ---------------------------------------------------------------------------
// 标签页判定
// ---------------------------------------------------------------------------
function isJwglUrl(rawUrl, serverUrls) {
  if (!rawUrl) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  // 默认域名永远算教务系统，即使 serverUrls 被用户改坏
  if (url.hostname === 'jwgl.nxu.edu.cn') return true;
  const origins = (Array.isArray(serverUrls) ? serverUrls : []).map(normalizeOrigin).filter(Boolean);
  return origins.includes(url.origin);
}

/** 带超时的 tabs.sendMessage，避免页面无响应时按钮一直「处理中…」 */
function sendToTab(tabId, type, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('页面没有响应，请刷新教务系统页面后重试'));
    }, TAB_MESSAGE_TIMEOUT_MS);

    const fail = (message, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new Error(message);
      if (code) error.code = code;
      reject(error);
    };

    let request;
    try {
      request = chrome.tabs.sendMessage(tabId, { type, payload });
    } catch (error) {
      fail(`无法与页面通信：${errorText(error)}`, 'no-receiver');
      return;
    }
    Promise.resolve(request)
      .then((response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!response || response.ok !== true) {
          reject(new Error(response?.error || '页面未正常响应'));
          return;
        }
        resolve(response.data);
      })
      .catch((error) => fail(`无法与页面通信：${errorText(error)}`, 'no-receiver'));
  });
}

/**
 * 判断当前标签页是否教务系统。
 *
 * 没申请 tabs 权限时 tab.url 可能为空，此时向页面发 content/get-page-info 试探：
 * 能应答就说明 content script 在（等价于这是教务系统页面）。
 * 两步都失败只是「不确定」，不该让面板报错，后续按普通页面处理。
 */
async function resolveActiveTab(serverUrls) {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = Array.isArray(tabs) ? tabs[0] ?? null : null;
  } catch {
    tab = null;
  }

  if (!tab) return { tab: null, onJwglPage: false };

  const knownUrl = tab.url || tab.pendingUrl || '';
  if (knownUrl) {
    return { tab, onJwglPage: isJwglUrl(knownUrl, serverUrls) };
  }

  // url 拿不到：用页面探测代替。失败一律视为「不是教务系统」。
  if (Number.isInteger(tab.id)) {
    try {
      const info = await sendToTab(tab.id, CONTENT_MSG.GET_PAGE_INFO);
      if (info && typeof info === 'object') return { tab, onJwglPage: true };
    } catch {
      /* 页面里没有脚本，按非教务系统处理 */
    }
  }
  return { tab, onJwglPage: false };
}

function primaryLabel() {
  if (view.busy) return '处理中…';
  // 静默模式下按钮与「是否有教务页面」无关：它在后台请求，不需要任何页面
  if (view.settings?.silent?.enabled) {
    return view.state?.silentRunning ? '停止静默登录' : '开始静默登录';
  }
  return view.onJwglPage ? '立即登录' : '打开教务系统';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render() {
  const state = view.state ?? DEFAULT_STATE;
  const status = STATUS_TONES[state.status] ? state.status : STATUS.IDLE;
  const tone = STATUS_TONES[status] || 'idle';

  if (els.dot) els.dot.dataset.tone = tone;
  if (els.title) {
    els.title.textContent = STATUS_LABELS[status] || '待命';
    els.title.dataset.tone = tone;
  }

  const max = Number(state.maxAttempts) || 0;
  const attempts = Number(state.attempts) || 0;
  if (els.attempts) {
    const showProgress = max > 0 && (status === STATUS.RUNNING || attempts > 0);
    els.attempts.hidden = !showProgress;
    // 运行中 attempts 记录的是「已完成的次数」，当前进行的是下一次，和页面悬浮面板口径一致
    const current = status === STATUS.RUNNING ? Math.min(attempts + 1, max) : Math.min(attempts, max);
    els.attempts.textContent = showProgress ? `尝试 ${current}/${max}` : '';
  }

  if (els.message) els.message.textContent = state.message || '尚未运行';
  if (els.lastSuccess) els.lastSuccess.textContent = formatRelative(state.lastSuccessAt);

  if (els.pageHint) els.pageHint.hidden = view.onJwglPage || Boolean(view.settings?.silent?.enabled);
  if (els.primary) {
    els.primary.textContent = primaryLabel();
    els.primary.dataset.action = view.settings?.silent?.enabled
      ? view.state?.silentRunning
        ? 'silent-stop'
        : 'silent-start'
      : view.onJwglPage
        ? 'run'
        : 'open';
  }
  renderModeHint(state);

  if (els.enabled) {
    els.enabled.checked = view.settings ? view.settings.enabled !== false : true;
  }

  renderCaptcha(state, status);
  renderLogs(state);
}

function renderModeHint(state) {
  if (!els.modeHint) return;
  const silent = view.settings?.silent;
  if (!silent?.enabled) {
    els.modeHint.hidden = true;
    els.modeHint.textContent = '';
    return;
  }
  const provider = view.settings?.ocr?.provider;
  if (provider === 'manual') {
    els.modeHint.hidden = false;
    els.modeHint.dataset.tone = 'warn';
    els.modeHint.textContent = '静默模式需要 OCR：请到设置里选择百度 OCR 或自建识别服务';
    return;
  }
  els.modeHint.hidden = false;
  delete els.modeHint.dataset.tone;
  const entry = view.settings?.silent?.entryUrl || `${(view.settings?.serverUrls ?? [])[0] ?? ''}/index.action`;
  const total = Number(silent.maxAttempts) || 0;
  const done = Number(state?.silentRequests) || 0;
  els.modeHint.textContent = `后台请求模式${total ? ` · ${done}/${total} 次` : ''} · 入口 ${entry}`;
}

function renderCaptcha(state, status) {
  if (!els.captchaCard) return;
  const hasImage = typeof state.pendingCaptcha === 'string' && state.pendingCaptcha.startsWith('data:image/');
  // 页面在「跑」或「等人工」时都可能挂着验证码，两者都允许从面板提交
  const waiting = status === STATUS.RUNNING || status === STATUS.NEED_INPUT;
  const visible = hasImage && waiting;

  els.captchaCard.hidden = !visible;
  if (!visible) return;

  if (els.captchaImg && els.captchaImg.getAttribute('src') !== state.pendingCaptcha) {
    els.captchaImg.src = state.pendingCaptcha;
    // 换了新图 = 新的一次尝试，清掉上一次的输入，避免误提交
    if (els.captchaInput) els.captchaInput.value = '';
    // 只在图片变化时抢焦点，避免每次 storage 变化都打断输入
    if (document.activeElement !== els.captchaInput) {
      els.captchaInput?.focus({ preventScroll: true });
    }
  }
}

function renderLogs(state) {
  if (!els.logList) return;
  const logs = Array.isArray(state.logs) ? state.logs.slice(-LOG_LIMIT) : [];
  els.logList.replaceChildren();

  for (const entry of logs) {
    if (!entry || typeof entry.message !== 'string') continue;
    const row = document.createElement('li');
    row.className = 'log-row';
    row.dataset.level = entry.level === 'error' || entry.level === 'warn' || entry.level === 'success' ? entry.level : 'info';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatClock(entry.at);

    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = entry.message;

    row.append(time, text);
    els.logList.appendChild(row);
  }

  if (els.logEmpty) els.logEmpty.hidden = logs.length > 0;
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------
async function loadAll() {
  const [settings, state] = await Promise.all([api.getSettings(), api.getState()]);
  view.settings = deepMerge(DEFAULT_SETTINGS, settings ?? {});
  view.state = deepMerge(DEFAULT_STATE, state ?? {});

  // 地址列表决定「是不是教务系统页面」，所以要在拿到设置之后再探测标签页
  const resolved = await resolveActiveTab(view.settings.serverUrls);
  view.tab = resolved.tab;
  view.onJwglPage = resolved.onJwglPage;

  render();
}

/** storage 变化时的轻量更新：不重新探测标签页 */
function applyStorageChange(changes) {
  if (changes.settings) {
    const previousServerUrls = view.settings?.serverUrls;
    view.settings = deepMerge(DEFAULT_SETTINGS, changes.settings ?? {});
    const urlsChanged = JSON.stringify(previousServerUrls) !== JSON.stringify(view.settings.serverUrls);
    if (urlsChanged) {
      // 地址列表变了，「是否教务系统」的判定跟着变；失败时退回「打开教务系统」即可
      void resolveActiveTab(view.settings.serverUrls)
        .then((resolved) => {
          view.tab = resolved.tab;
          view.onJwglPage = resolved.onJwglPage;
          render();
        })
        .catch((error) => {
          console.warn('[jwgl] 重新判定当前标签页失败', error);
          view.onJwglPage = false;
          render();
        });
    }
  }
  if (changes.state) {
    view.state = deepMerge(DEFAULT_STATE, changes.state ?? {});
  }
  render();
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------
async function toggleEnabled() {
  if (!els.enabled || view.busy) return;
  const next = els.enabled.checked;
  setBusy(true);
  try {
    const settings = await api.patchSettings({ enabled: next });
    view.settings = deepMerge(DEFAULT_SETTINGS, settings ?? {});
    render();
  } catch (error) {
    // 保存失败要把开关拨回去，否则面板显示的和实际存储不一致
    els.enabled.checked = !next;
    showBanner(`保存失败：${errorText(error)}`);
  } finally {
    setBusy(false);
  }
}

async function handlePrimary() {
  if (view.busy) return;

  // 静默模式是后台请求循环，和当前页是不是教务系统无关
  if (view.settings?.silent?.enabled) {
    await handleSilentPrimary();
    return;
  }

  setBusy(true);
  try {
    if (!view.onJwglPage) {
      const serverUrls = view.settings?.serverUrls ?? DEFAULT_SETTINGS.serverUrls;
      const target = normalizeOrigin(serverUrls[0]) || DEFAULT_SETTINGS.serverUrls[0];
      await chrome.tabs.create({ url: target });
      window.close();
      return;
    }

    if (!view.tab || !Number.isInteger(view.tab.id)) {
      // 判定和点击之间页面可能已关闭，重新探一次比直接报错友好
      const resolved = await resolveActiveTab(view.settings?.serverUrls ?? []);
      view.tab = resolved.tab;
      view.onJwglPage = resolved.onJwglPage;
      if (!view.onJwglPage) {
        render();
        showBanner('当前标签页已不是教务系统页面，请重新打开', 'info');
        return;
      }
    }

    let result;
    try {
      result = await sendToTab(view.tab.id, CONTENT_MSG.RUN);
    } catch (error) {
      // 只有「页面里没有脚本」才值得让后台补注入重试。
      // 若页面已经应答但返回了错误（比如正在登录中），再注入只会重复触发。
      if (error?.code !== 'no-receiver') throw error;
      result = await api.runLoginInTab(view.tab.id);
    }
    if (result && result.started === false) {
      showBanner(result.reason || '正在登录中，请稍候', 'info');
    }
    // content script 会立刻写 storage，onChanged 自然带回最新状态
    const state = await api.getState();
    view.state = deepMerge(DEFAULT_STATE, state ?? {});
    render();
  } catch (error) {
    showBanner(errorText(error));
  } finally {
    setBusy(false);
  }
}

/**
 * 静默模式的主按钮：启动 / 停止后台请求循环。
 * 不依赖当前标签页，因此这里不查 tab，直接调后台。
 */
async function handleSilentPrimary() {
  if (view.busy) return;
  setBusy(true);
  try {
    if (view.state?.silentRunning) {
      await api.silentStop();
      showBanner('已请求停止，当前这次请求结束后生效', 'info');
    } else {
      const result = await api.silentStart();
      showBanner(`已开始后台请求（最多 ${result?.maxAttempts ?? '?'} 次）`, 'info');
    }
    const state = await api.getState();
    view.state = deepMerge(DEFAULT_STATE, state ?? {});
    render();
  } catch (error) {
    showBanner(errorText(error));
  } finally {
    setBusy(false);
  }
}

async function handleCaptchaSubmit(event) {  event.preventDefault();
  if (view.busy) return;
  const text = String(els.captchaInput?.value ?? '').replace(/\s+/g, '');
  if (!text) {
    showBanner('请输入验证码后再提交');
    els.captchaInput?.focus();
    return;
  }
  if (!view.tab || !Number.isInteger(view.tab.id)) {
    showBanner('请先切换到教务系统标签页再提交验证码');
    return;
  }

  setBusy(true);
  try {
    const data = await sendToTab(view.tab.id, CONTENT_MSG.SUBMIT_CAPTCHA, { text });
    if (data && data.accepted === false) {
      showBanner('页面没有接受这次输入，请刷新页面后重试');
      return;
    }
    if (els.captchaInput) els.captchaInput.value = '';
    hideBanner();
  } catch (error) {
    showBanner(errorText(error));
  } finally {
    setBusy(false);
  }
}

async function handleClearState() {
  if (view.busy) return;
  const confirmed = window.confirm('确定清空运行状态和日志吗？设置不会被修改。');
  if (!confirmed) return;

  setBusy(true);
  try {
    const state = await api.patchState({
      status: STATUS.IDLE,
      message: '状态已清空',
      attempts: 0,
      maxAttempts: 0,
      lastSuccessAt: 0,
      lastRunAt: 0,
      lastError: '',
      pendingCaptcha: '',
      pendingCaptchaAt: 0,
      logs: [],
    });
    view.state = deepMerge(DEFAULT_STATE, state ?? {});
    render();
  } catch (error) {
    showBanner(`清空失败：${errorText(error)}`);
  } finally {
    setBusy(false);
  }
}

function openOptionsPage() {
  try {
    const result = chrome.runtime.openOptionsPage();
    if (result && typeof result.catch === 'function') {
      result.catch((error) => showBanner(`无法打开设置页：${errorText(error)}`));
    }
  } catch (error) {
    showBanner(`无法打开设置页：${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 绑定与启动
// ---------------------------------------------------------------------------
function bindEvents() {
  els.enabled?.addEventListener('change', () => void toggleEnabled());
  els.primary?.addEventListener('click', () => void handlePrimary());
  els.captchaForm?.addEventListener('submit', (event) => void handleCaptchaSubmit(event));
  els.openOptions?.addEventListener('click', openOptionsPage);
  els.clearState?.addEventListener('click', () => void handleClearState());
}

async function init() {
  bindEvents();
  try {
    await loadAll();
  } catch (error) {
    showBanner(`读取状态失败：${errorText(error)}`);
    render();
  }

  onStorageChanged((changes) => applyStorageChange(changes));
}

void init();

/**
 * 教务系统自动登录 —— 页面侧登录状态机 + 悬浮面板（经典脚本，无 ESM）。
 *
 * 设计要点：
 * 1) 不再自己发 POST，而是在页面里填表、提交，复用浏览器自身的 JSESSIONID；
 * 2) DOM 细节全部走 dom-adapter.js（globalThis.JWGLDom），本文件只负责流程与 UI；
 * 3) 所有读写都通过 chrome.runtime.sendMessage，信封 { type, payload }：
 *    成功 { ok: true, data }，失败 { ok: false, error }；
 * 4) UI 全部放在 Shadow DOM 里，宿主 id 为 jwgl-auto-login-root；
 *    content.css 只负责宿主的定位与隔离，卡片内部样式在下方 OVERLAY_CSS 里。
 */
(() => {
  'use strict';

  // 幂等：background 可能重复注入，第二次直接退出。
  if (globalThis.__JWGL_CONTENT_LOADED__) return;
  globalThis.__JWGL_CONTENT_LOADED__ = true;

  // ---------------------------------------------------------------------------
  // 常量（与 shared/constants.js 的 MSG / CONTENT_MSG 值保持一致，禁止改动契约）
  // ---------------------------------------------------------------------------
  const MSG = {
    GET_SETTINGS: 'settings/get',
    GET_STATE: 'state/get',
    PATCH_STATE: 'state/patch',
    LOG: 'log/append',
    OCR_SOLVE: 'action/ocr-solve',
    FETCH_CAPTCHA: 'action/fetch-captcha',
    NOTIFY: 'action/notify',
  };
  const CONTENT_MSG = {
    RUN: 'content/run',
    SUBMIT_CAPTCHA: 'content/submit-captcha',
    CANCEL: 'content/cancel',
    GET_PAGE_INFO: 'content/get-page-info',
    BROADCAST_SETTINGS_CHANGED: 'broadcast/settings-changed',
  };

  const HOST_ID = 'jwgl-auto-login-root';
  /** 面板日志上限：默认显示 5 条，展开后最多 20 条（state.logs 由后台保留更多） */
  const MAX_LOG_BUFFER = 20;
  const MAX_CAPTCHA_DATA_URL_LENGTH = 200000;
  const LOGIN_RESULT_TIMEOUT_MS = 15000;
  const MANUAL_SUBMIT_TIMEOUT_MS = 60000;

  const Dom = globalThis.JWGLDom;

  /**
   * 本地兜底设置：只用于 background 尚未就绪时保证 UI 可用。
   * 结构必须与 shared/constants.js 的 DEFAULT_SETTINGS 保持一致。
   */
  const FALLBACK_SETTINGS = {
    enabled: true,
    autoSubmit: true,
    credentials: { username: '', password: '' },
    captcha: { mode: 'auto', maxAttempts: 5, delayMs: 1200, solveTimeoutMs: 120000, length: 0 },
    ocr: { provider: 'manual' },
    ui: { showOverlay: true, notifyOnSuccess: true, autoDismissMs: 8000 },
    advanced: { startDelayMs: 400, debug: false },
  };

  const STATUS_LABEL = {
    idle: '待命中',
    running: '正在登录',
    'need-input': '需要设置',
    success: '登录成功',
    failed: '登录失败',
  };
  const STATUS_TONE = {
    idle: 'idle',
    running: 'running',
    'need-input': 'warn',
    success: 'success',
    failed: 'error',
  };

  // ---------------------------------------------------------------------------
  // 运行时状态（内存为准，面板即时反映；每次变化异步落盘）
  // ---------------------------------------------------------------------------
  const runtime = {
    settings: null,
    status: 'idle',
    message: '待命中',
    attempts: 0,
    maxAttempts: 0,
    lastSuccessAt: 0,
    lastError: '',
    lastRunAt: 0,
    /** 上次落盘的进度快照，用于整页刷新后接着数次数 */
    persisted: { status: 'idle', attempts: 0, maxAttempts: 0 },
    logs: [],
    logsExpanded: false,
    running: false,
    cancelled: false,
    dismissed: false,
    /** 面板上是否有需要展示的结果（成功/失败卡片），避免普通页面弹面板 */
    resultVisible: false,
    captchaOpen: false,
    captchaExpected: 0,
  };

  const overlay = { host: null, shadow: null, els: null };
  /** 等待人工输入的 Promise（同一时刻最多一个） */
  let captchaWaiter = null;
  let autoStartTimer = null;
  let autoDismissTimer = null;

  // ---------------------------------------------------------------------------
  // 与 background 通信
  // ---------------------------------------------------------------------------
  async function send(type, payload) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type, payload });
    } catch (error) {
      throw new Error(`消息通道不可用（${type}）：${error?.message ?? error}`);
    }
    if (!res || res.ok !== true) throw new Error(res?.error || `后台未正常响应（${type}）`);
    return res.data;
  }

  /** 日志/状态这类「尽力而为」的消息，失败不能影响主流程 */
  function trySend(type, payload) {
    return send(type, payload).catch((error) => {
      debug(`消息发送失败 ${type}`, error);
      return null;
    });
  }

  /**
   * 提交表单前把「本次尝试进度」落盘。
   *
   * 为什么必须单独做：提交登录表单通常触发整页跳转/重渲染，本文档的 JS 会被销毁，
   * 所有 await 之后的代码都不会执行。如果只在「等结果」之后才 patchState，
   * 那么刷新后 state.attempts 仍是 0，resume 逻辑就永远从 1 重新开始 ——
   * 验证码一直错时表现为无限重试，而不是按 maxAttempts 停下。
   *
   * 因此这里：① 先同步更新本地 runtime.persisted；② 立刻发消息（不等返回值）。
   * service worker 收到消息后会独立完成 storage 写入，不受页面销毁影响。
   */
  function persistAttemptProgress(attempt, maxAttempts) {
    runtime.persisted = {
      status: 'running',
      attempts: Number(attempt) || 0,
      maxAttempts: Number(maxAttempts) || Number(runtime.maxAttempts) || 0,
    };
    // 不用 await：页面此刻可能正在导航，等待会让写入被中途丢弃
    void trySend(MSG.PATCH_STATE, {
      status: 'running',
      attempts: Number(attempt) || 0,
      maxAttempts: runtime.persisted.maxAttempts,
      origin: location.origin,
      // 用「发出时刻」而不是到达时刻：这条消息很可能晚于新页面的 success 才送达
      stateAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------
  function debug(...args) {
    if (runtime.settings?.advanced?.debug) console.debug('[jwgl]', ...args);
  }

  function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  function messageOf(error) {
    return String(error?.message ?? error ?? '未知原因');
  }

  function makeCancelled(message = '已取消本次登录') {
    const error = new Error(message);
    error.code = 'cancelled';
    return error;
  }

  function makeFatal(message) {
    const error = new Error(message);
    error.code = 'fatal';
    return error;
  }

  function formatTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  // ---------------------------------------------------------------------------
  // 设置 / 状态
  // ---------------------------------------------------------------------------
  function mergeSettings(raw) {
    const base = JSON.parse(JSON.stringify(FALLBACK_SETTINGS));
    if (!raw || typeof raw !== 'object') return base;
    const next = { ...base, ...raw };
    next.credentials = { ...base.credentials, ...(raw.credentials || {}) };
    next.captcha = { ...base.captcha, ...(raw.captcha || {}) };
    next.ocr = { ...base.ocr, ...(raw.ocr || {}) };
    next.ui = { ...base.ui, ...(raw.ui || {}) };
    next.advanced = { ...base.advanced, ...(raw.advanced || {}) };
    next.enabled = Boolean(next.enabled);
    next.autoSubmit = Boolean(next.autoSubmit);
    next.ui.showOverlay = Boolean(next.ui.showOverlay);
    return next;
  }

  async function loadSettings() {
    try {
      runtime.settings = mergeSettings(await send(MSG.GET_SETTINGS));
    } catch (error) {
      debug('读取设置失败，使用本地默认值', error);
      runtime.settings = mergeSettings(null);
    }
    return runtime.settings;
  }

  async function loadState() {
    try {
      const state = await send(MSG.GET_STATE);
      if (!state || typeof state !== 'object') return;
      if (Array.isArray(state.logs)) {
        runtime.logs = state.logs
          .filter((entry) => entry && typeof entry.message === 'string')
          .slice(-MAX_LOG_BUFFER)
          .map((entry) => ({
            at: Number(entry.at) || Date.now(),
            level: entry.level === 'error' || entry.level === 'warn' || entry.level === 'success' ? entry.level : 'info',
            message: entry.message,
          }));
      }
      runtime.lastSuccessAt = Number(state.lastSuccessAt) || 0;
      runtime.lastError = String(state.lastError || '');
      // 记录上次落盘时的进度：整页刷新后 content script 会重启，
      // 靠它判断「是否还在同一次登录流程里」，避免刷新后无限重试。
      runtime.persisted = {
        status: typeof state.status === 'string' ? state.status : 'idle',
        attempts: clampInt(state.attempts, 0, 100, 0),
        maxAttempts: clampInt(state.maxAttempts, 0, 20, 0),
      };
    } catch (error) {
      debug('读取运行状态失败', error);
    }
  }

  /** 本地先更新再落盘，面板立刻反映，不等 storage 回读 */
  function patchState(patch) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(runtime, patch);
    if ('status' in patch || 'attempts' in patch || 'maxAttempts' in patch) {
      runtime.persisted = {
        status: runtime.status,
        attempts: Number(runtime.attempts) || 0,
        maxAttempts: Number(runtime.maxAttempts) || 0,
      };
    }
    const payload = { ...patch, origin: location.origin, stateAt: Date.now() };
    if (typeof payload.pendingCaptcha === 'string' && payload.pendingCaptcha.length > MAX_CAPTCHA_DATA_URL_LENGTH) {
      delete payload.pendingCaptcha;
      delete payload.pendingCaptchaAt;
    }
    void trySend(MSG.PATCH_STATE, payload);
    renderOverlay();
  }

  function addLog(message, level = 'info') {
    const entry = { at: Date.now(), level, message: String(message) };
    runtime.logs.push(entry);
    if (runtime.logs.length > MAX_LOG_BUFFER) runtime.logs.splice(0, runtime.logs.length - MAX_LOG_BUFFER);
    if (level === 'error') runtime.lastError = entry.message;
    void trySend(MSG.LOG, { message: entry.message, level });
    debug(`[${level}] ${entry.message}`);
    renderLogs();
  }

  // ---------------------------------------------------------------------------
  // DOM 适配层的防御式包装
  // ---------------------------------------------------------------------------
  const EMPTY_FORM = Object.freeze({
    username: null,
    password: null,
    captchaInput: null,
    captchaImage: null,
    submit: null,
    form: null,
  });

  function safeFindForm() {
    try {
      const form = Dom?.findLoginForm?.();
      return form && typeof form === 'object' ? { ...EMPTY_FORM, ...form } : { ...EMPTY_FORM };
    } catch (error) {
      debug('定位登录表单失败', error);
      return { ...EMPTY_FORM };
    }
  }

  function safeIsLoginPage() {
    try {
      return Boolean(Dom?.isLoginPage?.());
    } catch (error) {
      debug('判断登录页失败', error);
      return false;
    }
  }

  function safeDetectLoggedIn() {
    try {
      return Boolean(Dom?.detectLoggedIn?.());
    } catch (error) {
      debug('判断登录态失败', error);
      return false;
    }
  }

  function safeSetValue(input, value) {
    try {
      return Boolean(Dom?.setInputValue?.(input, value));
    } catch (error) {
      debug('写入输入框失败', error);
      return false;
    }
  }

  function safeSignature() {
    try {
      return String(Dom?.pageSignature?.() ?? '');
    } catch {
      return `${location.href}::${Date.now()}`;
    }
  }

  function safeDomSleep(ms) {
    return Dom?.sleep ? Dom.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 可被取消打断的等待，避免取消后还要干等 delayMs */
  async function sleepCancellable(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      if (runtime.cancelled) throw makeCancelled();
      await safeDomSleep(Math.min(120, end - Date.now()));
    }
    if (runtime.cancelled) throw makeCancelled();
  }

  async function waitForLoginPage(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let form = safeFindForm();
    while (!(form.username && form.password) && Date.now() < deadline) {
      await safeDomSleep(200);
      form = safeFindForm();
    }
    return Boolean(form.username && form.password);
  }

  async function locateForm(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let form = safeFindForm();
    while (!(form.username && form.password) && Date.now() < deadline) {
      if (runtime.cancelled) throw makeCancelled();
      await safeDomSleep(250);
      form = safeFindForm();
    }
    return form;
  }

  function readPageError() {
    try {
      const text = String(document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 4000);
      const match = text.match(/[^。；;，,]{0,30}(?:验证码|密码|用户名|账号|学号)[^。；;，,]{0,30}(?:错误|不正确|无效|失败|超时)[^。；;，,]{0,20}/);
      return match ? match[0].trim() : '';
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // 验证码：取图 / 识别结果归一化
  // ---------------------------------------------------------------------------
  function captchaUrl(img, bust = false) {
    const src = typeof img?.src === 'string' ? img.src : '';
    try {
      if (src && /^https?:/i.test(src)) {
        const url = new URL(src);
        if (bust) url.searchParams.set('t', String(Date.now()));
        return url.href;
      }
    } catch {
      /* 落到默认地址 */
    }
    try {
      return new URL(`/captcha/image.action?t=${Date.now()}`, location.origin).href;
    } catch {
      return '';
    }
  }

  /** background 抓图返回值兼容：dataURL 字符串 / { dataUrl } / { data } / { base64 } */
  function pickDataUrl(result) {
    if (typeof result === 'string') return result.startsWith('data:image/') ? result : '';
    if (!result || typeof result !== 'object') return '';
    const direct = result.dataUrl ?? result.dataURL ?? result.url ?? '';
    if (typeof direct === 'string' && direct.startsWith('data:image/')) return direct;
    if (typeof result.data === 'string' && result.data.startsWith('data:image/')) return result.data;
    if (result.data && typeof result.data === 'object') {
      const nested = pickDataUrl(result.data);
      if (nested) return nested;
    }
    const base64 = result.base64 ?? result.image ?? '';
    if (typeof base64 === 'string' && base64.length > 64) {
      if (base64.startsWith('data:image/')) return base64;
      return `data:image/png;base64,${base64.replace(/\s+/g, '')}`;
    }
    return '';
  }

  function pickOcrText(result, expectedLength) {
    let text = '';
    if (typeof result === 'string') text = result;
    else if (result && typeof result === 'object') text = result.text ?? result.result ?? result.data ?? '';
    text = String(text ?? '')
      .replace(/\s+/g, '')
      .replace(/[^0-9a-zA-Z]/g, '');
    if (expectedLength > 0 && text.length > expectedLength) text = text.slice(0, expectedLength);
    return text;
  }

  async function fetchCaptchaViaBackground(img, bust = false) {
    const url = captchaUrl(img, bust);
    if (!url) return '';
    try {
      const dataUrl = pickDataUrl(await send(MSG.FETCH_CAPTCHA, { url }));
      if (!dataUrl) addLog('后台没有取到可用的验证码图片', 'warn');
      return dataUrl;
    } catch (error) {
      addLog(`后台抓取验证码失败：${messageOf(error)}`, 'warn');
      return '';
    }
  }

  async function obtainCaptcha(form) {
    const img = form.captchaImage;
    if (img && typeof Dom?.waitForImageLoad === 'function') {
      try {
        await Dom.waitForImageLoad(img, 1500);
      } catch {
        /* 图片没加载完也继续尝试读取 */
      }
    }
    let dataUrl = '';
    try {
      dataUrl = String(Dom?.captchaImageToDataUrl?.(img) ?? '');
    } catch (error) {
      debug('canvas 读取验证码失败', error);
    }
    if (!dataUrl) {
      addLog('页面内无法读取验证码图片，改为由后台抓取', 'warn');
      dataUrl = await fetchCaptchaViaBackground(img);
    }
    if (!dataUrl) throw new Error('无法获取验证码图片');
    return dataUrl;
  }

  function resolveExpectedLength(form, settings) {
    const configured = clampInt(settings?.captcha?.length, 0, 12, 0);
    if (configured > 0) return configured;
    const maxLength = Number(form?.captchaInput?.maxLength);
    return Number.isFinite(maxLength) && maxLength > 0 ? Math.min(maxLength, 12) : 0;
  }

  // ---------------------------------------------------------------------------
  // 悬浮面板：Shadow DOM 构建（内部样式全部在这里，content.css 只管宿主）
  // ---------------------------------------------------------------------------
  const OVERLAY_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .card {
      width: min(320px, calc(100vw - 24px));
      padding: 12px 14px 14px;
      background: #ffffff;
      color: #1f2933;
      border: 1px solid rgba(15, 23, 42, 0.07);
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(15, 23, 42, 0.18), 0 1px 2px rgba(15, 23, 42, 0.08);
      font-size: 13px;
      line-height: 1.5;
      text-align: left;
      letter-spacing: normal;
    }

    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .brand { font-size: 14px; font-weight: 600; color: #0f172a; }
    .close {
      flex: none; width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
      background: transparent; color: #94a3b8; font-size: 18px; line-height: 1; cursor: pointer;
    }
    .close:hover { background: #f1f5f9; color: #475569; }

    .status { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
    .dot[data-tone="running"] { background: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }
    .dot[data-tone="warn"] { background: #d97706; }
    .dot[data-tone="success"] { background: #16a34a; }
    .dot[data-tone="error"] { background: #dc2626; }
    .status-text { font-size: 13px; font-weight: 500; color: #1f2933; }
    .status-text[data-tone="success"] { color: #15803d; }
    .status-text[data-tone="error"] { color: #b91c1c; }
    .status-text[data-tone="warn"] { color: #b45309; }
    .detail { margin-top: 4px; font-size: 12px; color: #64748b; word-break: break-word; }
    .progress { margin-top: 6px; font-size: 12px; color: #475569; }

    .logs { margin-top: 10px; padding-top: 8px; border-top: 1px solid #eef2f7; }
    .logs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: #94a3b8; }
    .log-list {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 132px; overflow-y: auto; margin-top: 4px;
    }
    .log-row { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; line-height: 1.45; color: #475569; }
    .log-time { flex: none; color: #94a3b8; font-variant-numeric: tabular-nums; }
    .log-text { word-break: break-word; }
    .log--warn .log-text { color: #b45309; }
    .log--error .log-text { color: #b91c1c; }
    .log--success .log-text { color: #15803d; }

    .link {
      padding: 0; border: none; background: none; color: #2563eb;
      font-size: 11.5px; line-height: 1.5; cursor: pointer; font-family: inherit;
    }
    .link:hover { text-decoration: underline; }
    .link:disabled { color: #94a3b8; cursor: default; text-decoration: none; }
    .link.danger { align-self: flex-start; margin-top: 8px; color: #dc2626; }

    .captcha {
      display: flex; flex-direction: column;
      margin-top: 10px; padding: 10px;
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;
    }
    .captcha-title { font-size: 12px; font-weight: 600; color: #475569; }
    .captcha-img {
      display: block; width: 100%; height: 120px; object-fit: contain;
      margin: 6px 0; background: #fff;
      border: 1px solid #e2e8f0; border-radius: 6px;
    }
    .captcha-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; }
    .hint { color: #94a3b8; }
    .hint[data-tone="warn"] { color: #b45309; }
    .captcha-row { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
    .captcha-input {
      flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 8px;
      background: #fff; color: #0f172a;
      border: 1px solid #cbd5e1; border-radius: 6px;
      font-family: inherit; font-size: 14px; letter-spacing: 2px; outline: none;
    }
    .captcha-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }

    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .primary {
      flex: 1 1 auto; height: 34px; padding: 0 12px; border: none; border-radius: 8px;
      background: #2563eb; color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .primary:hover { background: #1d4ed8; }
    .primary:active { background: #1e40af; }
    .primary.danger { background: #dc2626; }
    .primary.danger:hover { background: #b91c1c; }
    .primary.small { flex: none; height: 32px; padding: 0 14px; font-weight: 500; }
    .secondary {
      flex: none; height: 34px; padding: 0 12px;
      background: #fff; color: #334155;
      border: 1px solid #cbd5e1; border-radius: 8px;
      font-family: inherit; font-size: 13px; cursor: pointer;
    }
    .secondary:hover { background: #f8fafc; border-color: #94a3b8; }
  `;

  const CARD_HTML = `
    <div class="card" role="dialog" aria-label="教务系统自动登录">
      <div class="header">
        <span class="brand">教务系统自动登录</span>
        <button class="close" type="button" data-act="close" aria-label="关闭面板" title="关闭面板">×</button>
      </div>
      <div class="status">
        <span class="dot" data-role="dot" data-tone="idle"></span>
        <span class="status-text" data-role="status-text">待命中</span>
      </div>
      <div class="detail" data-role="detail" hidden></div>
      <div class="progress" data-role="progress" hidden></div>
      <div class="logs" data-role="logs" hidden>
        <div class="logs-head">
          <span>最近动态</span>
          <button class="link" type="button" data-act="toggle-logs" data-role="logs-toggle" hidden>展开</button>
        </div>
        <div class="log-list" data-role="log-list"></div>
      </div>
      <div class="captcha" data-role="captcha" hidden>
        <div class="captcha-title">请输入验证码</div>
        <img class="captcha-img" data-role="captcha-img" alt="验证码图片" />
        <div class="captcha-tools">
          <span class="hint" data-role="captcha-hint">请输入图片中的验证码</span>
          <button class="link" type="button" data-act="refresh-captcha" data-role="refresh">看不清？换一张</button>
        </div>
        <div class="captcha-row">
          <input class="captcha-input" data-role="captcha-input" type="text" autocomplete="off"
                 autocapitalize="off" spellcheck="false" inputmode="text" maxlength="12" placeholder="验证码" />
          <button class="primary small" type="button" data-act="confirm-captcha">确认</button>
        </div>
        <button class="link danger" type="button" data-act="cancel-captcha">取消本次登录</button>
      </div>
      <div class="actions">
        <button class="primary" type="button" data-act="run" data-role="primary">立即登录</button>
        <button class="secondary" type="button" data-act="options">设置</button>
      </div>
    </div>
  `;

  function ensureOverlay() {
    if (overlay.host) return overlay;
    try {
      const host = document.createElement('div');
      host.id = HOST_ID;
      host.hidden = true;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = CARD_HTML;
      shadow.append(style, wrapper);
      // 挂在 documentElement 上，避免站点脚本替换 body 时把面板删掉
      (document.documentElement || document.body).appendChild(host);

      const $ = (role) => shadow.querySelector(`[data-role="${role}"]`);
      overlay.host = host;
      overlay.shadow = shadow;
      overlay.els = {
        card: shadow.querySelector('.card'),
        dot: $('dot'),
        statusText: $('status-text'),
        detail: $('detail'),
        progress: $('progress'),
        logs: $('logs'),
        logList: $('log-list'),
        logsToggle: $('logs-toggle'),
        captcha: $('captcha'),
        captchaImg: $('captcha-img'),
        captchaHint: $('captcha-hint'),
        captchaInput: $('captcha-input'),
        refresh: $('refresh'),
        primary: $('primary'),
      };
      shadow.addEventListener('click', onOverlayClick);
      shadow.addEventListener('keydown', onOverlayKeydown);
      return overlay;
    } catch (error) {
      debug('创建悬浮面板失败', error);
      return null;
    }
  }

  function shouldShowOverlay() {
    if (runtime.settings?.ui?.showOverlay === false) return false;
    if (runtime.dismissed) return false;
    if (runtime.captchaOpen) return true;
    if (runtime.running || runtime.resultVisible) return true;
    return safeIsLoginPage();
  }

  function renderOverlay() {
    if (runtime.settings?.ui?.showOverlay === false && !runtime.captchaOpen) {
      if (overlay.host) overlay.host.hidden = true;
      return;
    }
    const ui = ensureOverlay();
    if (!ui) return;
    const visible = shouldShowOverlay();
    ui.host.hidden = !visible;
    if (!visible) return;

    const els = ui.els;
    els.dot.dataset.tone = STATUS_TONE[runtime.status] || 'idle';
    els.statusText.textContent = STATUS_LABEL[runtime.status] || '待命中';
    els.statusText.dataset.tone = STATUS_TONE[runtime.status] || 'idle';
    els.detail.textContent = runtime.message || '';
    els.detail.hidden = !runtime.message;

    const max = Number(runtime.maxAttempts) || 0;
    if (runtime.running && max > 0) {
      els.progress.hidden = false;
      els.progress.textContent = `第 ${Math.min(runtime.attempts + 1, max)} / ${max} 次尝试`;
    } else if (max > 0 && runtime.attempts > 0) {
      els.progress.hidden = false;
      els.progress.textContent = `已尝试 ${runtime.attempts} / ${max} 次`;
    } else {
      els.progress.hidden = true;
    }

    const primary = els.primary;
    primary.classList.remove('danger');
    primary.hidden = false;
    if (runtime.running) {
      primary.textContent = '取消';
      primary.dataset.act = 'cancel';
      primary.classList.add('danger');
    } else if (runtime.status === 'need-input') {
      primary.textContent = '去设置';
      primary.dataset.act = 'options';
    } else if (runtime.status === 'failed') {
      primary.textContent = '重试';
      primary.dataset.act = 'run';
    } else if (runtime.status === 'success') {
      primary.textContent = '立即登录';
      primary.dataset.act = 'run';
    } else {
      primary.textContent = '立即登录';
      primary.dataset.act = 'run';
    }

    els.captcha.hidden = !runtime.captchaOpen;
    renderLogs();
  }

  function renderLogs() {
    const els = overlay.els;
    if (!els?.logList) return;
    const limit = runtime.logsExpanded ? MAX_LOG_BUFFER : 5;
    const entries = runtime.logs.slice(-limit);
    els.logList.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `log-row log--${entry.level || 'info'}`;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = formatTime(entry.at);
      const text = document.createElement('span');
      text.className = 'log-text';
      text.textContent = entry.message;
      row.append(time, text);
      els.logList.appendChild(row);
    }
    els.logs.hidden = runtime.logs.length === 0;
    if (els.logsToggle) {
      els.logsToggle.hidden = runtime.logs.length <= 5;
      els.logsToggle.textContent = runtime.logsExpanded ? '收起' : `展开全部（${runtime.logs.length}）`;
    }
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function setCaptchaHint(text, tone = '') {
    if (!overlay.els?.captchaHint) return;
    overlay.els.captchaHint.textContent = text;
    if (tone) overlay.els.captchaHint.dataset.tone = tone;
    else delete overlay.els.captchaHint.dataset.tone;
  }

  function onOverlayClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    switch (target.dataset.act) {
      case 'close':
        dismissOverlay();
        break;
      case 'run':
        void startLogin('overlay');
        break;
      case 'cancel':
        cancelFlow('已取消本次登录');
        break;
      case 'options':
        openOptionsPage();
        break;
      case 'toggle-logs':
        runtime.logsExpanded = !runtime.logsExpanded;
        renderLogs();
        break;
      case 'refresh-captcha':
        void refreshPromptCaptcha();
        break;
      case 'confirm-captcha':
        confirmPromptCaptcha();
        break;
      case 'cancel-captcha':
        cancelFlow('已取消本次登录');
        break;
      default:
        break;
    }
  }

  function onOverlayKeydown(event) {
    if (!runtime.captchaOpen) return;
    if (event.key === 'Enter') {
      if (event.target === overlay.els?.captchaInput) {
        event.preventDefault();
        confirmPromptCaptcha();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelFlow('已取消本次登录');
    }
  }

  function openOptionsPage() {
    try {
      const result = chrome.runtime.openOptionsPage?.();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) {
      addLog(`无法打开设置页：${messageOf(error)}`, 'warn');
    }
  }

  function dismissOverlay() {
    runtime.dismissed = true;
    // 关闭面板只收起界面：正在进行的自动登录继续跑。
    // 但如果正等着人工输入验证码，关掉面板等于放弃输入，必须取消本次流程。
    if (runtime.captchaOpen) {
      runtime.cancelled = true;
      settleCaptcha({ error: makeCancelled('面板已关闭，已取消本次登录') });
    }
    renderOverlay();
  }

  function clearAutoDismiss() {
    if (autoDismissTimer) {
      clearTimeout(autoDismissTimer);
      autoDismissTimer = null;
    }
  }

  function scheduleAutoDismiss() {
    clearAutoDismiss();
    const ms = clampInt(runtime.settings?.ui?.autoDismissMs, 0, 60000, 8000);
    if (ms <= 0) return;
    autoDismissTimer = setTimeout(() => {
      autoDismissTimer = null;
      runtime.dismissed = true;
      renderOverlay();
    }, ms);
  }

  // ---------------------------------------------------------------------------
  // 人工输入验证码
  // 接口约定：showCaptchaPrompt(dataUrl, expectedLength) → Promise<string>
  //   - resolve：用户输入的非空验证码字符串
  //   - reject ：Error，code === 'cancelled'（用户取消 / 关闭面板 / 输入超时）
  //            或 code === 'fatal'（面板不可用，无法人工输入）
  //   - 外部注入：chrome.runtime.sendMessage({type:'content/submit-captcha', payload:{text}})
  // ---------------------------------------------------------------------------
  function showCaptchaPrompt(dataUrl, expectedLength = 0) {
    return new Promise((resolve, reject) => {
      if (runtime.cancelled) {
        reject(makeCancelled());
        return;
      }
      if (runtime.settings?.ui?.showOverlay === false) {
        reject(makeFatal('已关闭页面悬浮面板，无法人工输入验证码；请在设置中开启悬浮面板，或配置验证码识别服务'));
        return;
      }
      const ui = ensureOverlay();
      if (!ui) {
        reject(makeFatal('悬浮面板初始化失败，无法人工输入验证码'));
        return;
      }
      if (captchaWaiter) {
        reject(makeFatal('已存在等待中的验证码输入'));
        return;
      }

      runtime.dismissed = false;
      runtime.resultVisible = true;
      runtime.captchaOpen = true;
      runtime.captchaExpected = expectedLength;

      const els = ui.els;
      els.captchaImg.src = dataUrl;
      els.captchaInput.value = '';
      if (expectedLength > 0) els.captchaInput.maxLength = expectedLength;
      else els.captchaInput.maxLength = 12;
      setCaptchaHint(expectedLength > 0 ? `请输入 ${expectedLength} 位验证码` : '请输入图片中的验证码');
      renderOverlay();

      const timeoutMs = clampInt(runtime.settings?.captcha?.solveTimeoutMs, 5000, 600000, 120000);
      const waiter = { resolve, reject, timer: null, expectedLength };
      waiter.timer = setTimeout(() => {
        if (captchaWaiter !== waiter) return;
        runtime.cancelled = true;
        settleCaptcha({ error: makeCancelled('验证码输入超时') });
      }, timeoutMs);
      captchaWaiter = waiter;

      if (dataUrl.length <= MAX_CAPTCHA_DATA_URL_LENGTH) {
        patchState({ pendingCaptcha: dataUrl, pendingCaptchaAt: Date.now() });
      }

      setTimeout(() => {
        try {
          els.captchaInput.focus();
          els.captchaInput.select();
        } catch {
          /* 焦点拿不到不影响输入 */
        }
      }, 0);
    });
  }

  function closeCaptchaArea() {
    runtime.captchaOpen = false;
    runtime.captchaExpected = 0;
    const els = overlay.els;
    if (!els) return;
    if (els.captcha) els.captcha.hidden = true;
    if (els.captchaInput) els.captchaInput.value = '';
    if (els.captchaImg) els.captchaImg.removeAttribute('src');
  }

  function settleCaptcha(outcome) {
    const waiter = captchaWaiter;
    if (!waiter) return false;
    captchaWaiter = null;
    if (waiter.timer) clearTimeout(waiter.timer);
    closeCaptchaArea();
    patchState({ pendingCaptcha: '', pendingCaptchaAt: 0 });
    if (outcome && outcome.error) waiter.reject(outcome.error);
    else waiter.resolve(String(outcome?.text ?? ''));
    return true;
  }

  function confirmPromptCaptcha() {
    if (!runtime.captchaOpen || !captchaWaiter) return;
    const raw = String(overlay.els?.captchaInput?.value ?? '');
    const text = raw.replace(/\s+/g, '');
    if (!text) {
      setCaptchaHint('验证码不能为空', 'warn');
      try {
        overlay.els?.captchaInput?.focus();
      } catch {
        /* ignore */
      }
      return;
    }
    const expected = captchaWaiter.expectedLength;
    if (expected > 0 && text.length !== expected) {
      setCaptchaHint(`验证码应为 ${expected} 位，请核对`, 'warn');
    }
    settleCaptcha({ text: text.slice(0, 12) });
  }

  /** 供 content/submit-captcha 调用（popup 侧复用） */
  function submitManualCaptcha(text) {
    const waiter = captchaWaiter;
    if (!runtime.captchaOpen || !waiter) {
      return { accepted: false, reason: '当前没有等待中的验证码输入' };
    }
    const value = String(text ?? '').replace(/\s+/g, '');
    if (!value) return { accepted: false, reason: '验证码不能为空' };
    settleCaptcha({ text: value.slice(0, 12) });
    return { accepted: true, expectedLength: waiter.expectedLength };
  }

  async function refreshPromptCaptcha() {
    if (!runtime.captchaOpen || !captchaWaiter) return;
    const link = overlay.els?.refresh;
    if (link) link.disabled = true;
    setCaptchaHint('正在刷新…');
    try {
      const form = safeFindForm();
      let dataUrl = '';
      if (form.captchaImage) {
        try {
          dataUrl = String((await Dom?.refreshCaptcha?.(form.captchaImage, 400)) ?? '');
        } catch (error) {
          debug('点击刷新验证码失败', error);
        }
      }
      if (!dataUrl) dataUrl = await fetchCaptchaViaBackground(form.captchaImage, true);
      if (dataUrl) {
        if (overlay.els?.captchaImg) overlay.els.captchaImg.src = dataUrl;
        if (dataUrl.length <= MAX_CAPTCHA_DATA_URL_LENGTH) {
          patchState({ pendingCaptcha: dataUrl, pendingCaptchaAt: Date.now() });
        }
        setCaptchaHint(runtime.captchaExpected > 0 ? `请输入 ${runtime.captchaExpected} 位验证码` : '请输入图片中的验证码');
        try {
          overlay.els?.captchaInput?.focus();
        } catch {
          /* ignore */
        }
      } else {
        setCaptchaHint('刷新失败，请再试一次', 'warn');
        addLog('刷新验证码失败，请手动刷新页面验证码', 'warn');
      }
    } finally {
      if (link) link.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 登录结果判定
  // ---------------------------------------------------------------------------
  /**
   * 提交后等待结果。
   * 除「指纹变化 / 密码框消失 / 已登录」外，还额外识别「验证码图片被换成新的」
   * 与「验证码输入框被清空」——这两者都说明站点重渲染了登录页并拒绝了本次尝试，
   * 否则每次失败都要干等 15 秒。
   */
  async function waitForLoginResult(beforeSignature, timeoutMs, beforeCaptchaSrc = '') {
    const deadline = Date.now() + timeoutMs;
    let sawRejection = '';
    while (Date.now() < deadline) {
      await safeDomSleep(300);
      if (runtime.cancelled) throw makeCancelled();
      if (safeDetectLoggedIn()) return { ok: true, reason: '已检测到登录态' };
      const form = safeFindForm();
      if (!form.password) return { ok: true, reason: '登录框已消失' };

      // 站点已明确拒绝：验证码图片换新，或填好的验证码被清空
      if (!sawRejection) {
        const src = String(form.captchaImage?.currentSrc || form.captchaImage?.src || '');
        if (beforeCaptchaSrc && src && src !== beforeCaptchaSrc) sawRejection = '验证码已刷新，本次尝试未通过';
        else if (form.captchaInput && form.captchaInput.value === '') sawRejection = '验证码输入被清空，本次尝试未通过';
      }
      if (sawRejection) {
        await safeDomSleep(500);
        if (safeDetectLoggedIn()) return { ok: true, reason: '已检测到登录态' };
        if (!safeFindForm().password) return { ok: true, reason: '登录框已消失' };
        return { ok: false, reason: readPageError() || sawRejection };
      }

      if (safeSignature() !== beforeSignature) {
        // 页面变了：给跳转留一点宽限期，别在过渡瞬间误判失败
        const graceUntil = Math.min(deadline, Date.now() + 2500);
        while (Date.now() < graceUntil) {
          await safeDomSleep(300);
          if (safeDetectLoggedIn()) return { ok: true, reason: '已检测到登录态' };
          if (!safeFindForm().password) return { ok: true, reason: '登录框已消失' };
        }
        if (safeDetectLoggedIn()) return { ok: true, reason: '已检测到登录态' };
        if (!safeFindForm().password) return { ok: true, reason: '登录框已消失' };
        // 页面确实刷新了但登录框还在：多半是验证码错误后的重载
        return { ok: false, reason: readPageError() || '页面已刷新但仍停留在登录页' };
      }
    }
    if (runtime.cancelled) throw makeCancelled();
    return { ok: false, reason: '等待登录结果超时' };
  }

  async function refreshCaptchaQuietly() {
    const form = safeFindForm();
    if (!form.captchaImage) return;
    try {
      await Dom?.refreshCaptcha?.(form.captchaImage, 400);
    } catch (error) {
      debug('刷新验证码失败', error);
    }
  }

  // ---------------------------------------------------------------------------
  // 单次尝试 / 主循环
  // ---------------------------------------------------------------------------
  async function attemptOnce(attempt, maxAttempts = 0) {
    const settings = runtime.settings || mergeSettings(null);
    const form = await locateForm(5000);
    if (!form.username) throw new Error('未找到学号输入框');
    if (!form.password) throw new Error('未找到密码输入框');

    const username = String(settings.credentials?.username ?? '').trim();
    const password = String(settings.credentials?.password ?? '');
    safeSetValue(form.username, username);
    safeSetValue(form.password, password);

    const dataUrl = await obtainCaptcha(form);
    const expectedLength = resolveExpectedLength(form, settings);

    let captchaText = '';
    const autoMode = String(settings.captcha?.mode ?? 'auto') !== 'manual';
    const provider = String(settings.ocr?.provider ?? 'manual');

    if (autoMode && provider !== 'manual') {
      try {
        const result = await send(MSG.OCR_SOLVE, { dataUrl, expectedLength });
        captchaText = pickOcrText(result, expectedLength);
        if (!captchaText) throw new Error('识别结果为空');
        debug(`验证码识别结果：${captchaText}`);
      } catch (error) {
        addLog(`自动识别验证码失败，改为手动输入：${messageOf(error)}`, 'warn');
        captchaText = '';
      }
    }

    if (!captchaText) captchaText = await showCaptchaPrompt(dataUrl, expectedLength);

    const current = safeFindForm();
    const captchaInput = current.captchaInput || form.captchaInput;
    if (!captchaInput) throw new Error('未找到验证码输入框');
    if (!safeSetValue(captchaInput, captchaText)) throw new Error('验证码写入失败');

    const beforeSignature = safeSignature();
    const beforeCaptchaSrc = String(form.captchaImage?.currentSrc || form.captchaImage?.src || '');
    if (settings.autoSubmit === false) {
      addLog('已填写完成，按设置未自动提交，请在页面中手动点击登录', 'info');
      patchState({ message: '已填写，请手动点击页面上的登录按钮' });
    } else {
      const submitForm = form.form ?? current.form ?? captchaInput.form ?? null;
      const submitButton = form.submit || current.submit;
      let submitted = false;
      // 旧版 Struts2 页面可能没有 <form>，只有按钮上的 onclick，因此逐级兜底
      if (submitForm) {
        try {
          submitted = Boolean(Dom?.submitLoginForm?.(submitForm, submitButton));
        } catch (error) {
          debug('提交表单失败，尝试点击登录按钮', error);
        }
      }
      if (!submitted && submitButton && typeof submitButton.click === 'function') {
        submitButton.click();
        submitted = true;
      }
      if (!submitted) {
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
        captchaInput.dispatchEvent(enter);
        submitted = true;
      }
      if (!submitted) throw new Error('提交登录表单失败');
      // 关键：提交后页面很可能整页刷新，本脚本会立刻被销毁，
      // 所以必须「提交前」就把本次尝试次数落盘，否则刷新后计数清零 → 无限重试。
      await persistAttemptProgress(attempt, maxAttempts);
      addLog('已提交登录请求', 'info');
    }

    const waitMs = settings.autoSubmit === false ? MANUAL_SUBMIT_TIMEOUT_MS : LOGIN_RESULT_TIMEOUT_MS;
    const result = await waitForLoginResult(beforeSignature, waitMs, beforeCaptchaSrc);
    if (!result.ok) throw new Error(result.reason);

    patchState({
      status: 'success',
      message: `登录成功（第 ${attempt} 次尝试）`,
      attempts: attempt,
      lastSuccessAt: Date.now(),
      lastError: '',
      pendingCaptcha: '',
      pendingCaptchaAt: 0,
    });
    addLog(`登录成功（第 ${attempt} 次尝试）`, 'success');
    runtime.resultVisible = true;

    if (settings.ui?.notifyOnSuccess) {
      void trySend(MSG.NOTIFY, {
        title: '教务系统登录成功',
        message: `已自动登录宁夏大学教务系统（第 ${attempt} 次尝试）`,
      });
    }
    renderOverlay();
    scheduleAutoDismiss();
    return true;
  }

  async function runLoginFlow(trigger = 'auto') {
    const settings = runtime.settings || mergeSettings(null);

    const username = String(settings.credentials?.username ?? '').trim();
    const password = String(settings.credentials?.password ?? '');
    if (!username || !password) {
      runtime.resultVisible = true;
      patchState({
        status: 'need-input',
        message: '请先在设置里填写学号与密码',
        attempts: 0,
        maxAttempts: 0,
      });
      addLog('缺少学号或密码，已暂停登录', 'warn');
      return;
    }

    if (!safeIsLoginPage()) {
      if (safeDetectLoggedIn()) {
        runtime.resultVisible = false;
        patchState({ status: 'success', message: '已处于登录状态' });
        addLog('页面已处于登录状态，无需登录', 'info');
      } else {
        runtime.resultVisible = false;
        patchState({ status: 'idle', message: '当前页面没有登录表单' });
        addLog('未检测到登录表单，已待命', 'warn');
      }
      return;
    }

    const maxAttempts = clampInt(settings.captcha?.maxAttempts, 1, 20, 5);
    const delayMs = clampInt(settings.captcha?.delayMs, 0, 60000, 1200);

    // 整页刷新会重启 content script：若上次落盘仍在 running，则接着上次的次数往下走，
    // 否则「验证码错了 → 页面刷新 → 脚本重来」会变成无限重试。
    const resumeFrom =
      trigger === 'auto' && runtime.persisted.status === 'running'
        ? Math.min(runtime.persisted.attempts, maxAttempts)
        : 0;
    if (resumeFrom >= maxAttempts) {
      const msg = `已尝试 ${maxAttempts} 次仍失败：登录后页面仍停留在登录页。建议检查验证码识别配置，或手动登录。`;
      runtime.resultVisible = true;
      patchState({ status: 'failed', message: msg, attempts: maxAttempts, maxAttempts, lastError: '重试次数已用尽' });
      addLog(msg, 'error');
      return;
    }

    runtime.resultVisible = true;
    runtime.attempts = resumeFrom;
    patchState({
      status: 'running',
      message: resumeFrom > 0 ? `继续上次的进度（已完成 ${resumeFrom} 次）` : '正在填写登录表单…',
      attempts: resumeFrom,
      maxAttempts,
      lastRunAt: Date.now(),
      lastError: '',
      origin: location.origin,
    });
    addLog(resumeFrom > 0 ? `继续自动登录（已完成 ${resumeFrom} 次尝试）` : '开始自动登录', 'info');

    let lastReason = '';
    for (let attempt = resumeFrom + 1; attempt <= maxAttempts; attempt++) {
      if (runtime.cancelled) throw makeCancelled();
      patchState({ attempts: attempt - 1, message: `第 ${attempt} 次尝试中…` });
      if (attempt > 1) addLog(`开始第 ${attempt} 次尝试`, 'info');

      try {
        await attemptOnce(attempt, maxAttempts);
        return;
      } catch (error) {
        if (error?.code === 'cancelled') throw error;
        if (error?.code === 'fatal') throw error;
        lastReason = messageOf(error);
        addLog(`第 ${attempt} 次失败：${lastReason}`, 'warn');
        patchState({
          status: 'running',
          attempts: attempt,
          message: `第 ${attempt} 次未成功，准备重试…`,
          lastError: lastReason,
        });
        if (attempt < maxAttempts) {
          if (runtime.cancelled) throw makeCancelled();
          await refreshCaptchaQuietly();
          await sleepCancellable(delayMs);
        }
      }
    }

    const failedMessage = `已尝试 ${maxAttempts} 次仍失败：${lastReason || '原因未知'}。建议检查验证码识别服务配置，或直接在页面上手动登录。`;
    runtime.resultVisible = true;
    patchState({
      status: 'failed',
      message: failedMessage,
      attempts: maxAttempts,
      lastError: lastReason,
    });
    addLog(failedMessage, 'error');
  }

  // ---------------------------------------------------------------------------
  // 对外入口：开始 / 取消
  // ---------------------------------------------------------------------------
  async function startLogin(trigger = 'auto') {
    if (runtime.running) {
      addLog('正在登录中，已忽略重复的启动请求', 'warn');
      return { started: false, reason: 'running' };
    }
    if (autoStartTimer) {
      clearTimeout(autoStartTimer);
      autoStartTimer = null;
    }

    runtime.running = true;
    runtime.cancelled = false;
    runtime.dismissed = false;
    clearAutoDismiss();
    ensureOverlay();
    renderOverlay();
    debug(`启动登录流程（${trigger}）`);

    try {
      if (!runtime.settings) await loadSettings();
      await runLoginFlow(trigger);
    } catch (error) {
      if (error?.code === 'cancelled') {
        const msg = messageOf(error) || '已取消本次登录';
        patchState({ status: 'idle', message: msg });
        addLog(msg, 'info');
      } else {
        const msg = `登录流程中断：${messageOf(error)}`;
        runtime.resultVisible = true;
        patchState({ status: 'failed', message: msg, lastError: messageOf(error) });
        addLog(msg, 'error');
      }
    } finally {
      runtime.running = false;
      runtime.cancelled = false;
      if (captchaWaiter) settleCaptcha({ error: makeCancelled('登录流程已结束') });
      closeCaptchaArea();
      renderOverlay();
    }
    return { started: true };
  }

  function cancelFlow(reason = '已取消本次登录') {
    const wasRunning = runtime.running;
    if (wasRunning) runtime.cancelled = true;
    if (captchaWaiter) settleCaptcha({ error: makeCancelled(reason) });
    if (!wasRunning) {
      // 没有在跑就别把已有的成功/失败结果覆盖成「已取消」
      if (runtime.status === 'running') patchState({ status: 'idle', message: reason });
      addLog(reason, 'info');
    }
    renderOverlay();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 消息：popup / background -> content
  // ---------------------------------------------------------------------------
  function buildPageInfo() {
    const form = safeFindForm();
    return {
      isLoginPage: Boolean(form.username && form.password),
      hasUsername: Boolean(form.username),
      hasPassword: Boolean(form.password),
      hasCaptchaImage: Boolean(form.captchaImage),
      loggedIn: safeDetectLoggedIn(),
      running: runtime.running,
      status: runtime.status,
      attempts: runtime.attempts,
      maxAttempts: runtime.maxAttempts,
      awaitingCaptcha: runtime.captchaOpen,
    };
  }

  function registerMessageListener() {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const type = message?.type;
        switch (type) {
          case CONTENT_MSG.RUN: {
            const started = !runtime.running;
            runtime.dismissed = false;
            if (started) {
              void startLogin('message');
            } else {
              addLog('正在登录中，已忽略重复的启动请求', 'warn');
            }
            sendResponse({ ok: true, data: { started, reason: started ? '' : '正在登录中' }, started });
            return false;
          }
          case CONTENT_MSG.CANCEL: {
            cancelFlow('已取消本次登录');
            sendResponse({ ok: true, data: { cancelled: true }, cancelled: true });
            return false;
          }
          case CONTENT_MSG.SUBMIT_CAPTCHA: {
            const outcome = submitManualCaptcha(message?.payload?.text);
            if (outcome.accepted) sendResponse({ ok: true, data: outcome });
            else sendResponse({ ok: false, error: outcome.reason || '提交失败' });
            return false;
          }
          case CONTENT_MSG.GET_PAGE_INFO: {
            const info = buildPageInfo();
            // 同时给两种消费方式：标准信封 { ok, data } 与顶层字段（按契约描述）
            sendResponse({ ok: true, data: info, ...info });
            return false;
          }
          case CONTENT_MSG.BROADCAST_SETTINGS_CHANGED: {
            void (async () => {
              const previous = runtime.settings;
              await loadSettings();
              // 只更新面板文案/开关，不因为「改成 enabled」就自动触发登录，避免打扰
              if (previous?.ui?.showOverlay !== runtime.settings.ui.showOverlay) {
                runtime.dismissed = false;
              }
              if (!runtime.running && runtime.status === 'idle' && safeIsLoginPage() && !runtime.settings.enabled) {
                runtime.message = '自动登录已暂停，点击开始登录';
              } else if (!runtime.running && runtime.status === 'idle' && safeIsLoginPage()) {
                runtime.message = '待命中';
              }
              renderOverlay();
              sendResponse({ ok: true, data: { applied: true, settings: runtime.settings } });
            })();
            return true;
          }
          default:
            return false;
        }
      });
    } catch (error) {
      debug('注册消息监听失败', error);
    }
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  async function init() {
    await Promise.all([loadSettings(), loadState()]);
    renderOverlay();

    // 先看是否已经是登录后的页面。
    // 真实站点登录成功会整页跳到 home.action，若这里先等 3 秒找登录表单，
    // 界面会一直停在「第 N 次尝试中…」，用户会以为没成功。
    if (safeDetectLoggedIn()) {
      if (runtime.running) return;
      runtime.resultVisible = false;
      // 提交表单会让旧文档被销毁，「登录成功（第 N 次尝试）」这句来不及写。
      // 这里把落盘的尝试次数接上，让用户看到的仍是完整结论。
      const attempts = Number(runtime.persisted.attempts) || 0;
      const wasRunning = runtime.persisted.status === 'running';
      if (wasRunning && attempts > 0) {
        patchState({
          status: 'success',
          message: `登录成功（第 ${attempts} 次尝试）`,
          attempts,
          lastSuccessAt: Date.now(),
          lastError: '',
        });
        addLog(`登录成功（第 ${attempts} 次尝试）`, 'success');
      } else {
        patchState({ status: 'success', message: '已处于登录状态' });
        addLog('页面已处于登录状态', 'info');
      }
      return;
    }

    const onLoginPage = await waitForLoginPage(3000);

    // 初始化期间可能已经收到 RUN / 用户点击，别把运行中的状态改回待命
    if (runtime.running) return;

    if (!onLoginPage) {
      if (safeDetectLoggedIn()) {
        runtime.resultVisible = false;
        patchState({ status: 'success', message: '已处于登录状态' });
        addLog('页面已处于登录状态', 'info');
      } else {
        runtime.status = 'idle';
        runtime.message = '当前页面没有登录表单';
        renderOverlay();
      }
      return;
    }

    runtime.status = 'idle';
    if (runtime.settings.enabled) {
      const delayMs = clampInt(runtime.settings.advanced?.startDelayMs, 0, 15000, 400);
      runtime.message = '准备自动登录…';
      renderOverlay();
      autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        void startLogin('auto');
      }, delayMs);
    } else {
      runtime.message = '自动登录已暂停，点击开始登录';
      renderOverlay();
    }
  }

  registerMessageListener();
  if (!Dom) {
    // dom-adapter.js 未注入时不报错，仅等待可用（background 可能稍后补注入）
    debug('JWGLDom 尚未就绪，登录流程将在需要时重试');
  }
  init().catch((error) => debug('初始化失败', error));
})();

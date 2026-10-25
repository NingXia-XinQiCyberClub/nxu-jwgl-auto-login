/**
 * 设置页逻辑。
 *
 * 数据流只有一条：GET_SETTINGS 填表 → 用户改表 → 保存时 collect + 校验 → PATCH_SETTINGS。
 * 表单是唯一事实来源，所以「恢复默认」「导入配置」都只改表单，必须再点保存才落盘。
 */

import { api } from '../shared/messaging.js';
import { deepMerge, normalizeOrigin, normalizeSettings } from '../shared/storage.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SERVER_URLS,
  KNOWN_MIRROR_HINTS,
  OCR_PROVIDERS,
} from '../shared/constants.js';

/** 主地址已在 manifest 的 host_permissions 里，不需要再申请权限 */
const DEFAULT_ORIGIN = normalizeOrigin(DEFAULT_SERVER_URLS[0]);
/** 成功 toast 停留时间；错误信息更长，留给用户读完 */
const TOAST_SUCCESS_MS = 2000;
const TOAST_ERROR_MS = 5000;

const els = {
  form: document.getElementById('settings-form'),
  toast: document.getElementById('toast'),
  savebar: document.getElementById('dirty-hint'),
  save: document.getElementById('save-btn'),

  username: document.getElementById('acc-username'),
  password: document.getElementById('acc-password'),
  passwordToggle: document.getElementById('acc-password-toggle'),

  serverList: document.getElementById('server-list'),
  serverAdd: document.getElementById('server-add'),
  permissionNote: document.getElementById('permission-note'),
  permissionWarning: document.getElementById('permission-warning'),
  mirrorHints: document.getElementById('mirror-hints'),

  providerRadios: Array.from(document.querySelectorAll('input[name="ocr-provider"]')),
  baiduPanel: document.getElementById('ocr-baidu-panel'),
  remotePanel: document.getElementById('ocr-remote-panel'),
  manualNote: document.getElementById('ocr-manual-note'),
  baiduKey: document.getElementById('baidu-key'),
  baiduSecret: document.getElementById('baidu-secret'),
  remoteEndpoint: document.getElementById('remote-endpoint'),
  remoteMethod: document.getElementById('remote-method'),
  remoteField: document.getElementById('remote-field'),
  remotePath: document.getElementById('remote-path'),
  ocrTest: document.getElementById('ocr-test'),
  ocrTestResult: document.getElementById('ocr-test-result'),

  enabled: document.getElementById('opt-enabled'),
  autoSubmit: document.getElementById('opt-auto-submit'),
  maxAttempts: document.getElementById('opt-max-attempts'),
  delaySec: document.getElementById('opt-delay-sec'),
  solveTimeoutSec: document.getElementById('opt-solve-timeout-sec'),
  startDelay: document.getElementById('opt-start-delay'),
  captchaLength: document.getElementById('opt-captcha-length'),

  silentEnabled: document.getElementById('opt-silent-enabled'),
  silentPanel: document.getElementById('silent-panel'),
  silentEntry: document.getElementById('opt-silent-entry'),
  silentMax: document.getElementById('opt-silent-max'),
  silentInterval: document.getElementById('opt-silent-interval'),
  silentTarget: document.getElementById('opt-silent-target'),
  silentOpen: document.getElementById('opt-silent-open'),
  silentStopCred: document.getElementById('opt-silent-stop-cred'),
  silentAutoStart: document.getElementById('opt-silent-autostart'),
  silentOcrWarning: document.getElementById('silent-ocr-warning'),

  overlay: document.getElementById('opt-overlay'),
  notify: document.getElementById('opt-notify'),
  dismissSec: document.getElementById('opt-dismiss-sec'),

  debug: document.getElementById('opt-debug'),
  exportRadios: Array.from(document.querySelectorAll('input[name="export-mode"]')),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  resetBtn: document.getElementById('reset-btn'),

  version: document.getElementById('about-version'),
};

/** 上一次填进表单的值：空白输入框回退到它，避免把「清空」误当成 0 或 NaN */
let lastFilled = null;
/** 表单是否有未保存修改 */
let dirty = false;
let toastTimer = null;
let saving = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function errorText(error) {
  return String(error?.message ?? error ?? '未知错误');
}

function showToast(message, tone = 'success') {
  if (!els.toast) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  els.toast.textContent = String(message ?? '');
  els.toast.dataset.tone = tone;
  els.toast.hidden = false;
  toastTimer = setTimeout(
    () => {
      toastTimer = null;
      els.toast.hidden = true;
    },
    tone === 'error' ? TOAST_ERROR_MS : TOAST_SUCCESS_MS,
  );
}

function setDirty(value) {
  dirty = Boolean(value);
  if (!els.savebar) return;
  els.savebar.textContent = dirty ? '有未保存的修改' : '修改后记得保存';
  els.savebar.dataset.dirty = dirty ? 'true' : 'false';
}

/**
 * 标记未保存。
 * 表单里也有「只影响本次操作」的控件（导出方式单选），它们不该让保存条变成待保存状态，
 * 这类控件统一用 data-nosave 标记。
 */
function markDirty(event) {
  const target = event?.target;
  if (target instanceof Element && target.closest('[data-nosave]')) return;
  if (!dirty) setDirty(true);
}

function readText(input) {
  return String(input?.value ?? '');
}

function readInt(input, fallback) {
  const raw = readText(input).trim();
  if (!raw) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.round(num) : NaN;
}

function readFloat(input, fallback) {
  const raw = readText(input).trim();
  if (!raw) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

/** 秒 → 毫秒；表单用秒更好读，存储统一用毫秒 */
function secondsToMs(seconds) {
  return Math.round(seconds * 1000);
}

function msToSeconds(ms) {
  return Math.round((Number(ms) || 0) / 100) / 10;
}

/** 切到「显示/隐藏」时只改视觉与 aria，按钮里的 svg 图标保持不变 */
function setPasswordVisible(visible) {
  if (!els.password || !els.passwordToggle) return;
  els.password.type = visible ? 'text' : 'password';
  els.passwordToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
  els.passwordToggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  els.passwordToggle.title = visible ? '隐藏密码' : '显示密码';
  const label = els.passwordToggle.querySelector('.addon-text');
  if (label) label.textContent = visible ? '隐藏' : '显示';
}

// ---------------------------------------------------------------------------
// 服务器地址列表
// ---------------------------------------------------------------------------
function createServerRow(value) {
  const row = document.createElement('div');
  row.className = 'server-row';

  const input = document.createElement('input');
  input.className = 'input server-input';
  input.type = 'text';
  input.value = String(value ?? '');
  input.placeholder = 'jwgl.nxu.edu.cn';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '服务器地址');
  input.addEventListener('input', markDirty);

  const badge = document.createElement('span');
  badge.className = 'server-badge';
  badge.textContent = '主地址';

  const remove = document.createElement('button');
  remove.className = 'server-remove';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = '删除该地址';
  remove.setAttribute('aria-label', '删除该服务器地址');
  remove.addEventListener('click', () => {
    row.remove();
    markDirty();
    syncServerRows();
  });

  row.append(input, badge, remove);
  return row;
}

/** 只有一个地址时不允许删光：登录流程需要至少一个入口 */
function syncServerRows() {
  if (!els.serverList) return;
  const rows = Array.from(els.serverList.children);
  rows.forEach((row, index) => {
    const badge = row.querySelector('.server-badge');
    if (badge) badge.hidden = index !== 0;
    const remove = row.querySelector('.server-remove');
    if (remove) remove.disabled = rows.length <= 1;
  });
}

function renderServers(urls) {
  if (!els.serverList) return;
  const list = Array.isArray(urls) && urls.length > 0 ? urls : [...DEFAULT_SERVER_URLS];
  els.serverList.replaceChildren();
  for (const url of list) els.serverList.appendChild(createServerRow(url));
  syncServerRows();
}

function addServerRow(value = '') {
  if (!els.serverList) return null;
  const row = createServerRow(value);
  els.serverList.appendChild(row);
  syncServerRows();
  markDirty();
  row.querySelector('.server-input')?.focus();
  return row;
}

function collectServerOrigins() {
  if (!els.serverList) return [];
  return Array.from(els.serverList.querySelectorAll('.server-input'))
    .map((input) => readText(input))
    .filter((raw) => raw.trim() !== '');
}

function renderMirrorHints() {
  if (!els.mirrorHints) return;
  const details = els.mirrorHints.closest('details');
  // 没有候选地址时整块折叠起来，避免展示一个永远为空的「常见备用地址」
  if (KNOWN_MIRROR_HINTS.length === 0) {
    els.mirrorHints.replaceChildren();
    if (details) details.hidden = true;
    return;
  }
  if (details) details.hidden = false;
  els.mirrorHints.replaceChildren();
  // 只把「还没加进列表」的地址做成可点 chip，避免重复添加
  const existing = new Set(
    collectServerOrigins()
      .map((raw) => normalizeOrigin(raw))
      .filter(Boolean),
  );
  for (const hint of KNOWN_MIRROR_HINTS) {
    const button = document.createElement('button');
    button.className = 'chip';
    button.type = 'button';
    button.textContent = hint.replace(/^https?:\/\//, '');
    button.title = `填入 ${hint}`;
    button.disabled = existing.has(normalizeOrigin(hint));
    button.addEventListener('click', () => {
      const emptyRow = Array.from(els.serverList?.querySelectorAll('.server-input') ?? []).find(
        (input) => readText(input).trim() === '',
      );
      if (emptyRow) {
        emptyRow.value = hint;
        markDirty();
        syncServerRows();
        renderMirrorHints();
        return;
      }
      addServerRow(hint);
      renderMirrorHints();
    });
    els.mirrorHints.appendChild(button);
  }
}

// ---------------------------------------------------------------------------
// 验证码面板
// ---------------------------------------------------------------------------
function currentProvider() {
  const checked = els.providerRadios.find((radio) => radio.checked);
  return checked?.value ?? OCR_PROVIDERS.MANUAL;
}

function updateProviderPanels() {
  const provider = currentProvider();
  const isBaidu = provider === OCR_PROVIDERS.BAIDU;
  const isRemote = provider === OCR_PROVIDERS.REMOTE;

  if (els.baiduPanel) els.baiduPanel.hidden = !isBaidu;
  if (els.remotePanel) els.remotePanel.hidden = !isRemote;
  if (els.manualNote) els.manualNote.hidden = provider !== OCR_PROVIDERS.MANUAL;
  if (els.ocrTestResult) {
    els.ocrTestResult.textContent = '';
    delete els.ocrTestResult.dataset.tone;
  }
  // OCR 方式变了会影响静默模式的可行性，提示要同步刷新
  updateSilentPanel();
}

/**
 * 静默模式面板：开关联动字段可用性 + OCR 前置条件提示。
 * 用 disabled 而不是隐藏，用户能一眼看到「还差什么」。
 */
function updateSilentPanel() {
  if (!els.silentEnabled) return;
  const enabled = els.silentEnabled.checked;
  if (els.silentPanel) {
    els.silentPanel.hidden = false;
    els.silentPanel.dataset.disabled = enabled ? 'false' : 'true';
    for (const el of els.silentPanel.querySelectorAll('input')) {
      if (el === els.silentEnabled) continue;
      el.disabled = !enabled;
    }
  }
  if (els.silentOcrWarning) {
    els.silentOcrWarning.hidden = !(enabled && currentProvider() === OCR_PROVIDERS.MANUAL);
  }
}

// ---------------------------------------------------------------------------
// 填表 / 取表
// ---------------------------------------------------------------------------
/**
 * 把设置填进表单，同时记下「这一份表单值」作为空白输入框的兜底。
 */
function fillForm(settings) {
  const next = deepMerge(DEFAULT_SETTINGS, settings ?? {});
  lastFilled = next;

  if (els.username) els.username.value = next.credentials?.username ?? '';
  if (els.password) els.password.value = next.credentials?.password ?? '';
  if (els.password && els.passwordToggle) {
    // 每次重填都回到隐藏状态，避免导入配置后密码明文露在外面
    setPasswordVisible(false);
  }

  renderServers(next.serverUrls);

  for (const radio of els.providerRadios) {
    radio.checked = radio.value === next.ocr.provider;
  }
  if (els.baiduKey) els.baiduKey.value = next.ocr.baidu.apiKey ?? '';
  if (els.baiduSecret) els.baiduSecret.value = next.ocr.baidu.secretKey ?? '';
  if (els.remoteEndpoint) els.remoteEndpoint.value = next.ocr.remote.endpoint ?? '';
  if (els.remoteMethod) els.remoteMethod.value = next.ocr.remote.method === 'GET' ? 'GET' : 'POST';
  if (els.remoteField) els.remoteField.value = next.ocr.remote.fieldName ?? 'image';
  if (els.remotePath) els.remotePath.value = next.ocr.remote.responsePath ?? 'result';
  updateProviderPanels();

  if (els.enabled) els.enabled.checked = Boolean(next.enabled);
  if (els.autoSubmit) els.autoSubmit.checked = Boolean(next.autoSubmit);
  if (els.maxAttempts) els.maxAttempts.value = String(next.captcha.maxAttempts);
  if (els.delaySec) els.delaySec.value = String(msToSeconds(next.captcha.delayMs));
  if (els.solveTimeoutSec) els.solveTimeoutSec.value = String(Math.round(next.captcha.solveTimeoutMs / 1000));
  if (els.startDelay) els.startDelay.value = String(next.advanced.startDelayMs);
  if (els.captchaLength) els.captchaLength.value = String(next.captcha.length);

  if (els.overlay) els.overlay.checked = Boolean(next.ui.showOverlay);
  if (els.notify) els.notify.checked = Boolean(next.ui.notifyOnSuccess);
  if (els.dismissSec) els.dismissSec.value = String(Math.round(next.ui.autoDismissMs / 1000));

  if (els.debug) els.debug.checked = Boolean(next.advanced.debug);

  const silent = next.silent ?? {};
  if (els.silentEnabled) els.silentEnabled.checked = Boolean(silent.enabled);
  if (els.silentEntry) els.silentEntry.value = silent.entryUrl ?? '';
  if (els.silentMax) els.silentMax.value = String(silent.maxAttempts ?? 200);
  if (els.silentInterval) els.silentInterval.value = String(silent.intervalMs ?? 800);
  if (els.silentTarget) els.silentTarget.value = silent.targetPath ?? '';
  if (els.silentOpen) els.silentOpen.checked = silent.openOnSuccess !== false;
  if (els.silentStopCred) els.silentStopCred.checked = silent.stopOnCredentialError !== false;
  if (els.silentAutoStart) els.silentAutoStart.checked = Boolean(silent.autoStart);
  updateSilentPanel();

  if (els.permissionWarning) {
    els.permissionWarning.hidden = true;
    els.permissionWarning.textContent = '';
  }
  renderMirrorHints();
  setDirty(false);
}

/**
 * 从表单取值。返回的是 PATCH_SETTINGS 的 payload：
 * 只覆盖界面上有的字段，captcha.mode、ocr.remote.headers 这类隐藏项由 deepMerge 保留。
 */
function collectForm() {
  const provider = currentProvider();
  const username = readText(els.username).trim();
  const password = readText(els.password);

  const maxAttempts = readInt(els.maxAttempts, lastFilled?.captcha?.maxAttempts ?? 5);
  const delaySec = readFloat(els.delaySec, msToSeconds(lastFilled?.captcha?.delayMs ?? 1200));
  const solveTimeoutSec = readInt(els.solveTimeoutSec, Math.round((lastFilled?.captcha?.solveTimeoutMs ?? 120000) / 1000));
  const startDelay = readInt(els.startDelay, lastFilled?.advanced?.startDelayMs ?? 400);
  const captchaLength = readInt(els.captchaLength, lastFilled?.captcha?.length ?? 0);
  const dismissSec = readInt(els.dismissSec, Math.round((lastFilled?.ui?.autoDismissMs ?? 8000) / 1000));

  return {
    enabled: Boolean(els.enabled?.checked),
    autoSubmit: Boolean(els.autoSubmit?.checked),
    serverUrls: collectServerOrigins().map((raw) => normalizeOrigin(raw)),
    credentials: { username, password },
    captcha: {
      maxAttempts,
      delayMs: Number.isFinite(delaySec) ? secondsToMs(delaySec) : delaySec,
      solveTimeoutMs: Number.isFinite(solveTimeoutSec) ? secondsToMs(solveTimeoutSec) : solveTimeoutSec,
      length: captchaLength,
    },
    ocr: {
      provider,
      baidu: {
        apiKey: readText(els.baiduKey).trim(),
        secretKey: readText(els.baiduSecret).trim(),
      },
      remote: {
        endpoint: readText(els.remoteEndpoint).trim(),
        method: els.remoteMethod?.value === 'GET' ? 'GET' : 'POST',
        fieldName: readText(els.remoteField).trim() || 'image',
        responsePath: readText(els.remotePath).trim() || 'result',
      },
    },
    ui: {
      showOverlay: Boolean(els.overlay?.checked),
      notifyOnSuccess: Boolean(els.notify?.checked),
      autoDismissMs: Number.isFinite(dismissSec) ? secondsToMs(dismissSec) : dismissSec,
    },
    advanced: {
      startDelayMs: startDelay,
      debug: Boolean(els.debug?.checked),
    },
    silent: {
      enabled: Boolean(els.silentEnabled?.checked),
      // 原样保留用户粘贴的完整地址（含 WebVPN 的 /https-443/<hex>/ 前缀）
      entryUrl: readText(els.silentEntry).trim(),
      maxAttempts: readInt(els.silentMax, lastFilled?.silent?.maxAttempts ?? 200),
      intervalMs: readInt(els.silentInterval, lastFilled?.silent?.intervalMs ?? 800),
      targetPath: readText(els.silentTarget).trim(),
      openOnSuccess: Boolean(els.silentOpen?.checked),
      stopOnCredentialError: Boolean(els.silentStopCred?.checked),
      autoStart: Boolean(els.silentAutoStart?.checked),
    },
    // 记录原始输入，便于校验时给出「哪个地址写错了」而不是干巴巴的报错
    _raw: { username, password, provider, serverUrls: collectServerOrigins() },
  };
}

/**
 * 校验。返回 [{ message, el }]，空数组表示通过。
 * 只校验会导致「打开扩展就必然失败」的问题，细枝末节交给 normalizeSettings 兜底。
 */
function validate(patch) {
  const problems = [];
  const add = (message, el) => problems.push({ message, el });

  if (!Number.isFinite(patch.captcha.maxAttempts) || patch.captcha.maxAttempts < 1 || patch.captcha.maxAttempts > 20) {
    add('「最多尝试次数」需要是 1 – 20 之间的整数', els.maxAttempts);
  }
  if (!Number.isFinite(patch.captcha.delayMs) || patch.captcha.delayMs < 500 || patch.captcha.delayMs > 5000) {
    add('「重试间隔」需要是 0.5 – 5 秒之间的数字', els.delaySec);
  }
  if (!Number.isFinite(patch.captcha.solveTimeoutMs) || patch.captcha.solveTimeoutMs < 5000 || patch.captcha.solveTimeoutMs > 600000) {
    add('「人工输入验证码超时」需要是 5 – 600 秒之间的整数', els.solveTimeoutSec);
  }
  if (!Number.isFinite(patch.advanced.startDelayMs) || patch.advanced.startDelayMs < 0 || patch.advanced.startDelayMs > 15000) {
    add('「启动延迟」需要是 0 – 15000 毫秒之间的整数', els.startDelay);
  }
  if (!Number.isFinite(patch.captcha.length) || patch.captcha.length < 0 || patch.captcha.length > 12) {
    add('「验证码长度」需要是 0 – 12 之间的整数（0 表示自动探测）', els.captchaLength);
  }
  if (!Number.isFinite(patch.ui.autoDismissMs) || patch.ui.autoDismissMs < 0 || patch.ui.autoDismissMs > 60000) {
    add('「成功提示自动隐藏」需要是 0 – 60 秒之间的数字', els.dismissSec);
  }

  // 地址：允许只写域名/IP，normalizeOrigin 会补 https://；补不出来才算错
  const rawUrls = patch._raw.serverUrls;
  if (rawUrls.length === 0) {
    add('至少保留一个服务器地址', els.serverList?.querySelector('.server-input'));
  } else {
    const invalid = rawUrls.filter((raw) => !normalizeOrigin(raw));
    if (invalid.length > 0) {
      add(`服务器地址格式不正确：${invalid.join('、')}`, els.serverList?.querySelector('.server-input'));
    }
    const unique = new Set(patch.serverUrls.filter(Boolean));
    if (unique.size === 0) add('服务器地址格式不正确', els.serverList?.querySelector('.server-input'));
  }

  // 开着自动登录却没有账号，等于每次打开页面都必然失败，所以在保存这一步就拦住
  if (patch.enabled) {
    if (!patch.credentials.username) add('启用自动登录前请填写学号', els.username);
    if (!patch.credentials.password) add('启用自动登录前请填写密码', els.password);
  }

  if (patch.ocr.provider === OCR_PROVIDERS.BAIDU) {
    if (!patch.ocr.baidu.apiKey) add('百度 OCR 需要填写 API Key', els.baiduKey);
    if (!patch.ocr.baidu.secretKey) add('百度 OCR 需要填写 Secret Key', els.baiduSecret);
  }

  if (patch.ocr.provider === OCR_PROVIDERS.REMOTE) {
    const problem = validateRemoteEndpoint(patch.ocr.remote.endpoint);
    if (problem) add(problem, els.remoteEndpoint);
  }

  // 静默模式的前置条件：必须能自动识别验证码，且入口地址可解析
  const silent = patch.silent;
  if (silent?.enabled) {
    if (patch.ocr.provider === OCR_PROVIDERS.MANUAL) {
      add('后台请求模式需要自动识别验证码，请把「验证码识别」改为百度 OCR 或自建服务', els.silentEnabled);
    }
    const entry = silent.entryUrl || `${String(patch.serverUrls[0] ?? '').replace(/\/+$/, '')}/index.action`;
    const entryProblem = validateEntryUrl(entry);
    if (entryProblem) add(entryProblem, els.silentEntry);
    if (!Number.isFinite(silent.maxAttempts) || silent.maxAttempts < 1 || silent.maxAttempts > 5000) {
      add('「最多请求次数」需要是 1 – 5000 之间的整数', els.silentMax);
    }
    if (!Number.isFinite(silent.intervalMs) || silent.intervalMs < 100 || silent.intervalMs > 60000) {
      add('「请求间隔」需要是 100 – 60000 毫秒之间的整数', els.silentInterval);
    }
  }

  return problems;
}

/**
 * 登录入口地址校验。
 * 与服务器地址不同，这里必须接受「带路径」的地址（WebVPN 前缀），
 * 所以不能用 normalizeOrigin 判断，否则会把合法地址判成错误。
 */
function validateEntryUrl(entry) {
  if (!entry) return '';
  let parsed;
  try {
    parsed = new URL(entry);
  } catch {
    return '「登录入口地址」不是合法 URL，请把浏览器地址栏里能打开的那个登录页地址完整粘进来';
  }
  if (!/^https?:$/.test(parsed.protocol)) return '「登录入口地址」必须是 http(s) 地址';
  return '';
}

/** 自建 OCR 的 endpoint 必须是可用的绝对 URL；抽成独立函数便于「测试识别服务」单独校验 */
function validateRemoteEndpoint(endpoint) {
  if (!endpoint) return '自建 OCR 服务需要填写 endpoint';
  if (!/^https?:\/\/[^/\s]+/i.test(endpoint)) return 'OCR endpoint 必须是 http(s):// 开头的合法地址';
  try {
    new URL(endpoint);
  } catch {
    return 'OCR endpoint 不是合法 URL';
  }
  return '';
}

// ---------------------------------------------------------------------------
// 权限：必须在用户手势里发起
// ---------------------------------------------------------------------------
/** 兼容 promise / callback 两种返回形式 */
function callPermissionsRequest(patterns) {
  return new Promise((resolve, reject) => {
    try {
      const returned = chrome.permissions.request({ origins: patterns }, (granted) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(Boolean(granted));
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((granted) => resolve(Boolean(granted)), (error) => reject(error ?? new Error('权限申请失败')));
      }
    } catch (error) {
      reject(error);
    }
  });
}

function callPermissionsContains(origin) {
  const pattern = permissionPattern(origin);
  if (!pattern) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [pattern] }, (granted) => {
        // 读 lastError 以消掉 "Unchecked runtime.lastError" 的告警
        void chrome.runtime.lastError;
        resolve(Boolean(granted));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * 计算需要申请的权限。
 *
 * 除了备用服务器地址，自建 OCR 的 endpoint 也必须授权：service worker 里 fetch
 * 跨域请求受扩展 host_permissions 约束，没有权限时会直接失败。
 * 默认域名已在 manifest 的 host_permissions 中，跳过以免多余的授权提示。
 */
function permissionOriginsFor(patch) {
  const excluded = new Set([DEFAULT_ORIGIN]);
  const servers = uniqOrigins(patch.serverUrls).filter((origin) => !excluded.has(origin));

  const ocr = [];
  if (patch.ocr.provider === OCR_PROVIDERS.REMOTE && patch.ocr.remote.endpoint) {
    const origin = normalizeOrigin(patch.ocr.remote.endpoint);
    if (origin && !excluded.has(origin)) ocr.push(origin);
  }

  return {
    servers,
    ocr,
    // 一次系统弹框里申请全部，避免连续弹两次
    all: [...new Set([...servers, ...ocr])],
  };
}

function uniqOrigins(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((origin) => typeof origin === 'string' && origin))];
}

/**
 * Chrome 的 match pattern 不支持端口（`https://host:8080/*` 是非法值），
 * 但 host 权限不带端口时本就覆盖该主机的所有端口，所以这里统一去掉端口。
 */
function permissionPattern(origin) {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return '';
  }
}

/**
 * 申请一批 origin 的访问权限，返回未获授权的 origin 列表。
 *
 * 关键点：chrome.permissions.request 必须在用户手势的有效期内调用，而
 * - 经 chrome.runtime.sendMessage 转给 service worker 后，手势通常已经失效；
 * - 任何 await 都可能把调用栈让出去。
 * 所以这里由调用方在 submit 处理器里同步调用，直接使用扩展页面自己的
 * chrome.permissions API；只有直接调用抛错时才退回 MSG.REQUEST_ORIGIN 让后台再试。
 */
function requestOrigins(origins) {
  if (!origins || origins.length === 0) return Promise.resolve([]);

  const patterns = [...new Set(origins.map(permissionPattern).filter(Boolean))];
  if (patterns.length === 0) return Promise.resolve(origins);

  return callPermissionsRequest(patterns)
    .then(async (grantedAll) => {
      if (grantedAll) return [];
      // 用户拒绝时逐个核对真实状态，避免把「只有一个没授权」说成全部没授权
      const denied = [];
      for (const origin of origins) {
        if (!(await callPermissionsContains(origin))) denied.push(origin);
      }
      return denied;
    })
    .catch(async (error) => {
      console.warn('[jwgl] 直接申请权限失败，改为经后台申请：', error);
      const denied = [];
      for (const origin of origins) {
        try {
          const result = await api.requestOrigin(origin);
          if (!result?.granted) denied.push(origin);
        } catch (requestError) {
          console.warn(`[jwgl] 申请 ${origin} 权限失败：`, requestError);
          denied.push(origin);
        }
      }
      return denied;
    });
}

function showPermissionWarning(deniedServers, deniedOcr) {
  if (!els.permissionWarning) return;
  const parts = [];
  if (deniedServers.length > 0) {
    parts.push(`未授权，将无法在该地址自动登录：${deniedServers.join('、')}`);
  }
  if (deniedOcr.length > 0) {
    parts.push(`未授权 OCR 服务地址：${deniedOcr.join('、')}，识别与「测试识别服务」都会失败`);
  }

  if (parts.length === 0) {
    els.permissionWarning.hidden = true;
    els.permissionWarning.textContent = '';
    return;
  }
  els.permissionWarning.hidden = false;
  els.permissionWarning.textContent = `${parts.join('；')}。可以重新保存并允许，或在 chrome://extensions 的「网站访问权限」里手动开启。`;
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
function setSaving(value) {
  saving = value;
  if (els.save) {
    els.save.disabled = value;
    els.save.textContent = value ? '保存中…' : '保存设置';
  }
  if (els.ocrTest) els.ocrTest.disabled = value;
}

/**
 * 保存入口。刻意不是 async：校验和权限申请都必须在同一次用户手势内完成，
 * 一旦 await 就可能丢掉手势，Chrome 会直接拒绝弹权限框。
 */
function handleSave(event) {
  event.preventDefault();
  if (saving) return;

  const patch = collectForm();
  const problems = validate(patch);
  if (problems.length > 0) {
    showToast(problems[0].message, 'error');
    problems[0].el?.focus?.();
    return;
  }

  // 同步发起权限申请（此处仍在 click 手势内），再交给异步流程保存
  const needed = permissionOriginsFor(patch);
  const permissionPromise = requestOrigins(needed.all).catch((error) => {
    console.warn('[jwgl] 权限申请流程异常：', error);
    return needed.all;
  });

  void commitSave(patch, needed, permissionPromise);
}

async function commitSave(patch, needed, permissionPromise) {
  setSaving(true);
  try {
    // _raw 只是本地校验用的临时字段，不能写进 storage
    const { _raw, ...payload } = patch;
    const saved = await api.patchSettings(payload);
    fillForm(saved);
    showToast('已保存');
  } catch (error) {
    showToast(`保存失败：${errorText(error)}`, 'error');
    return;
  } finally {
    setSaving(false);
  }

  // 保存成功之后再报告权限结果：设置落盘是主操作，授权失败不该让用户以为没保存
  try {
    const denied = await permissionPromise;
    const deniedServers = denied.filter((origin) => needed.servers.includes(origin));
    const deniedOcr = denied.filter((origin) => needed.ocr.includes(origin));
    showPermissionWarning(deniedServers, deniedOcr);
    if (deniedServers.length > 0) {
      showToast('设置已保存，但部分服务器地址未授权，无法在这些地址自动登录', 'error');
    } else if (deniedOcr.length > 0) {
      showToast('设置已保存，但 OCR 服务地址未授权，识别可能失败', 'error');
    }
  } catch (error) {
    console.warn('[jwgl] 读取授权结果失败：', error);
  }
}

// ---------------------------------------------------------------------------
// OCR 自检
// ---------------------------------------------------------------------------
/**
 * 「测试识别服务」入口。同样不是 async：自建 OCR 需要 endpoint 的访问权限，
 * 而权限请求必须在 click 手势内同步发起，所以先拿权限再测。
 */
function handleOcrTestClick() {
  if (!els.ocrTest || saving) return;
  const provider = currentProvider();
  const patch = collectForm();

  if (provider === OCR_PROVIDERS.BAIDU) {
    if (!patch.ocr.baidu.apiKey || !patch.ocr.baidu.secretKey) {
      showToast('请先填写百度 OCR 的 API Key 与 Secret Key', 'error');
      (patch.ocr.baidu.apiKey ? els.baiduSecret : els.baiduKey)?.focus();
      return;
    }
  }
  if (provider === OCR_PROVIDERS.REMOTE) {
    const problem = validateRemoteEndpoint(patch.ocr.remote.endpoint);
    if (problem) {
      showToast(problem, 'error');
      els.remoteEndpoint?.focus();
      return;
    }
  }

  const needed = permissionOriginsFor(patch);
  const permissionPromise = requestOrigins(needed.ocr).catch((error) => {
    console.warn('[jwgl] OCR 服务权限申请异常：', error);
    return needed.ocr;
  });

  void runOcrTest(patch, needed.ocr, permissionPromise);
}

async function runOcrTest(patch, ocrOrigins, permissionPromise) {
  els.ocrTest.disabled = true;
  els.ocrTest.textContent = '测试中…';
  if (els.ocrTestResult) {
    els.ocrTestResult.textContent = '';
    delete els.ocrTestResult.dataset.tone;
  }

  try {
    // 后台测试读的是已落盘的设置，所以先把当前 OCR 配置存进去；
    // 否则会出现「测的其实是旧配置」这种难以理解的失败。
    await api.patchSettings({ ocr: patch.ocr });
    lastFilled = deepMerge(lastFilled ?? DEFAULT_SETTINGS, { ocr: patch.ocr });

    const denied = await permissionPromise;
    const deniedOcr = denied.filter((origin) => ocrOrigins.includes(origin));
    if (deniedOcr.length > 0) {
      const message = `未授权 OCR 服务地址：${deniedOcr.join('、')}，无法连接`;
      if (els.ocrTestResult) {
        els.ocrTestResult.textContent = message;
        els.ocrTestResult.dataset.tone = 'error';
      }
      showToast(message, 'error');
      return;
    }

    const result = await api.ocrTest();
    const detail = result?.detail || '服务可用';
    if (els.ocrTestResult) {
      els.ocrTestResult.textContent = detail;
      els.ocrTestResult.dataset.tone = 'ok';
    }
    showToast('识别服务正常', 'success');
  } catch (error) {
    const message = errorText(error);
    if (els.ocrTestResult) {
      els.ocrTestResult.textContent = message;
      els.ocrTestResult.dataset.tone = 'error';
    }
    showToast(`测试失败：${message}`, 'error');
  } finally {
    els.ocrTest.disabled = false;
    els.ocrTest.textContent = '测试识别服务';
  }
}

// ---------------------------------------------------------------------------
// 导入 / 导出 / 恢复默认
// ---------------------------------------------------------------------------
function buildExportPayload(includeSecrets) {
  // collectForm 带 _raw（原始输入，含明文密码），导出前必须剔除，否则脱敏形同虚设
  const { _raw, ...collected } = collectForm();
  const settings = normalizeSettings(deepMerge(DEFAULT_SETTINGS, collected));

  if (!includeSecrets) {
    settings.credentials.password = '';
    settings.ocr.baidu.apiKey = '';
    settings.ocr.baidu.secretKey = '';
  }

  return {
    app: 'jwgl-auto-login',
    kind: 'settings',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    redacted: !includeSecrets,
    settings,
  };
}

function handleExport() {
  const includeSecrets = els.exportRadios.some((radio) => radio.value === 'full' && radio.checked);
  const payload = buildExportPayload(includeSecrets);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `jwgl-settings-${stamp}${includeSecrets ? '' : '-redacted'}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(includeSecrets ? '已导出（含敏感信息，请妥善保管）' : '已导出（已脱敏）', includeSecrets ? 'info' : 'success');
  } catch (error) {
    showToast(`导出失败：${errorText(error)}`, 'error');
  } finally {
    // revoke 放在下一个任务，确保下载已经开始
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function handleImportFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('文件不是合法的 JSON');
    }

    const source = parsed?.settings ?? parsed;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('文件里没有找到设置内容');
    }

    const merged = normalizeSettings(deepMerge(DEFAULT_SETTINGS, source));
    fillForm(merged);
    setDirty(true);
    showToast('已导入，点击「保存设置」后生效', 'info');
  } catch (error) {
    showToast(`导入失败：${errorText(error)}`, 'error');
  } finally {
    // 清空 value，否则连续导入同一个文件不会再触发 change
    if (els.importFile) els.importFile.value = '';
  }
}

function handleReset() {
  const confirmed = window.confirm('恢复默认设置只会重置表单，点击「保存设置」后才会真正生效。继续吗？');
  if (!confirmed) return;
  fillForm(deepMerge(DEFAULT_SETTINGS, {}));
  setDirty(true);
  showToast('已填入默认值，点击「保存设置」后生效', 'info');
}

// ---------------------------------------------------------------------------
// 事件绑定 / 初始化
// ---------------------------------------------------------------------------
function bindEvents() {
  els.form?.addEventListener('submit', handleSave);
  els.form?.addEventListener('input', markDirty);
  els.form?.addEventListener('change', markDirty);

  els.passwordToggle?.addEventListener('click', () => {
    if (!els.password) return;
    setPasswordVisible(els.password.type === 'password');
  });

  els.serverAdd?.addEventListener('click', () => {
    addServerRow('');
    renderMirrorHints();
  });

  // 手改地址后要让「常见备用地址」chip 的可用状态跟上，避免重复添加
  els.serverList?.addEventListener('change', renderMirrorHints);

  for (const radio of els.providerRadios) {
    radio.addEventListener('change', () => {
      updateProviderPanels();
      markDirty();
    });
  }

  els.ocrTest?.addEventListener('click', handleOcrTestClick);

  els.silentEnabled?.addEventListener('change', () => {
    updateSilentPanel();
    markDirty();
  });

  els.exportBtn?.addEventListener('click', handleExport);
  els.importBtn?.addEventListener('click', () => els.importFile?.click());
  els.importFile?.addEventListener('change', (event) => void handleImportFile(event));
  els.resetBtn?.addEventListener('click', handleReset);

  // 离开页面前提醒未保存，避免长表单白填
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function renderVersion() {
  if (!els.version) return;
  try {
    els.version.textContent = chrome.runtime.getManifest().version;
  } catch {
    els.version.textContent = '—';
  }
}

async function init() {
  bindEvents();
  renderVersion();
  // 让「权限申请」的用途在点击前就写清楚，而不是等系统弹框才解释
  if (els.permissionNote) {
    els.permissionNote.hidden = false;
  }

  try {
    const settings = await api.getSettings();
    fillForm(settings);
  } catch (error) {
    showToast(`读取设置失败：${errorText(error)}`, 'error');
    fillForm(DEFAULT_SETTINGS);
  }
}

void init();

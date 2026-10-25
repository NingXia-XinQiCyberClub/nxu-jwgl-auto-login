/**
 * chrome.storage.local 封装：默认值补齐、深合并、订阅变更。
 * 只做存取，不含业务逻辑。
 */

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  DEFAULT_SERVER_URLS,
  MAX_LOG_ENTRIES,
  MAX_CAPTCHA_DATA_URL_LENGTH,
} from './constants.js';

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 深合并：用 patch 覆盖 base，undefined 不覆盖，数组整体替换。
 * @param {object} base
 * @param {object} patch
 * @returns {object}
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(base);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* 含不可克隆对象时退回 JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

async function readKey(key) {
  const result = await chrome.storage.local.get(key);
  return result?.[key];
}

export async function getSettings() {
  const stored = await readKey(STORAGE_KEYS.SETTINGS);
  let settings = deepMerge(DEFAULT_SETTINGS, stored ?? {});
  // 旧数据/空数组兜底
  if (!Array.isArray(settings.serverUrls) || settings.serverUrls.length === 0) {
    settings.serverUrls = [...DEFAULT_SETTINGS.serverUrls];
  }
  settings = normalizeSettings(settings);
  return settings;
}

export async function setSettings(settings) {
  const normalized = normalizeSettings(deepMerge(DEFAULT_SETTINGS, settings ?? {}));
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: normalized });
  return normalized;
}

export async function patchSettings(patch) {
  const current = await getSettings();
  return setSettings(deepMerge(current, patch));
}

export async function getState() {
  const stored = await readKey(STORAGE_KEYS.STATE);
  return deepMerge(DEFAULT_STATE, stored ?? {});
}

/**
 * storage 的「读—改—写」串行队列。
 *
 * chrome.storage.local 没有原子更新，而页面、popup、service worker 会同时写状态：
 * 「写 success」和「追加一条日志」几乎同一刻发生时，两边读到的是同一份旧值，
 * 后写的一方会把前一方整个结果覆盖掉——表现就是状态对了但日志丢了、或反过来。
 * 所有改状态的入口都串到一条链上，代价只是几毫秒，换来的是不丢更新。
 */
let stateWriteChain = Promise.resolve();

function withStateLock(task) {
  const run = stateWriteChain.then(task, task);
  // 吞掉错误以免一次失败卡死整条链，真实错误仍由 run 的返回值抛给调用方
  stateWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function setState(state) {
  return withStateLock(async () => {
    const next = deepMerge(DEFAULT_STATE, state ?? {});
    next.logs = trimLogs(next.logs);
    // stateAt 记录「这条状态产生于何时」，而不是「何时落盘」：
    // 页面在导航前发出的旧消息可能晚到，必须能按产生时刻判断新旧并丢弃。
    next.stateAt = Number(next.stateAt) || Date.now();
    await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: next });
    return next;
  });
}

export function patchState(patch) {
  return withStateLock(async () => {
    const current = await getState();
    const next = deepMerge(current, patch);
    next.logs = trimLogs(next.logs);
    next.stateAt = Number(patch?.stateAt) || Date.now();
    await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: next });
    return next;
  });
}

export function resetState() {
  return setState(DEFAULT_STATE);
}

/**
 * 追加日志并落盘，返回最新状态。
 * @param {string} message
 * @param {'info'|'warn'|'error'|'success'} [level]
 */
export function appendLog(message, level = 'info') {
  return withStateLock(async () => {
    const state = await getState();
    const logs = trimLogs([...state.logs, { at: Date.now(), level, message: String(message) }]);
    const next = { ...state, logs };
    if (level === 'error') next.lastError = String(message);
    // 追加日志不改变状态本身的时间戳，否则会把一条旧页面的迟到消息「变新」
    next.stateAt = Number(state.stateAt) || Date.now();
    await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: next });
    return next;
  });
}

function trimLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(-MAX_LOG_ENTRIES);
}

/**
 * 存放待人工输入的验证码，超长则丢弃 dataURL 只留标记。
 */
export async function setPendingCaptcha(dataUrl) {
  const safe = typeof dataUrl === 'string' && dataUrl.length <= MAX_CAPTCHA_DATA_URL_LENGTH ? dataUrl : '';
  return patchState({ pendingCaptcha: safe, pendingCaptchaAt: Date.now() });
}

/**
 * 订阅设置/状态变化。
 * @param {(changes: {settings?: object, state?: object}) => void} callback
 * @returns {() => void} 取消订阅
 */
export function onStorageChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    const payload = {};
    if (changes[STORAGE_KEYS.SETTINGS]) payload.settings = changes[STORAGE_KEYS.SETTINGS].newValue;
    if (changes[STORAGE_KEYS.STATE]) payload.state = changes[STORAGE_KEYS.STATE].newValue;
    if (Object.keys(payload).length > 0) callback(payload);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * 规范化设置：去空白、补协议、去重、裁剪数值范围。
 */
export function normalizeSettings(settings) {
  const next = deepMerge(DEFAULT_SETTINGS, settings);

  next.serverUrls = uniq(
    (Array.isArray(next.serverUrls) ? next.serverUrls : [])
      .map(normalizeOrigin)
      .filter((url) => /^https?:\/\/[^/]/i.test(url)),
  );
  if (next.serverUrls.length === 0) next.serverUrls = [...DEFAULT_SERVER_URLS];

  next.credentials.username = String(next.credentials?.username ?? '').trim();
  next.credentials.password = String(next.credentials?.password ?? '');

  const cap = next.captcha ?? {};
  cap.mode = cap.mode === 'manual' ? 'manual' : 'auto';
  cap.maxAttempts = clampInt(cap.maxAttempts, 1, 20, 5);
  cap.delayMs = clampInt(cap.delayMs, 0, 60000, 1200);
  cap.solveTimeoutMs = clampInt(cap.solveTimeoutMs, 5000, 600000, 120000);
  cap.length = clampInt(cap.length, 0, 12, 0);
  next.captcha = cap;

  const ocr = next.ocr ?? {};
  ocr.provider = ['manual', 'baidu', 'remote'].includes(ocr.provider) ? ocr.provider : 'manual';
  ocr.baidu = {
    apiKey: String(ocr.baidu?.apiKey ?? '').trim(),
    secretKey: String(ocr.baidu?.secretKey ?? '').trim(),
  };
  ocr.remote = {
    endpoint: String(ocr.remote?.endpoint ?? '').trim(),
    method: String(ocr.remote?.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
    fieldName: String(ocr.remote?.fieldName || 'image').trim(),
    responsePath: String(ocr.remote?.responsePath || 'result').trim(),
    headers: isPlainObject(ocr.remote?.headers) ? ocr.remote.headers : {},
  };
  next.ocr = ocr;

  next.advanced.startDelayMs = clampInt(next.advanced?.startDelayMs, 0, 15000, 400);
  next.advanced.debug = Boolean(next.advanced?.debug);
  next.ui.autoDismissMs = clampInt(next.ui?.autoDismissMs, 0, 60000, 8000);
  next.ui.showOverlay = Boolean(next.ui?.showOverlay);
  next.ui.notifyOnSuccess = Boolean(next.ui?.notifyOnSuccess);

  next.enabled = Boolean(next.enabled);
  next.autoSubmit = Boolean(next.autoSubmit);

  const silent = next.silent ?? {};
  silent.enabled = Boolean(silent.enabled);
  // 入口地址保留完整路径（WebVPN 的 /https-443/<hex>/ 前缀必须留下），只做基础校验
  silent.entryUrl = normalizeEntryUrl(silent.entryUrl);
  silent.intervalMs = clampInt(silent.intervalMs, 100, 60000, 800);
  silent.maxAttempts = clampInt(silent.maxAttempts, 1, 5000, 200);
  silent.openOnSuccess = silent.openOnSuccess !== false;
  silent.targetPath = String(silent.targetPath ?? '').trim();
  silent.stopOnCredentialError = silent.stopOnCredentialError !== false;
  silent.autoStart = Boolean(silent.autoStart);
  next.silent = silent;

  return next;
}

/**
 * 校验并规范化「登录入口地址」。
 * 与 normalizeOrigin 不同，这里必须保留路径：WebVPN 的登录页是
 * https://webvpn.nxu.edu.cn/https-443/<hex>/index.action，
 * 把路径砍掉就没法拼出验证码和登录地址了。
 *
 * @param {string} url
 * @returns {string} 规范化后的绝对地址；非法时返回空串
 */
export function normalizeEntryUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function normalizeOrigin(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

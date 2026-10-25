/**
 * Service Worker（MV3）：消息路由、验证码下载/识别、系统通知、content script 注入与动态注册。
 *
 * 只做「编排」：存储、OCR、页面 DOM 逻辑分别落在 shared/storage.js、shared/ocr.js、
 * content/dom-adapter.js，这里不写具体业务细节。
 * 顶部只注册事件监听（MV3 可能随时回收 worker），耗时操作全部放进监听器内部。
 */

import {
  MSG,
  CONTENT_MSG,
  APP_NAME,
  APP_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_SERVER_URLS,
  STORAGE_KEYS,
} from '../shared/constants.js';
import {
  appendLog,
  getSettings,
  getState,
  normalizeOrigin,
  onStorageChanged,
  patchSettings,
  patchState,
  resetState,
  setSettings,
} from '../shared/storage.js';
import { handleMessages } from '../shared/messaging.js';
import { solveCaptcha, testOcr } from '../shared/ocr.js';
import { SilentLoginRunner, resolveSilentPlan } from './silent-login.js';

/** 默认站点：manifest 已静态声明 content script，动态注册时跳过 */
const DEFAULT_LOGIN_ORIGIN =
  normalizeOrigin(DEFAULT_SERVER_URLS[0]) || 'https://jwgl.nxu.edu.cn';

/** 备用站点的动态 content script：id 前缀 + 注入文件（顺序敏感，adapter 必须先于 content-script） */
const DYNAMIC_SCRIPT_PREFIX = 'jwgl-dynamic-';
const CONTENT_SCRIPT_FILES = Object.freeze([
  'src/content/dom-adapter.js',
  'src/content/content-script.js',
]);
const CONTENT_SCRIPT_CSS = Object.freeze(['src/content/content.css']);

/** 验证码图片下载超时（毫秒），与 OCR 请求保持一致 */
const CAPTCHA_TIMEOUT_MS = 12000;
const NOTIFICATION_ID_PREFIX = 'jwgl-';
const LOG_LEVELS = Object.freeze(['info', 'warn', 'error', 'success']);

/** 上次同步过的服务器地址指纹，避免每次设置写入都重复注册/卸载动态脚本 */
let lastServerUrlsSignature = '';

/**
 * 同步任务串行链。动态注册是「先全部卸载再逐个注册」，
 * 并发执行会让两个同步互相踩掉，所以排队跑。
 */
let syncChain = Promise.resolve();

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/** 把 ArrayBuffer 转成 base64（分块拼接，避免超长参数导致调用栈溢出） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** 用文件头兜底推断图片类型（有些服务器会返回 application/octet-stream） */
function detectImageMime(buffer) {
  const bytes = new Uint8Array(buffer);
  const startsWith = (signature, offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);

  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46])) return 'image/gif';
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return '';
}

/** 服务器地址列表的指纹（去重排序后拼接），用于判断是否需要重新注册 */
function serverUrlsSignature(serverUrls) {
  const origins = (Array.isArray(serverUrls) ? serverUrls : [])
    .map(normalizeOrigin)
    .filter(Boolean)
    .sort();
  return [...new Set(origins)].join('|');
}

/** 该 URL 是否属于教务系统（默认站点 / 用户配置的备用站点 / nxu.edu.cn 子域） */
function isLoginUrlAllowed(url, settings) {
  const origin = normalizeOrigin(url);
  if (!origin) return false;
  const configured = (settings?.serverUrls ?? []).map(normalizeOrigin).filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    return /(^|\.)nxu\.edu\.cn$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 决定返回的图片 MIME。
 * Content-Type 明确是 image/* 时直接采用（浏览器已归一化为小写无参数形式）；
 * 缺失或笼统（application/octet-stream 等）时才用文件头兜底，其余一律拒绝。
 * @param {string} contentType
 * @param {ArrayBuffer} buffer
 * @returns {string} 空串表示不是图片
 */
function resolveImageMime(contentType, buffer) {
  if (contentType.startsWith('image/')) return contentType;
  const generic =
    !contentType ||
    contentType === 'application/octet-stream' ||
    contentType === 'binary/octet-stream';
  return generic ? detectImageMime(buffer) : '';
}

/** 统一在后台记录，避免日志写入失败把主流程带崩 */
async function safeLog(message, level = 'info') {
  try {
    await appendLog(message, level);
  } catch (error) {
    console.error('[jwgl] 写入日志失败：', error);
  }
}

/* ------------------------------------------------------------------ */
/* PING / 设置 / 状态 / 日志                                           */
/* ------------------------------------------------------------------ */

function handlePing() {
  return { version: APP_VERSION, at: Date.now() };
}

/**
 * 广播最新设置给所有标签页。没有 content script 的页面会 reject，静默忽略即可。
 * @param {object} settings
 */
async function broadcastSettingsChanged(settings) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.error('[jwgl] 查询标签页失败：', error);
    return;
  }

  const tasks = tabs
    .filter((tab) => Number.isInteger(tab?.id))
    .map((tab) =>
      chrome.tabs
        .sendMessage(tab.id, {
          type: MSG.BROADCAST_SETTINGS_CHANGED,
          payload: { settings },
        })
        .catch(() => undefined),
    );
  await Promise.allSettled(tasks);
}

async function handlePatchSettings(patch) {
  const settings = await patchSettings(patch ?? {});
  await broadcastSettingsChanged(settings);
  return settings;
}

async function handleLog(payload) {
  const message = String(payload?.message ?? '').trim();
  if (!message) return { logged: false };
  const level = LOG_LEVELS.includes(payload?.level) ? payload.level : 'info';
  await appendLog(message, level);
  return { logged: true };
}

/* ------------------------------------------------------------------ */
/* 验证码                                                              */
/* ------------------------------------------------------------------ */

async function handleOcrSolve(payload) {
  const settings = await getSettings();
  try {
    return await solveCaptcha(payload, settings);
  } catch (error) {
    await safeLog(`验证码识别失败：${error?.message ?? error}`, 'warn');
    throw error;
  }
}

function handleOcrTest() {
  return getSettings().then((settings) => testOcr(settings));
}

/**
 * 解析验证码地址。页面传过来的通常是绝对的 img.src，这里只做一次格式校验，
 * 不擅自改写 query（可能带有会话参数）。
 * @param {string} rawUrl
 * @returns {URL}
 */
function resolveCaptchaUrl(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('验证码图片地址格式无效');
  }
  return target;
}

/**
 * 在 background 下载验证码图片。credentials: 'include' 让请求复用页面的 cookie jar，
 * 因此得到的验证码与页面上的会话一致。
 * @param {{url?: string}} payload
 * @returns {Promise<{dataUrl: string}>}
 */
async function fetchCaptchaAsDataUrl(payload) {
  const rawUrl = String(payload?.url ?? '').trim();
  if (!rawUrl) throw new Error('缺少验证码图片地址');

  const target = resolveCaptchaUrl(rawUrl);
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error('验证码图片地址必须是 http/https 协议');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTCHA_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(target.href, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'image/*,*/*;q=0.8' },
        signal: controller.signal,
      });
    } catch (error) {
      throw toCaptchaFetchError(error);
    }

    if (!response.ok) {
      throw new Error(`获取验证码失败：HTTP ${response.status} ${response.statusText || ''}`.trim());
    }

    const contentType = String(response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    let buffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw toCaptchaFetchError(error, '读取验证码图片失败');
    }
    if (!buffer || buffer.byteLength === 0) throw new Error('获取验证码失败：响应内容为空');

    // 先校验 Content-Type；仅当它缺失或过于笼统（如 octet-stream）时才用文件头兜底
    const mime = resolveImageMime(contentType, buffer);
    if (!mime) {
      throw new Error(`验证码响应不是图片（Content-Type: ${contentType || '未知'}）`);
    }

    return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 把网络层异常翻译成用户可读的中文提示 */
function toCaptchaFetchError(error, prefix = '获取验证码失败') {
  if (error?.name === 'AbortError') {
    return new Error('获取验证码超时（12 秒），请检查网络或校园网连接');
  }
  return new Error(`${prefix}：${error?.message ?? error}`);
}

/* ------------------------------------------------------------------ */
/* 通知 / 权限                                                         */
/* ------------------------------------------------------------------ */

/**
 * 包装 chrome.notifications.create。
 * 新版 Chrome 直接返回 Promise、旧版走 callback，两种都兼容（Promise 只结算一次，重复 resolve 无害）。
 */
function createNotification(id, options) {
  return new Promise((resolve, reject) => {
    const handleLastError = () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return new Error(lastError.message);
      return null;
    };
    try {
      const returned = chrome.notifications.create(id, options, (createdId) => {
        const error = handleLastError();
        if (error) reject(error);
        else resolve(createdId || id);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (createdId) => resolve(createdId || id),
          (error) => reject(error ?? new Error('系统通知发送失败')),
        );
      }
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 发送系统通知；失败时只记日志，不影响登录流程。
 * @param {{title?: string, message?: string}} payload
 */
async function handleNotify(payload) {
  const title = String(payload?.title ?? '').trim() || APP_NAME;
  const message = String(payload?.message ?? '').trim();
  if (!message) return { shown: false, error: '通知内容为空' };

  try {
    const id = await createNotification(`${NOTIFICATION_ID_PREFIX}${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: message.slice(0, 500),
    });
    return { shown: true, id };
  } catch (error) {
    const reason = error?.message ?? String(error);
    await safeLog(`系统通知发送失败：${reason}`, 'warn');
    return { shown: false, error: reason };
  }
}

/**
 * 包装 chrome.permissions.request：新版返回 Promise，旧版走 callback，两者都兼容。
 * 拒绝时把 Chrome 的原始错误文案带出去（例如缺少用户手势）。
 */
function requestPermission(permissions) {
  return new Promise((resolve, reject) => {
    try {
      const returned = chrome.permissions.request(permissions, (granted) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(Boolean(granted));
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (granted) => resolve(Boolean(granted)),
          (error) => reject(error ?? new Error('权限申请被拒绝')),
        );
      }
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 申请备用站点权限。chrome.permissions.request 必须在用户手势中调用，
 * 所以这里只能由 popup / options 的点击事件触发。
 * @param {{origin?: string}} payload
 */
async function handleRequestOrigin(payload) {
  const origin = normalizeOrigin(payload?.origin);
  if (!origin) {
    throw new Error('服务器地址无效，请输入形如 https://jwgl.nxu.edu.cn 的地址');
  }

  const pattern = `${origin}/*`;
  try {
    const granted = await requestPermission({ origins: [pattern] });
    return { granted, origin, pattern };
  } catch (error) {
    throw new Error(`申请访问权限失败：${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------ */
/* content script 注入 / 动态注册                                      */
/* ------------------------------------------------------------------ */

/** 按顺序注入页面脚本（files 数组顺序即执行顺序） */
async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [...CONTENT_SCRIPT_FILES],
    });
  } catch (error) {
    throw new Error(`无法在目标标签页注入登录脚本：${error?.message ?? error}`);
  }
}

/**
 * 复用一段逻辑：先给已有 content script 发 RUN，收不到就注入后重试一次。
 * @param {number} tabId
 * @returns {Promise<{injected: boolean}>}
 */
async function runLoginInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: CONTENT_MSG.RUN });
    return { injected: false };
  } catch {
    // 常见原因：用户配置了备用服务器地址，该地址不在 manifest 的静态 matches 里
    await injectContentScripts(tabId);
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: CONTENT_MSG.RUN });
  } catch (error) {
    throw new Error(`登录脚本未响应：${error?.message ?? error}`);
  }
  return { injected: true };
}

async function handleRunLoginInTab(payload) {
  const tabId = Number(payload?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('目标标签页无效，请刷新页面后重试');
  }
  return runLoginInTab(tabId);
}

/** 取 sender 所在标签页；popup 场景回退到当前窗口的活动标签页 */
async function resolveLoginTab(sender) {
  if (Number.isInteger(sender?.tab?.id)) return sender.tab;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch (error) {
    console.error('[jwgl] 查询活动标签页失败：', error);
    return null;
  }
}

async function handleRunLogin(_payload, sender) {
  const tab = await resolveLoginTab(sender);
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error('请在教务系统登录页面使用');
  }

  const settings = await getSettings();
  const url = await resolveTabUrl(tab);
  // 'tabs' 权限未申请时，未授权站点的 tab.url 会为空；此时不能断言「不是教务系统」，
  // 由后续 sendMessage / 注入的结果来判断，避免误报。
  if (url && !isLoginUrlAllowed(url, settings)) {
    throw new Error('请在教务系统登录页面使用');
  }

  return runLoginInTab(tab.id);
}

/** 取标签页 URL；sender 里没有时补查一次，失败返回空串 */
async function resolveTabUrl(tab) {
  if (tab?.url) return String(tab.url);
  try {
    const fresh = await chrome.tabs.get(tab.id);
    return String(fresh?.url ?? '');
  } catch {
    return '';
  }
}

/** 取出当前已注册的动态脚本（含 id 与 matches） */
async function listDynamicScripts() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.filter(
      (script) => typeof script?.id === 'string' && script.id.startsWith(DYNAMIC_SCRIPT_PREFIX),
    );
  } catch (error) {
    console.error('[jwgl] 读取已注册 content script 失败：', error);
    return [];
  }
}

async function unregisterDynamicScripts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch (error) {
    console.error('[jwgl] 卸载动态 content script 失败：', error);
  }
}

/** 现有注册是否已经等于期望值（避免每次同步都卸载重装，短暂丢脚本） */
function isSameRegistration(existing, expected) {
  if (existing.length !== expected.length) return false;
  const actual = new Map(
    existing.map((script) => [script.id, (script.matches ?? []).join(',')]),
  );
  return expected.every((item) => actual.get(item.id) === `${item.origin}/*`);
}

/** 注册单个备用站点；带 CSS 注册失败时退回纯 JS（例如 content.css 缺失） */
async function registerDynamicScript(id, origin) {
  const base = {
    id,
    matches: [`${origin}/*`],
    js: [...CONTENT_SCRIPT_FILES],
    runAt: 'document_end',
    allFrames: false,
    persistAcrossSessions: true,
  };

  try {
    await chrome.scripting.registerContentScripts([{ ...base, css: [...CONTENT_SCRIPT_CSS] }]);
    return true;
  } catch (error) {
    console.error(`[jwgl] 注册动态 content script 失败（${origin}）：`, error);
  }

  try {
    await chrome.scripting.registerContentScripts([base]);
    return true;
  } catch (error) {
    console.error(`[jwgl] 退回纯 JS 注册仍失败（${origin}）：`, error);
    return false;
  }
}

/**
 * 实际执行同步：期望的注册与现有注册不一致时，先清空再按索引重建。
 * 失败不抛错，只记控制台，保证安装/启动流程不中断。
 * @returns {Promise<{registered: Array<{id: string, origin: string}>}>}
 */
async function performSyncDynamicScripts(settings) {
  const resolved = settings ?? (await getSettings());
  // 先记指纹，避免同步过程中由自身写入触发的 storage 事件再次排队
  lastServerUrlsSignature = serverUrlsSignature(resolved?.serverUrls);

  const origins = [
    ...new Set(
      (Array.isArray(resolved?.serverUrls) ? resolved.serverUrls : [])
        .map(normalizeOrigin)
        .filter((origin) => origin && origin !== DEFAULT_LOGIN_ORIGIN),
    ),
  ];
  const expected = origins.map((origin, index) => ({
    id: `${DYNAMIC_SCRIPT_PREFIX}${index}`,
    origin,
  }));

  const existing = await listDynamicScripts();
  if (isSameRegistration(existing, expected)) {
    return { registered: expected };
  }

  // 先清空旧注册：地址被删除后残留的高序号脚本也要一并移除
  await unregisterDynamicScripts(existing.map((script) => script.id));

  const registered = [];
  for (const { id, origin } of expected) {
    if (await registerDynamicScript(id, origin)) registered.push({ id, origin });
  }
  return { registered };
}

/**
 * 把 settings.serverUrls 中「非默认站点」的 origin 注册为动态 content script。
 * 通过串行链排队，避免多次触发（安装 / 启动 / 设置变化）互相卸载。
 * @param {object} [settings] 省略时在实际执行时读取最新值
 * @returns {Promise<{registered: Array<{id: string, origin: string}>}>}
 */
function syncDynamicScripts(settings) {
  const run = syncChain.then(() => performSyncDynamicScripts(settings));
  syncChain = run.catch(() => undefined);
  return run;
}

async function handleRegisterScripts() {
  return syncDynamicScripts();
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/**
 * 安装/更新：补齐默认设置、安装时重置状态、同步动态 content script。
 * 按要求不弹通知。
 */
async function initializeExtension(details) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!stored?.[STORAGE_KEYS.SETTINGS]) {
    // 先记默认指纹，避免这次写入触发 storage 监听后再排一次重复同步
    lastServerUrlsSignature = serverUrlsSignature(DEFAULT_SETTINGS.serverUrls);
    await setSettings(DEFAULT_SETTINGS);
  }
  if (details?.reason === 'install') {
    await resetState();
  }

  const settings = await getSettings();
  await syncDynamicScripts(settings);
}

/** 浏览器启动：同步动态 content script，并按设置决定是否自动开始后台请求 */
async function bootstrapScripts() {
  const settings = await getSettings();
  await syncDynamicScripts(settings);

  if (settings.silent?.enabled && settings.silent?.autoStart) {
    try {
      const plan = resolveSilentPlan(settings);
      if (plan.ok) {
        await silentRunner.start();
        await appendLog('浏览器启动：已自动开始后台请求登录', 'info');
      }
    } catch (error) {
      console.error('[jwgl] 启动时自动开始静默登录失败：', error);
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  initializeExtension(details).catch((error) => {
    console.error('[jwgl] 扩展初始化失败：', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapScripts().catch((error) => {
    console.error('[jwgl] 启动时同步 content script 失败：', error);
  });
});

/** 服务器地址变化时重新同步动态注册（其他设置变化直接忽略） */
async function handleSettingsChanged(settings) {
  const signature = serverUrlsSignature(settings?.serverUrls);
  if (signature === lastServerUrlsSignature) return;
  lastServerUrlsSignature = signature;
  await syncDynamicScripts(settings);
}

onStorageChanged(({ settings }) => {
  if (!settings) return;
  handleSettingsChanged(settings).catch((error) => {
    console.error('[jwgl] 设置变化后同步 content script 失败：', error);
  });
});

/**
 * 打开一个标签页。静默登录成功后调用，此时 cookie 已在浏览器 jar 中，
 * 所以新开的页面天然是登录态，不需要再搬 cookie。
 * @param {string} url
 */
async function openTabForSilentSuccess(url) {
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (error) {
    // 没有 tabs.create 权限时退回 windows API，再不行就抛出由调用方记日志
    if (chrome.windows?.create) {
      await chrome.windows.create({ url });
      return;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 后台静默请求模式                                                    */
/* ------------------------------------------------------------------ */

/**
 * 带「迟到消息丢弃」的状态写入。
 *
 * 页面模式里，提交登录表单会让旧文档立刻被销毁，但它在销毁前发出的
 * 「第 N 次尝试中…」可能还堵在消息管道里；新文档判定已登录后写的 success
 * 往往先到，随后这条旧消息才送达，把界面又拉回 running。
 * 因此每条页面消息都带 stateAt（写入时刻），比库里旧的更晚才允许覆盖。
 *
 * @param {object} patch
 */
async function patchStateGuarded(patch) {
  const incoming = Number(patch?.stateAt) || 0;
  if (incoming) {
    const current = await getState();
    if (incoming < (Number(current.stateAt) || 0)) return current;
  }
  const next = incoming ? { ...patch } : { ...patch, stateAt: Date.now() };
  return patchState(next);
}

/**
 * 单例 runner。放在模块作用域而不是每次 new：
 * ① 防止重复点击启动两个循环；② stop() 需要拿到正在跑的那个实例。
 * MV3 的 service worker 被回收后这个变量自然重置，此时循环也已随 worker 结束。
 */
const silentRunner = new SilentLoginRunner({
  getSettings,
  patchState: async (patch) => {
    await patchState(patch);
  },
  appendLog: async (message, level) => {
    await appendLog(message, level);
  },
  solveCaptcha: async (input, settings) => solveCaptcha(input, settings),
  onSuccess: openTabForSilentSuccess,
  onNotify: async (payload) => {
    await handleNotify(payload);
  },
});

async function handleSilentStart() {
  const settings = await getSettings();
  // 运行前先做一次「能不能跑」的校验，避免用户在 popup 里点了没反应
  const plan = resolveSilentPlan(settings);
  if (!plan.ok) throw new Error(plan.reason);

  const result = await silentRunner.start();
  if (!result.started) throw new Error(result.reason || '静默登录启动失败');
  return { started: true, entry: plan.endpoints.base, maxAttempts: plan.maxAttempts };
}

async function handleSilentStop() {
  const result = silentRunner.stop();
  if (result.stopped) {
    await appendLog('用户停止了静默登录', 'info');
    await patchState({ status: 'idle', message: '已停止静默登录', silentRunning: false, mode: 'silent' });
  }
  return result;
}

async function handleSilentStatus() {
  return { running: silentRunner.isRunning() };
}

/* ------------------------------------------------------------------ */
/* 消息处理器                                                          */
/* ------------------------------------------------------------------ */

handleMessages({
  [MSG.PING]: () => handlePing(),
  [MSG.GET_SETTINGS]: () => getSettings(),
  [MSG.PATCH_SETTINGS]: (payload) => handlePatchSettings(payload),
  [MSG.GET_STATE]: () => getState(),
  [MSG.PATCH_STATE]: (payload) => patchStateGuarded(payload ?? {}),
  [MSG.LOG]: (payload) => handleLog(payload),
  [MSG.OCR_SOLVE]: (payload) => handleOcrSolve(payload),
  [MSG.OCR_TEST]: () => handleOcrTest(),
  [MSG.FETCH_CAPTCHA]: (payload) => fetchCaptchaAsDataUrl(payload),
  [MSG.NOTIFY]: (payload) => handleNotify(payload),
  [MSG.REQUEST_ORIGIN]: (payload) => handleRequestOrigin(payload),
  [MSG.RUN_LOGIN_IN_TAB]: (payload) => handleRunLoginInTab(payload),
  [MSG.RUN_LOGIN]: (payload, sender) => handleRunLogin(payload, sender),
  [MSG.SILENT_START]: () => handleSilentStart(),
  [MSG.SILENT_STOP]: () => handleSilentStop(),
  [MSG.SILENT_STATUS]: () => handleSilentStatus(),
  [MSG.REGISTER_SCRIPTS]: () => handleRegisterScripts(),
});

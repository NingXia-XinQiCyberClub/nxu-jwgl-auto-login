/**
 * 验证码识别适配层（在 service worker 中运行）。
 * 三种 provider：
 *  - manual：不识别，交给页面内的人工输入面板
 *  - baidu ：百度智能云 OCR（沿用原项目的 API Key / Secret Key）
 *  - remote：自建 OCR 服务（如 ddddocr），可配置字段名与响应路径
 */

import { OCR_PROVIDERS } from './constants.js';

const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
/**
 * 实测（2026-10，20 张真实验证码 + 用错密码排除干扰）：
 *   general_basic   60%  —— 4 位验证码常只识别出 1 个字母
 *   accurate_basic  90%  —— 高精度版，同样免费额度内
 * 所以默认走高精度版。验证码是 4–5 位小写字母，标准版对单字符粘连明显更差。
 */
const BAIDU_OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic';
const REQUEST_TIMEOUT_MS = 12000;

/** 验证码最少字符数：低于此值视为识别失败，换一张图重来，不浪费一次登录请求 */
export const MIN_CAPTCHA_LENGTH = 3;

/** 百度 access_token 内存缓存（service worker 被回收后自动失效） */
let baiduTokenCache = { key: '', token: '', expiresAt: 0 };

/**
 * 清洗 OCR 文本：只保留字母数字，并按预期长度截取。
 * @param {string} raw
 * @param {number} [expectedLength]
 */
export function cleanCaptchaText(raw, expectedLength = 0) {
  let text = String(raw ?? '')
    .replace(/\s+/g, '')
    .replace(/[^0-9a-zA-Z]/g, '');
  if (expectedLength > 0 && text.length > expectedLength) text = text.slice(0, expectedLength);
  return text;
}

/**
 * 识别验证码。
 * @param {{dataUrl: string, expectedLength?: number}} input
 * @param {object} settings normalizeSettings 之后的设置
 * @returns {Promise<{text: string, provider: string, elapsedMs: number}>}
 */
export async function solveCaptcha(input, settings) {
  const startedAt = Date.now();
  const dataUrl = String(input?.dataUrl ?? '');
  if (!dataUrl.startsWith('data:image/')) {
    throw new Error('验证码图片无效');
  }

  const provider = settings?.ocr?.provider ?? OCR_PROVIDERS.MANUAL;
  const expectedLength = Number(input?.expectedLength) || 0;

  let raw = '';
  if (provider === OCR_PROVIDERS.BAIDU) {
    raw = await solveWithBaidu(dataUrl, settings.ocr.baidu);
  } else if (provider === OCR_PROVIDERS.REMOTE) {
    raw = await solveWithRemote(dataUrl, settings.ocr.remote);
  } else {
    throw new Error('当前为手动输入模式，无需调用 OCR');
  }

  const text = cleanCaptchaText(raw, expectedLength);
  if (!text) throw new Error('OCR 未返回可用结果');
  // 实测有一半的失败是「只认出 1 个字母」而不是认错字：这种情况直接换一张图重来，
  // 比拿残缺结果去打一次登录请求更划算（少一次失败计数、少一次服务端压力）。
  if (!expectedLength && text.length < MIN_CAPTCHA_LENGTH) {
    throw new Error(`识别结果过短（${text.length} 字），换一张验证码`);
  }
  return { text, provider, elapsedMs: Date.now() - startedAt };
}

/** 百度 OCR 连通性自检 */
export async function testOcr(settings) {
  const provider = settings?.ocr?.provider ?? OCR_PROVIDERS.MANUAL;
  if (provider === OCR_PROVIDERS.MANUAL) {
    return { provider, ok: true, detail: '手动输入模式，无需配置 OCR 服务' };
  }
  if (provider === OCR_PROVIDERS.BAIDU) {
    const startedAt = Date.now();
    await getBaiduToken(settings.ocr.baidu, true);
    return { provider, ok: true, detail: `百度 OCR 凭证有效（${Date.now() - startedAt}ms）` };
  }
  if (provider === OCR_PROVIDERS.REMOTE) {
    const startedAt = Date.now();
    await solveWithRemote(makeProbeImage(), settings.ocr.remote);
    return { provider, ok: true, detail: `自建 OCR 服务可达（${Date.now() - startedAt}ms）` };
  }
  throw new Error(`未知的 OCR 提供方：${provider}`);
}

async function solveWithBaidu(dataUrl, config) {
  const token = await getBaiduToken(config);
  const base64 = dataUrl.split(',')[1] ?? '';
  const body = new URLSearchParams({ image: base64 });

  // 百度免费版 general_basic 是 1 QPS，连发必然撞 error_code=18。
  // 静默模式的循环节奏很快，所以这里必须自己退让，而不是把它当成「识别失败」——
  // 否则会白白消耗一次尝试次数，还可能让人误判成 OCR 不可用。
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchWithTimeout(`${BAIDU_OCR_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`百度 OCR 请求失败：HTTP ${response.status}`);

    const errorCode = Number(json?.error_code) || 0;
    if (errorCode === 18) {
      // QPS 限流：等一会儿再发，三次都失败才上报
      lastError = json?.error_msg || 'QPS 限流';
      await sleep(1200);
      continue;
    }
    if (errorCode) throw new Error(`百度 OCR 错误：${json?.error_msg || errorCode}`);

    const words = json?.words_result;
    if (!Array.isArray(words) || words.length === 0) throw new Error('百度 OCR 未识别到文字');
    // 验证码可能被拆成多段（实测 "d" / "o d" / "0"），必须按顺序拼起来
    return words.map((item) => String(item?.words ?? '')).join('');
  }
  throw new Error(`百度 OCR 暂时不可用：${lastError}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBaiduToken(config, forceRefresh = false) {
  const apiKey = String(config?.apiKey ?? '').trim();
  const secretKey = String(config?.secretKey ?? '').trim();
  if (!apiKey || !secretKey) throw new Error('未配置百度 OCR 的 API Key / Secret Key');

  const cacheKey = `${apiKey}:${secretKey.slice(-6)}`;
  const now = Date.now();
  if (!forceRefresh && baiduTokenCache.key === cacheKey && baiduTokenCache.expiresAt > now + 60000) {
    return baiduTokenCache.token;
  }

  const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const response = await fetchWithTimeout(url, { method: 'POST' });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.access_token) {
    throw new Error(`获取百度 access_token 失败：${json?.error_description || `HTTP ${response.status}`}`);
  }

  baiduTokenCache = {
    key: cacheKey,
    token: json.access_token,
    expiresAt: now + (Number(json.expires_in) || 2592000) * 1000,
  };
  return baiduTokenCache.token;
}

async function solveWithRemote(dataUrl, config) {
  const endpoint = String(config?.endpoint ?? '').trim();
  if (!endpoint) throw new Error('未配置自建 OCR 服务地址');

  const method = String(config?.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const headers = { Accept: 'application/json', ...(config?.headers ?? {}) };
  let url = endpoint;
  const init = { method, headers };

  if (method === 'GET') {
    const sep = endpoint.includes('?') ? '&' : '?';
    url = `${endpoint}${sep}${encodeURIComponent(config.fieldName || 'image')}=${encodeURIComponent(dataUrl)}`;
  } else {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify({ [config.fieldName || 'image']: dataUrl });
  }

  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`OCR 服务返回 HTTP ${response.status}：${text.slice(0, 120)}`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // 纯文本响应
  }
  const picked = pickByPath(parsed, config.responsePath);
  if (picked == null) {
    throw new Error(`OCR 响应中找不到字段 ${config.responsePath || 'result'}`);
  }
  if (Array.isArray(picked)) return picked.join('');
  if (typeof picked === 'object') {
    return picked.text ?? picked.words ?? picked.result ?? JSON.stringify(picked);
  }
  return String(picked);
}

/** 支持 a.b.c / 数组下标 a.0.b 的取值 */
export function pickByPath(obj, path) {
  const segments = String(path ?? '')
    .split('.')
    .map((seg) => seg.trim())
    .filter(Boolean);
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current ?? obj;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, credentials: 'omit' });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('OCR 请求超时');
    throw new Error(`OCR 请求失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 1x1 透明 PNG，用于探测服务可达性 */
function makeProbeImage() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
}

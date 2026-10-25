/**
 * 后台静默请求模式（等价原 Python 版 `requests` 循环）。
 *
 * 原脚本做的事：
 *   GET /index.action（拿 JSESSIONID）→ GET 验证码 → OCR → POST /login.action → 失败就重来
 * 这里搬进浏览器后，cookie 由浏览器自己的 jar 维护，所以只需要：
 *   GET 验证码（credentials: include） → OCR → POST 登录 → 判定 → 重来或停
 *
 * 设计要点：
 * 1. 全部走 fetch，不依赖页面上有登录表单，因此可以在任何标签页静默跑；
 * 2. 一旦成功，cookie 已经在浏览器里，直接新开标签页就是登录态；
 * 3. 区分「验证码错」（可重试）与「账户不存在 / 密码错」（不可重试），
 *    后者继续刷只会浪费次数、还可能触发风控。
 */

const REQUEST_TIMEOUT_MS = 15000;

/** 同一次运行里，因「识别结果不可用」而换图的总次数上限（防止 OCR 坏掉时死循环） */
const MAX_CAPTCHA_RETRIES_TOTAL = 20;

/** 换图重试的退避：百度免费版 1 QPS，太急会连续撞限流 */
function captchaRetryDelay(round) {
  return round <= 1 ? 300 : 1200;
}

/** 判定结果分类 */
export const RESULT_KIND = Object.freeze({
  SUCCESS: 'success',
  CAPTCHA: 'captcha',
  CREDENTIALS: 'credentials',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
});

/**
 * 由「登录入口地址」推导出站点根（保留 WebVPN 的路径前缀）。
 *
 * 这是兼容「校园内外两种入口」的关键：
 *   校园内   https://jwgl.nxu.edu.cn/index.action
 *        →   https://jwgl.nxu.edu.cn/
 *   校园外   https://webvpn.nxu.edu.cn/https-443/7772...2d/index.action
 *        →   https://webvpn.nxu.edu.cn/https-443/7772...2d/
 * 之后 index.action / captcha/image.action / login.action 都拼在这个根上，
 * 于是同一套代码在两种入口下都成立。
 *
 * @param {string} entryUrl
 * @returns {string} 以 / 结尾的绝对地址；无法解析时返回空串
 */
export function deriveAppBase(entryUrl) {
  const raw = String(entryUrl ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(url.protocol)) return '';

  // 去掉末段的 xxx.action（含 index.action / login.action 等）
  let path = url.pathname || '/';
  path = path.replace(/\/[^/]*\.action$/i, '/');
  if (!path.endsWith('/')) path = `${path.replace(/[^/]*$/, '')}`.replace(/\/{2,}/g, '/');
  if (!path.endsWith('/')) path = `${path}/`;

  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * 由站点根生成三个必需地址。
 * @param {string} base 形如 https://host/prefix/
 */
export function buildEndpoints(base) {
  const root = String(base ?? '');
  return {
    base: root,
    index: `${root}index.action`,
    captcha: `${root}captcha/image.action`,
    login: `${root}login.action`,
  };
}

/** 从登录响应 HTML 里提取站点给出的错误文案 */
export function extractErrorText(html) {
  const text = String(html ?? '');
  if (!text) return '';

  const patterns = [
    /<div[^>]*id=["']errors["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*message[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /var\s+errorMsg\s*=\s*["']([^"']*)["']/i,
    /<span[^>]*class=["'][^"']*error[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const cleaned = stripTags(match[1]).replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned.slice(0, 120);
  }
  return '';
}

function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '');
}

/** 错误文案 → 分类。顺序重要：「验证码」优先于「密码」 */
export function classifyErrorText(message) {
  const msg = String(message ?? '');
  if (!msg) return RESULT_KIND.UNKNOWN;
  if (/验证码/.test(msg)) return RESULT_KIND.CAPTCHA;
  if (/账户|账号|用户名|学号|密码|用户不存在|锁定|冻结/.test(msg)) return RESULT_KIND.CREDENTIALS;
  return RESULT_KIND.UNKNOWN;
}

/**
 * 判定一次登录 POST 的结果。
 *
 * 站点行为（2026-10 实测）：
 *   验证码错   → 200，仍是登录页，#errors 里写「验证码不对」
 *   账号不存在 → 200，仍是登录页，#errors 里写「账户不存在」
 *   成功       → 不再有 loginForm.name / loginForm.captcha
 *
 * 所以「登录表单消失且没有错误文案」才算成功；只靠「没有 loginForm」会
 * 把 500 错误页、VPN 掉线页误判成登录成功。
 *
 * @param {string} html
 * @returns {{ok: boolean, kind: string, reason: string}}
 */
export function classifyLoginResponse(html) {
  const text = String(html ?? '');
  if (!text.trim()) {
    return { ok: false, kind: RESULT_KIND.UNKNOWN, reason: '登录响应为空' };
  }

  const hasLoginForm =
    /loginForm\.name/i.test(text) || /loginForm\.captcha/i.test(text) || /id=["']loginForm["']/i.test(text);
  const errorText = extractErrorText(text);
  const errorKind = classifyErrorText(errorText);

  if (hasLoginForm) {
    if (errorText) return { ok: false, kind: errorKind, reason: errorText };
    return { ok: false, kind: RESULT_KIND.UNKNOWN, reason: '仍停留在登录页（站点未给出原因）' };
  }

  if (errorText && errorKind !== RESULT_KIND.UNKNOWN) {
    return { ok: false, kind: errorKind, reason: errorText };
  }

  // 登录表单消失 = 已进入系统。再确认一下不是错误页/掉线页
  if (/webvpn|ssl-?vpn|登录超时|会话已过期|服务不可用|Bad Gateway|502 Bad Gateway/i.test(text) && !/退出|注销|欢迎/i.test(text)) {
    return { ok: false, kind: RESULT_KIND.UNKNOWN, reason: '响应看起来是网关/会话错误页' };
  }
  return { ok: true, kind: RESULT_KIND.SUCCESS, reason: '已进入系统' };
}

/** fetch 包装：超时 + 统一错误信息 */
async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`网络请求失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 下载验证码并转 dataURL（复用浏览器 cookie jar） */
export async function fetchCaptchaDataUrl(captchaUrl) {
  const url = new URL(captchaUrl);
  url.searchParams.set('t', String(Date.now()));

  const response = await fetchWithTimeout(url.href, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'image/*,*/*;q=0.8' },
  });
  if (!response.ok) throw new Error(`获取验证码失败：HTTP ${response.status}`);

  const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) throw new Error('验证码响应为空');

  // 有些网关会把图片包成 octet-stream，用文件头兜底
  const mime = contentType.startsWith('image/') ? contentType : sniffImageMime(buffer);
  if (!mime) throw new Error(`验证码响应不是图片（Content-Type: ${contentType || '未知'}）`);

  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

/** 按文件头识别图片类型 */
export function sniffImageMime(buffer) {
  const bytes = new Uint8Array(buffer).subarray(0, 4);
  if (bytes.length < 4) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  return '';
}

/** 提交登录表单 */
export async function postLogin(loginUrl, { username, password, captcha, locale = 'zh_CN' }, referer) {
  const body = new URLSearchParams({
    request_locale: locale,
    'loginForm.name': username,
    'loginForm.password': password,
    'loginForm.captcha': captcha,
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  // 部分网关会校验 Referer；设置失败也不影响主流程
  if (referer) {
    try {
      headers.Referer = referer;
    } catch {
      /* ignore */
    }
  }

  const response = await fetchWithTimeout(loginUrl, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers,
    body: body.toString(),
  });

  const html = await response.text().catch(() => '');
  return { status: response.status, url: response.url, html };
}

/**
 * 静默登录循环。
 *
 * 依赖注入而不是直接引用 chrome.* / storage，好处是可以在 Node 里跑单测，
 * 也让「谁负责落盘」这件事只有一个答案（由调用方注入）。
 */
export class SilentLoginRunner {
  /**
   * @param {object} deps
   * @param {() => Promise<object>} deps.getSettings
   * @param {(patch: object) => Promise<void>} deps.patchState
   * @param {(message: string, level?: string) => Promise<void>} deps.appendLog
   * @param {(input: {dataUrl: string, expectedLength?: number}, settings: object) => Promise<{text: string}>} deps.solveCaptcha
   * @param {(url: string) => Promise<void>} [deps.onSuccess] 成功后回调（通常用来开标签页）
   * @param {(payload: object) => Promise<void>} [deps.onNotify]
   * @param {() => number} [deps.now]
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   */
  constructor(deps) {
    this.deps = deps;
    this.running = false;
    this.cancelled = false;
    this.loopPromise = null;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  isRunning() {
    return this.running;
  }

  /** 停止循环（会在下一次 sleep 结束时退出） */
  stop() {
    if (!this.running) return { stopped: false };
    this.cancelled = true;
    this.running = false;
    return { stopped: true };
  }

  /** 启动循环；已在运行则直接返回 */
  async start() {
    if (this.running) return { started: false, reason: '正在运行中' };

    const settings = await this.deps.getSettings();
    const plan = resolveSilentPlan(settings);
    if (!plan.ok) {
      await this.deps.patchState({ status: 'failed', message: plan.reason, lastError: plan.reason, mode: 'silent' });
      await this.deps.appendLog(`静默登录无法开始：${plan.reason}`, 'error');
      return { started: false, reason: plan.reason };
    }

    this.running = true;
    this.cancelled = false;
    this.loopPromise = this.#loop(plan).catch(async (error) => {
      const message = `静默登录中断：${error?.message ?? error}`;
      await this.deps.patchState({ status: 'failed', message, lastError: message, silentRunning: false });
      await this.deps.appendLog(message, 'error');
    }).finally(() => {
      this.running = false;
      this.loopPromise = null;
    });

    return { started: true, endpoints: plan.endpoints };
  }

  /** 等待当前循环结束（测试用） */
  async wait() {
    if (this.loopPromise) await this.loopPromise;
  }

  async #loop(plan) {
    const { settings, endpoints, maxAttempts, intervalMs, openOnSuccess, targetUrl, stopOnCredentialError } = plan;
    const username = settings.credentials.username;
    const password = settings.credentials.password;
    const expectedLength = Number(settings.captcha?.length) || 0;

    await this.deps.patchState({
      status: 'running',
      mode: 'silent',
      silentRunning: true,
      attempts: 0,
      maxAttempts,
      message: '正在后台请求登录…',
      lastRunAt: this.now(),
      lastError: '',
      origin: new URL(endpoints.base).origin,
      silentRequests: 0,
      logs: [],
    });
    await this.deps.appendLog(
      `开始静默登录（最多 ${maxAttempts} 次，间隔 ${intervalMs}ms，入口 ${endpoints.base}）`,
      'info',
    );

    let lastReason = '';
    let lastKind = '';
    let attempt = 0;
    let totalCaptchaRetries = 0;

    while (attempt < maxAttempts) {
      if (this.cancelled) break;
      attempt += 1;

      await this.deps.patchState({
        status: 'running',
        silentRunning: true,
        attempts: attempt - 1,
        silentRequests: attempt,
        message: `第 ${attempt} / ${maxAttempts} 次请求中…`,
        mode: 'silent',
      });

      try {
        // 1) 取验证码 + 识别
        //    「识别不出可用结果」（图片太糊、只认出 1 个字母、QPS 限流）不该算一次登录尝试：
        //    拿这种结果去提交，站点只会回「验证码不对」，白烧一次请求也白烧一次配额。
        //    所以这里在同一轮内换图重试，但用 totalCaptchaRetries 兜住总数，
        //    否则 OCR 完全不可用时会变成永不退出的死循环。
        const dataUrl = await fetchCaptchaDataUrl(endpoints.captcha);
        let solved;
        try {
          solved = await this.deps.solveCaptcha({ dataUrl, expectedLength }, settings);
        } catch (error) {
          const reason = error?.message ?? String(error);
          if (totalCaptchaRetries < MAX_CAPTCHA_RETRIES_TOTAL) {
            totalCaptchaRetries += 1;
            await this.deps.appendLog(`识别未通过（${reason}），换一张验证码重试`, 'warn');
            await this.sleep(captchaRetryDelay(totalCaptchaRetries));
            attempt -= 1; // 不占用本次尝试名额
            continue;
          }
          throw new Error(`验证码识别连续失败（${reason}）`);
        }
        const captchaText = String(solved?.text ?? '').trim();
        if (!captchaText) throw new Error('识别结果为空');

        // 2) 提交登录
        const res = await postLogin(
          endpoints.login,
          { username, password, captcha: captchaText },
          endpoints.index,
        );
        const verdict = classifyLoginResponse(res.html);
        lastKind = verdict.kind;
        lastReason = verdict.reason;

        await this.deps.patchState({ silentLastKind: verdict.kind });

        if (verdict.ok) {
          return await this.#succeed(attempt, endpoints, { openOnSuccess, targetUrl });
        }

        if (verdict.kind === RESULT_KIND.CREDENTIALS) {
          const message = `登录被拒绝：${verdict.reason}。请核对学号与密码（已停止，不再重试）`;
          await this.deps.patchState({
            status: 'failed',
            silentRunning: false,
            attempts: attempt,
            message,
            lastError: verdict.reason,
            mode: 'silent',
          });
          await this.deps.appendLog(message, 'error');
          await this.#notify({ title: '教务系统登录失败', message });
          if (stopOnCredentialError) return;
        } else {
          await this.deps.appendLog(`第 ${attempt} 次未成功：${verdict.reason}`, 'warn');
        }

        await this.deps.patchState({
          status: 'running',
          silentRunning: true,
          attempts: attempt,
          message: `第 ${attempt} 次未成功：${verdict.reason}`,
          lastError: verdict.reason,
          mode: 'silent',
        });
      } catch (error) {
        lastKind = RESULT_KIND.NETWORK;
        lastReason = error?.message ?? String(error);
        await this.deps.patchState({
          status: 'running',
          silentRunning: true,
          attempts: attempt,
          silentLastKind: RESULT_KIND.NETWORK,
          message: `第 ${attempt} 次请求异常：${lastReason}`,
          lastError: lastReason,
          mode: 'silent',
        });
        await this.deps.appendLog(`第 ${attempt} 次请求异常：${lastReason}`, 'warn');
      }

      if (attempt < maxAttempts && !this.cancelled) await this.sleep(intervalMs);
    }

    const stoppedByUser = this.cancelled;
    const exhausted = !stoppedByUser && lastKind !== RESULT_KIND.CREDENTIALS;
    const message = stoppedByUser
      ? '已停止静默登录'
      : exhausted
        ? `已请求 ${maxAttempts} 次仍未成功${lastReason ? `：${lastReason}` : ''}`
        : '静默登录已结束';

    await this.deps.patchState({
      status: stoppedByUser ? 'idle' : 'failed',
      silentRunning: false,
      message,
      lastError: stoppedByUser ? '' : lastReason,
      mode: 'silent',
    });
    await this.deps.appendLog(message, stoppedByUser ? 'info' : 'error');
  }

  async #succeed(attempt, endpoints, { openOnSuccess, targetUrl }) {
    const successMessage = `登录成功（第 ${attempt} 次请求）`;
    await this.deps.patchState({
      status: 'success',
      mode: 'silent',
      silentRunning: false,
      attempts: attempt,
      message: successMessage,
      lastSuccessAt: this.now(),
      lastError: '',
      pendingCaptcha: '',
      pendingCaptchaAt: 0,
    });
    await this.deps.appendLog(successMessage, 'success');
    await this.#notify({ title: '教务系统登录成功', message: `已通过后台请求登录成功（第 ${attempt} 次）` });

    if (openOnSuccess) {
      const url = targetUrl || endpoints.index;
      try {
        await this.deps.onSuccess?.(url);
        await this.deps.appendLog(`已用当前 cookie 打开页面：${url}`, 'info');
      } catch (error) {
        await this.deps.appendLog(`打开页面失败：${error?.message ?? error}`, 'warn');
      }
    }
  }

  async #notify(payload) {
    try {
      await this.deps.onNotify?.(payload);
    } catch {
      /* 通知失败不影响主流程 */
    }
  }
}

/**
 * 校验并整理静默模式的运行参数。
 * 把「为什么不能跑」一次性说清楚，比在循环里逐条报错友好。
 */
export function resolveSilentPlan(settings) {
  const silent = settings?.silent ?? {};
  const username = String(settings?.credentials?.username ?? '').trim();
  const password = String(settings?.credentials?.password ?? '');
  const provider = String(settings?.ocr?.provider ?? 'manual');

  if (!silent.enabled) return { ok: false, reason: '后台静默登录未启用' };
  if (!username || !password) return { ok: false, reason: '请先在设置里填写学号与密码' };
  if (provider === 'manual') {
    return { ok: false, reason: '静默登录必须配置验证码识别服务（百度 OCR 或自建服务），手动输入模式无法在后台完成' };
  }

  const fallbackEntry = `${String(settings?.serverUrls?.[0] ?? 'https://jwgl.nxu.edu.cn').replace(/\/+$/, '')}/index.action`;
  const entryUrl = String(silent.entryUrl ?? '').trim() || fallbackEntry;
  const base = deriveAppBase(entryUrl);
  if (!base) return { ok: false, reason: `登录入口地址无效：${entryUrl}` };

  const endpoints = buildEndpoints(base);
  const maxAttempts = clampInt(silent.maxAttempts, 1, 5000, 200);
  const intervalMs = clampInt(silent.intervalMs, 100, 60000, 800);

  const targetPath = String(silent.targetPath ?? '').trim();
  let targetUrl = '';
  if (targetPath) {
    try {
      targetUrl = new URL(targetPath.replace(/^\/+/, ''), base).href;
    } catch {
      targetUrl = endpoints.index;
    }
  }

  return {
    ok: true,
    settings,
    endpoints,
    entryUrl,
    maxAttempts,
    intervalMs,
    openOnSuccess: silent.openOnSuccess !== false,
    targetUrl,
    stopOnCredentialError: silent.stopOnCredentialError !== false,
  };
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

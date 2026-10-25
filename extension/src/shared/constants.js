/**
 * 全局常量与默认配置。
 * 所有模块（content / background / popup / options）共用，禁止各自硬编码字符串。
 */

export const APP_NAME = 'NXU JWGL Auto Login';
export const APP_VERSION = '2.1.0';

/** 存储键名 */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  STATE: 'state',
});

/** 教务系统默认地址 */
export const DEFAULT_SERVER_URLS = Object.freeze(['https://jwgl.nxu.edu.cn']);

/**
 * 设置页「常见备用地址」里可一键填入的候选地址。
 *
 * 这里**故意留空**：备用地址属于校内基础设施信息，不随仓库分发。
 * 需要时请自己在设置页里添加，保存时会请求该域名的访问权限。
 * 留空时设置页会自动隐藏整个「常见备用地址」折叠块。
 */
export const KNOWN_MIRROR_HINTS = Object.freeze([]);

/** 验证码识别服务提供方 */
export const OCR_PROVIDERS = Object.freeze({
  MANUAL: 'manual',
  BAIDU: 'baidu',
  REMOTE: 'remote',
});

/** 运行状态 */
export const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  NEED_INPUT: 'need-input',
  SUCCESS: 'success',
  FAILED: 'failed',
});

/** 消息类型：content/popup/options -> background */
export const MSG = Object.freeze({
  // 设置
  GET_SETTINGS: 'settings/get',
  PATCH_SETTINGS: 'settings/patch',
  // 状态
  GET_STATE: 'state/get',
  PATCH_STATE: 'state/patch',
  // 日志
  LOG: 'log/append',
  // 动作
  RUN_LOGIN: 'action/run-login',
  RUN_LOGIN_IN_TAB: 'action/run-login-in-tab',
  // 后台静默请求模式（等价原 Python 版的 requests 循环）
  SILENT_START: 'silent/start',
  SILENT_STOP: 'silent/stop',
  SILENT_STATUS: 'silent/status',
  OCR_SOLVE: 'action/ocr-solve',
  OCR_TEST: 'action/ocr-test',
  FETCH_CAPTCHA: 'action/fetch-captcha',
  NOTIFY: 'action/notify',
  REQUEST_ORIGIN: 'action/request-origin',
  REGISTER_SCRIPTS: 'action/register-scripts',
  PING: 'misc/ping',
  // background -> content 广播
  BROADCAST_SETTINGS_CHANGED: 'broadcast/settings-changed',
});

/** 发往 content script 的消息类型（popup/background -> 页面） */
export const CONTENT_MSG = Object.freeze({
  /** 立即执行一次登录 */
  RUN: 'content/run',
  /** popup/overlay 提交人工输入的验证码 */
  SUBMIT_CAPTCHA: 'content/submit-captcha',
  /** 取消当前登录流程 */
  CANCEL: 'content/cancel',
  /** 查询页面状态（便于 popup 展示） */
  GET_PAGE_INFO: 'content/get-page-info',
});

/** 默认设置。新增字段必须在这里给出默认值，storage 层会自动补齐旧数据。 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 2,
  /** 页面加载后是否自动登录 */
  enabled: true,
  /** 登录表单填充完成后是否自动提交 */
  autoSubmit: true,
  /** 教务系统地址列表，按顺序尝试 */
  serverUrls: ['https://jwgl.nxu.edu.cn'],
  credentials: {
    username: '',
    password: '',
  },
  captcha: {
    /** auto: 先尝试 OCR，失败回退人工；manual: 始终人工输入 */
    mode: 'auto',
    /** 单次登录最多尝试次数（对应原 max_retry） */
    maxAttempts: 5,
    /** 两次尝试之间的等待（毫秒） */
    delayMs: 1200,
    /** 人工输入验证码的最长等待（毫秒），超时视为本次失败 */
    solveTimeoutMs: 120000,
    /** 验证码长度提示，0 表示自动探测 input 的 maxlength */
    length: 0,
  },
  ocr: {
    provider: 'manual',
    baidu: {
      apiKey: '',
      secretKey: '',
    },
    remote: {
      /** 自建 OCR 服务（如 ddddocr）的地址 */
      endpoint: '',
      method: 'POST',
      /** 表单字段名，图片以 dataURL 文本提交 */
      fieldName: 'image',
      /** 从响应 JSON 中取结果的路径，如 result / data.text */
      responsePath: 'result',
      /** 额外请求头 */
      headers: {},
    },
  },
  ui: {
    /** 页面上是否显示悬浮状态面板 */
    showOverlay: true,
    /** 登录成功后是否发送系统通知 */
    notifyOnSuccess: true,
    /** 登录成功后是否自动关闭提示 */
    autoDismissMs: 8000,
  },
  advanced: {
    /** 页面加载后延迟多久开始（毫秒），给站点脚本留出渲染时间 */
    startDelayMs: 400,
    /** 调试模式：输出更详细日志 */
    debug: false,
  },
  /**
   * 后台静默请求模式：等价原 Python 脚本的行为 ——
   * 在后台反复请求「取验证码 → 识别 → POST 登录」，成功后再打开页面。
   * 不需要页面上有登录表单，也不需要人工输入。
   */
  silent: {
    /** 是否使用静默请求模式（关闭时仍走页面内自动填充） */
    enabled: false,
    /**
     * 登录入口地址：用户自己实际能打开的那个登录页。
     * 校园内填 https://jwgl.nxu.edu.cn/index.action
     * 校园外（WebVPN）填 https://webvpn.nxu.edu.cn/https-443/<一串hex>/index.action
     * 留空则自动使用 serverUrls[0] + /index.action
     */
    entryUrl: '',
    /** 两次尝试之间的间隔（毫秒），别设太小，避免把服务器打崩 */
    intervalMs: 800,
    /** 最多请求多少次（1-5000），用尽仍未成功则停止 */
    maxAttempts: 200,
    /** 成功后是否立刻用当前 cookie 打开页面 */
    openOnSuccess: true,
    /** 成功后打开的路径，相对登录入口；留空表示打开 index.action */
    targetPath: '',
    /** 遇到「账户不存在 / 密码错误」这类凭据错误时立刻停止（继续重试没有意义，还可能锁号） */
    stopOnCredentialError: true,
    /** 浏览器启动后自动开始请求（默认关闭：避免每次开浏览器都对服务器发起长循环） */
    autoStart: false,
  },
});

/** 默认运行状态 */
export const DEFAULT_STATE = Object.freeze({
  status: 'idle',
  message: '尚未运行',
  attempts: 0,
  maxAttempts: 0,
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastError: '',
  origin: '',
  /** 当前运行模式：page=页面内自动填充，silent=后台静默请求 */
  mode: '',
  /**
   * 最近一次被接受的「页面模式状态写入」的逻辑时间戳（毫秒）。
   *
   * 为什么需要：页面在提交表单后会被整页销毁，销毁前发出的 PATCH_STATE 仍在
   * 消息管道里；新页面判断「已登录」后写的 success 可能先到，随后这条旧的
   * 「第 N 次尝试中…」才送达，把 success 覆盖回 running，用户看到的就是
   * 「明明登录成功了却一直显示正在尝试」。
   */
  stateAt: 0,
  /** 静默模式是否正在跑（用于 popup 显示「停止」按钮） */
  silentRunning: false,
  /** 静默模式累计请求次数与最近一次的判定结果 */
  silentRequests: 0,
  silentLastKind: '',
  /** 最近一次验证码 dataURL，供 popup 展示 / 人工输入 */
  pendingCaptcha: '',
  pendingCaptchaAt: 0,
  logs: [],
});

/** 日志最多保留条数 */
export const MAX_LOG_ENTRIES = 120;

/** 验证码 dataURL 长度上限，超过不写入 storage，避免撑爆配额 */
export const MAX_CAPTCHA_DATA_URL_LENGTH = 200000;

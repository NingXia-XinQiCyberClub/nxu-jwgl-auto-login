# 架构说明（Chrome 扩展版）

本文面向后续维护者，说明 `extension/` 内部是怎么组织、消息怎么走、登录流程怎么推进。所有描述都以当前代码为准；改动实现后请同步更新本文。

---

## 1. 为什么从「服务端裸 POST」改成「页面内填表提交」

原 Python 版（`legacy/python/login.py`）是一个典型的「脚本模拟登录」：

```text
GET  /index.action            -> Set-Cookie: JSESSIONID=...
GET  /captcha/image.action    -> 验证码图片（绑定上面那个 JSESSIONID）
POST /login.action            -> loginForm.name / loginForm.password / loginForm.captcha
```

这条链路有三个隐含前提，任何一环断了都会失败：

1. 必须**自己维护** `requests.Session`，否则 `JSESSIONID` 丢失；
2. 验证码**和 session 绑定**，先取图再 POST 的顺序不能乱，中途换 session 验证码就作废；
3. 必须**复刻**表单字段名（`loginForm.name` 等）和 `request_locale`，站点一改就全废。

在浏览器里，这三件事本来就是浏览器自己在做的：Cookie jar 由浏览器维护，验证码请求和登录提交天然共享同一个会话。所以扩展改成「**在页面里填表、然后提交表单**」：

- 不需要读取或搬运任何 Cookie；
- 不存在「验证码与 session 不匹配」这一类失败；
- 站点改了字段名，只需要改 DOM 选择器（见 §9），不用重新推演 HTTP 协议；
- 登录成功后浏览器自己跟着跳转，扩展只负责观察页面变化来判断结果。

代价是扩展必须运行在有登录表单的那个页面上（content script），并且需要该站点的 host 权限。这是有意的取舍。

---

## 1.5 静默模式：为什么又回到了「后台裸请求」

页面填表模式很好用，但它有一个根本限制：**必须先有一个标签页停在那张登录页上**。而用户真正想要的场景是「我要抢课 / 我要蹲成绩，希望系统一开就自动把我塞进去，别在我眼前刷新」。

所以扩展保留了第二条路径：`background/silent-login.js`。它做的正是原 Python 脚本做的事 —— 在 service worker 里循环「取验证码 → OCR → POST 登录」，成功后再开页面。

关键设计点：

1. **仍走浏览器 Cookie 罐**。`fetch` 使用 `credentials: 'include'`，和页面共享同一份 Cookie（WebVPN 场景下是 `wengine_vpn_ticketwebvpn_nxu_edu_cn`，站点把服务端会话绑在这张票上）。所以「后台请求成功」和「随后打开的页面是登录态」是同一份会话，不需要搬运任何 Cookie。
2. **入口地址必须由用户提供**。校外访问要经过 WebVPN，地址形如 `https://webvpn.nxu.edu.cn/https-443/<hex>/index.action`，那串 hex 是每个会话生成的，无法推导，只能复制。`deriveAppBase` 把入口裁剪到 `<origin>/https-443/<hex>/`，再拼 `/captcha/image.action`、`/login.action`、`/index.action`。校内直连则退化为 `https://jwgl.nxu.edu.cn/`。
3. **只能配 OCR**。后台没人能看图打字，`resolveSilentPlan` 在 `ocr.provider === 'manual'` 时直接拒绝启动，并说明原因。
4. **错误必须分类**，否则会误伤账号：

| 站点反馈 | 分类 | 处置 |
| --- | --- | --- |
| 「验证码不对」 | `captcha` | 可重试，换图继续 |
| 「账户不存在」「密码错误」 | `credentials` | **立即停止**，不再重试，避免拿错密码反复刷把账号刷锁 |
| 登录表单消失且无错误文案 | 成功 | 停循环 → 开页面 |
| 其它 / 网关页 / 空响应 | `unknown` | 记为失败，继续重试但不再开页面 |

5. **成功判据要防误判**：只有「登录表单消失」还不够 —— 502 网关页、会话过期页也没有登录表单。所以判定要求**同时**满足「没有 `loginForm.name`」和「没有错误文案」，并且排除「页面看起来像网关/会话错误页」的情形。

6. **识别失败不消耗尝试次数**。实测百度 OCR 有相当比例的「只认出 1 个字母」，拿这种结果去 POST 只会换回「验证码不对」，白烧一次请求和一次配额。所以 `solveCaptcha` 对过短结果直接抛错，循环里换图重试；但用 `MAX_CAPTCHA_RETRIES_TOTAL` 兜住总数，避免 OCR 整体坏掉时死循环。

7. **百度是 1 QPS**（免费版）。`error_code === 18` 表示限流，`ocr.js` 内部退避重试 3 次，而不是当成识别失败。间隔设得太小不会提高成功率，只会更多撞限流。

---

## 2. 模块职责

| 文件 | 运行上下文 | 职责 |
| --- | --- | --- |
| `manifest.json` | — | MV3 清单。声明权限（`storage` / `scripting` / `activeTab` / `notifications`）、默认站点 host 权限、`optional_host_permissions`（`http://*/*`、`https://*/*`）、图标、popup / options 入口，以及**默认站点**的静态 content script（`run_at: document_end`，`all_frames: false`）。`minimum_chrome_version: 102`。 |
| `src/shared/constants.js` | ESM | 唯一常量源：`STORAGE_KEYS`、`DEFAULT_SERVER_URLS`、`OCR_PROVIDERS`、`STATUS`、`MSG`、`CONTENT_MSG`、`DEFAULT_SETTINGS`、`DEFAULT_STATE`、日志与验证码长度上限。新增设置字段必须同时在这里给默认值。 |
| `src/shared/storage.js` | ESM | `chrome.storage.local` 封装，无业务逻辑：`getSettings` / `setSettings` / `patchSettings`、`getState` / `setState` / `patchState` / `resetState`、`appendLog`、`setPendingCaptcha`、`onStorageChanged`、`deepMerge`、`normalizeSettings`、`normalizeOrigin`、`normalizeEntryUrl`。负责默认值补齐、深合并、数值裁剪、URL 规范化。所有改状态的入口都串在 `withStateLock` 队列上（见 §6.1），避免并发写互相覆盖。 |
| `src/shared/messaging.js` | ESM | 消息信封：`send(type, payload)` 统一把 `{ok:true,data}` / `{ok:false,error}` 解包成值或异常；`handleMessages(handlers)` 在 service worker 侧注册处理器；导出便捷 `api` 对象。 |
| `src/shared/ocr.js` | ESM（在 service worker 内执行） | 验证码识别适配层。`solveCaptcha({dataUrl, expectedLength}, settings)` 按 `ocr.provider` 分派到百度 / 自建服务 / 直接报错；`testOcr(settings)` 做连通性自检；`cleanCaptchaText` 清洗为纯字母数字；`pickByPath` 支持 `a.b.0.c` 取值。百度走 `accurate_basic`（高精度版），`access_token` 在内存里缓存（worker 被回收即失效），`error_code 18`（QPS 限流）内部退避重试。所有外部请求 12 秒超时。 |
| `src/background/service-worker.js` | MV3 service worker（`type: module`） | 编排层：消息路由（`handleMessages`）、设置写入后广播、验证码图片下载（`fetch`, `credentials:'include'`）、系统通知、备用站点权限申请、动态注册 / 卸载备用站点的 content script、安装与启动时的初始化、静默登录的启停与「成功后开页面」。**不做**DOM 操作，也不写 OCR 细节。 |
| `src/background/silent-login.js` | ESM（service worker 内） | 静默登录核心：`deriveAppBase` / `buildEndpoints`（从入口推导验证码与登录接口，保留 WebVPN hex 前缀）、`classifyLoginResponse`（把响应分成 `success` / `captcha` / `credentials` / `unknown`）、`resolveSilentPlan`（启动前校验）、`SilentLoginRunner`（循环、间隔、上限、取消、成功开页面）。外部依赖全部通过构造函数注入，便于脱离浏览器单测。 |
| `src/content/dom-adapter.js` | content script（经典脚本） | DOM 适配层。所有选择器数组、`isUsable` 可见性判断、`findLoginForm` / `isLoginPage` / `detectLoggedIn`、`setInputValue`（原生 setter + `input`/`change`/`blur` 事件）、`captchaImageToDataUrl`（canvas）、`refreshCaptcha`、`submitLoginForm`、`pageSignature`、`sleep`、`waitForImageLoad`。挂到 `globalThis.JWGLDom`。 |
| `src/content/content-script.js` | content script（经典脚本） | 登录状态机 + 悬浮面板。加载设置 / 状态、判断是否登录页、按 `captcha.mode` 与 `ocr.provider` 决定 OCR 还是人工输入、写表单、提交、等待并判定结果、重试循环、失败/成功收尾、发通知；面板 UI 全在 Shadow DOM（宿主 `#jwgl-auto-login-root`）。 |
| `src/content/content.css` | content script 样式 | **只**负责宿主元素的定位、层级与样式隔离（`all: initial`、`position: fixed`、`z-index`、`isolation`）。卡片内部的样式写在 `content-script.js` 的 `OVERLAY_CSS` 里。 |
| `src/popup/` | 扩展页面（ESM） | `popup.html` / `popup.css` / `popup.js`。工具栏弹窗：读 `settings` + `state` 渲染状态点、尝试次数、最近 4 条日志；判定当前标签页是否教务系统（先看 `tab.url`，读不到就用 `content/get-page-info` 探测）；主按钮在教务页发 `content/run`、否则打开主地址；验证码卡片把 `state.pendingCaptcha` 转交 `content/submit-captcha`；「清空状态」通过 `state/patch` 复位（不动 `settings`）。`tabs.sendMessage` 带 5s 超时兜底。 |
| `src/options/` | 扩展页面（ESM） | `options.html` / `options.css` / `options.js`。设置页：账号密码、服务器地址列表（含备用 IP 快捷 chip）、验证码方案三选一与百度/自建参数、`enabled` / `autoSubmit` / 重试次数 / 间隔 / 超时 / 启动延迟 / 验证码长度、面板与通知开关、调试开关、OCR「测试识别服务」、导入 / 导出（默认脱敏，可选完整）、恢复默认。保存时先 `validate()`，再在**同一次点击栈**里同步发起 `chrome.permissions.request`（避免丢失用户手势），最后 `settings/patch`。 |

> 备注：`popup` / `options` 页面里直接使用 `chrome.permissions.request` 申请备用站点权限（必须在用户手势内），只有这一步失败时才退回 `action/request-origin` 让 service worker 再试一次——因为跨上下文消息会把用户手势消耗掉。

**边界约定**：`background` 只知道「消息 + 存储 + 网络」，`content` 只知道「DOM + 流程 + UI」，两者通过 §3 的协议通信；`shared` 不含 DOM，也不含 `chrome.tabs` 之类的编排调用。

---

## 3. 消息协议

### 3.1 信封

所有跨上下文消息统一为：

```js
{ type: 'xxx/yyy', payload: { ... } }
```

响应统一为 `{ ok: true, data: ... }` 或 `{ ok: false, error: '...' }`。`messaging.js` 的 `handleMessages` 用 `Promise.resolve().then(...)` 包装处理器并 `return true`（异步响应）；未注册的 `type` 直接 `return false`，不占用通道。

### 3.2 发往 background（`MSG`，定义于 `src/shared/constants.js`）

| 类型 | 方向 | payload | 成功返回值（`data`） |
| --- | --- | --- | --- |
| `settings/get` | content / popup / options → bg | 无 | 规范化后的 `settings`（已补默认值） |
| `settings/patch` | content / popup / options → bg | 任意设置片段 `{...}` | 合并并规范化后的完整 `settings`；同时向所有标签页广播 `broadcast/settings-changed` |
| `state/get` | content / popup / options → bg | 无 | 合并默认值后的 `state` |
| `state/patch` | content / popup / options → bg | 状态片段 `{...}` | 落盘后的完整 `state` |
| `log/append` | content / popup / options → bg | `{ message, level }`，`level ∈ info\|warn\|error\|success` | `{ logged: boolean }`（空消息返回 `logged:false`） |
| `action/run-login` | popup / options → bg | 无（按 `sender.tab` 定位，缺失时回退当前窗口活动标签页） | `{ injected: boolean }` |
| `action/run-login-in-tab` | popup / options → bg | `{ tabId }` | `{ injected: boolean }`；`tabId` 非法时报错 |
| `action/ocr-solve` | content / popup → bg | `{ dataUrl, expectedLength }` | `{ text, provider, elapsedMs }`；失败时抛错并写一条 warn 日志 |
| `action/ocr-test` | popup / options → bg | 无 | `{ provider, ok: true, detail }`（manual 直接通过；baidu 验证凭证；remote 用 1×1 探针图请求一次） |
| `action/fetch-captcha` | content → bg | `{ url }`（绝对 http/https 地址） | `{ dataUrl }`；强制 `credentials:'include'`、`cache:'no-store'`、12 秒超时；先看 `Content-Type`，非 `image/*` 且不是 `application/octet-stream` 一类时直接拒绝，缺失/笼统时用文件头魔数兜底 |
| `action/notify` | content → bg | `{ title?, message }` | `{ shown: true, id }`；失败返回 `{ shown:false, error }`（不抛错，只记 warn 日志） |
| `action/request-origin` | popup / options → bg | `{ origin }` | `{ granted, origin, pattern }`；内部 `chrome.permissions.request({origins:[origin+'/*']})`，**必须在用户手势内调用** |
| `action/register-scripts` | popup / options → bg | 无 | `{ registered: [{ id, origin }] }`；按当前 `settings.serverUrls` 重同步动态 content script |
| `misc/ping` | 任意 → bg | 无 | `{ version, at }` |
| `broadcast/settings-changed` | bg → content | `{ settings }` | content 回 `{ ok:true, data:{ applied:true, settings } }`（无 content script 的标签页会 reject，bg 侧 `.catch(() => undefined)` 静默忽略） |

### 3.3 发往 content script（`CONTENT_MSG`）

| 类型 | 方向 | payload | 响应 |
| --- | --- | --- | --- |
| `content/run` | bg / popup → content | 无 | `{ ok:true, data:{ started, reason }, started }`。正在运行时 `started:false`、`reason:'正在登录中'` 并记一条 warn 日志 |
| `content/submit-captcha` | popup / overlay → content | `{ text }` | 成功 `{ ok:true, data:{ accepted:true, expectedLength } }`；无等待中的输入或文本为空时 `{ ok:false, error }` |
| `content/cancel` | bg / popup → content | 无 | `{ ok:true, data:{ cancelled:true }, cancelled:true }` |
| `content/get-page-info` | popup → content | 无 | `{ ok:true, data: info, ...info }`（两种消费方式都给）。`info` 字段：`isLoginPage`、`hasUsername`、`hasPassword`、`hasCaptchaImage`、`loggedIn`、`running`、`status`、`attempts`、`maxAttempts`、`awaitingCaptcha` |
| `broadcast/settings-changed` | bg → content | 见 3.2 | 重新 `loadSettings()`，只更新面板文案与开关，**不会**因为把 `enabled` 改成 true 就立刻触发登录 |

### 3.4 两个实现细节

- `content-script.js` 是经典脚本，无法 `import` ESM 版的 `constants.js`，所以它**在文件顶部复制了一份**自己用到的 `MSG` / `CONTENT_MSG` 子集（`settings/get`、`state/get`、`state/patch`、`log/append`、`action/ocr-solve`、`action/fetch-captcha`、`action/notify`，以及四个 `content/*` 和 `broadcast/settings-changed`）。改协议时必须两边一起改。
- `messaging.js` 导出的 `api` 只覆盖了常用的几个方法（`getSettings` / `patchSettings` / `getState` / `patchState` / `log` / `runLoginInTab` / `ocrSolve` / `ocrTest` / `notify` / `requestOrigin` / `registerScripts` / `ping`）；`action/fetch-captcha` 目前由 content script 直接 `send`，没有进 `api`。
- `action/run-login` 与 `action/run-login-in-tab` 是给「不在页面内也要能触发登录」预留的后台入口，当前 popup 直接对标签页 `chrome.tabs.sendMessage(CONTENT_MSG.RUN)` 并自带 5s 超时，没有走这两个处理器；`api.runLoginInTab` 也暂未被 UI 调用。改注入策略时注意这里有两套等价路径。

---

## 4. 登录状态机

状态值来自 `STATUS`：`idle` / `running` / `need-input` / `success` / `failed`，持久化在 `state.status`，同时驱动面板颜色和主按钮文案。除持久化状态外，内存里还有几个**不落盘**的运行标志：

| 标志 | 含义 |
| --- | --- |
| `runtime.running` | 整个流程是否在跑（防重入） |
| `runtime.cancelled` | 用户取消标记，所有等待点都会检查它 |
| `runtime.dismissed` | 用户手动关掉面板，不再自动弹出 |
| `runtime.resultVisible` | 有结果卡片要展示（成功/失败），避免普通页面弹面板 |
| `runtime.captchaOpen` | 正在等待人工输入验证码 |
| `runtime.persisted` | 上次落盘的 `{status, attempts, maxAttempts}`，用于刷新后接着计数 |

### 4.1 启动

```text
init():
  await Promise.all([loadSettings(), loadState()])
  renderOverlay()
  onLoginPage = await waitForLoginPage(3000)      // 轮询 username+password，200ms 一次
  if runtime.running: return                       // 初始化期间已被 RUN 抢先
  if not onLoginPage:
      if detectLoggedIn(): status=success("已处于登录状态")
      else:                status=idle("当前页面没有登录表单")
      return
  status = idle
  if settings.enabled:
      setTimeout(startLogin('auto'), settings.advanced.startDelayMs)   // 默认 400ms
  else:
      message = "自动登录已暂停，点击开始登录"
```

`startLogin(trigger)` 负责防重入、清掉待执行的自动启动定时器、复位 `cancelled/dismissed`、确保面板已建，然后进 `runLoginFlow(trigger)`；`finally` 里复位 `running/cancelled`、结算残留的验证码等待者、关闭验证码区、重绘面板。

### 4.2 主循环

```text
runLoginFlow(trigger):
  if username 或 password 为空:
      status = need-input("请先在设置里填写学号与密码")
      return

  if not isLoginPage():
      if detectLoggedIn(): status = success("已处于登录状态")
      else:                status = idle("当前页面没有登录表单")
      return

  maxAttempts = clamp(settings.captcha.maxAttempts, 1, 20, 5)
  delayMs     = clamp(settings.captcha.delayMs, 0, 60000, 1200)

  // 刷新续跑：只有「自动触发」且上次落盘仍是 running 才继承次数
  resumeFrom = (trigger == 'auto' && persisted.status == 'running')
                 ? min(persisted.attempts, maxAttempts) : 0
  if resumeFrom >= maxAttempts:
      status = failed("已尝试 N 次仍失败...")
      return

  status = running; attempts = resumeFrom
  for attempt in resumeFrom+1 .. maxAttempts:
      if cancelled: throw Cancelled
      patchState(attempts: attempt-1, message: "第 attempt 次尝试中…")
      try:
          await attemptOnce(attempt)      // 内部成功时自己把状态置 success
          return
      catch e:
          if e.code in ('cancelled', 'fatal'): throw e
          lastReason = e.message
          patchState(status: 'running', attempts: attempt,
                     message: "第 attempt 次未成功，准备重试…", lastError: lastReason)
          if attempt < maxAttempts:
              await refreshCaptchaQuietly()   // 点一下验证码图换一张
              await sleepCancellable(delayMs) // 120ms 分片，可被取消打断
  status = failed("已尝试 N 次仍失败：lastReason ...")
```

**为什么需要 `resumeFrom`**：教务系统的失败常常是「整页刷新回登录页」，content script 会随之重启。如果每次重启都从第 1 次数起，就会变成无限重试。这里靠 `state` 里落盘的 `attempts` 接上进度。

**关键约束：进度必须在「提交之前」落盘。** 提交登录表单会触发整页跳转，本文档的 JS 随即被销毁，`await` 之后的代码不再执行。如果只在等到结果后才写 `attempts`，刷新后该字段仍是 0，`resumeFrom` 永远为 0，验证码持续错误时就会无限重试。因此 `attemptOnce()` 在调用 `submitLoginForm()` 之后、`await waitForLoginResult()` 之前，先执行 `persistAttemptProgress(attempt, maxAttempts)`：

```text
persistAttemptProgress(attempt, maxAttempts):
    runtime.persisted = { status: 'running', attempts: attempt, maxAttempts }
    // 只发不等：页面此刻可能正在导航，await 会让消息被中途丢弃
    void trySend(state/patch, { status:'running', attempts: attempt, maxAttempts, origin })
```

消息一旦抵达 service worker，就会由它独立完成 `chrome.storage.local` 写入，不受页面销毁影响。这是「跨导航保持状态」的唯一可靠做法。

### 4.3 单次尝试

```text
attemptOnce(attempt):
  form = locateForm(5000)                       // 找不到 username/password 直接抛错
  setInputValue(username, 学号)
  setInputValue(password, 密码)

  dataUrl = obtainCaptcha(form)                 // §5
  expectedLength = captcha.length or captchaInput.maxLength (<=12)

  captchaText = ''
  if captcha.mode != 'manual' and ocr.provider != 'manual':
      try:
          { text } = OCR_SOLVE({dataUrl, expectedLength})
          captchaText = 清洗为字母数字，按长度截断
      catch:
          log warn("自动识别验证码失败，改为手动输入：…")   // 回退，不终止
  if not captchaText:
      captchaText = await showCaptchaPrompt(dataUrl, expectedLength)  // 人工输入

  setInputValue(当前页面最新的 captchaInput, captchaText)

  beforeSignature  = pageSignature()
  beforeCaptchaSrc = 当前验证码图 src

  if autoSubmit == false:
      log "已填写完成，按设置未自动提交"
      waitMs = 60000
  else:
      提交兜底链：form.requestSubmit(button) → button.click() → 在验证码框上派发 Enter keydown
      waitMs = 15000

  result = await waitForLoginResult(beforeSignature, waitMs, beforeCaptchaSrc)
  if not result.ok: throw Error(result.reason)

  status = success("登录成功（第 attempt 次尝试）"), lastSuccessAt = now
  if ui.notifyOnSuccess: NOTIFY("教务系统登录成功", ...)
  scheduleAutoDismiss()                         // ui.autoDismissMs，默认 8s
```

### 4.4 结果判定（`waitForLoginResult`）

每 300ms 采样一次，按优先级：

| 观察到的现象 | 判定 |
| --- | --- |
| `detectLoggedIn()` 为真（登录框消失且出现「退出 / 我的课表 / 成绩查询」等标记） | 成功：`已检测到登录态` |
| 密码框消失 | 成功：`登录框已消失` |
| 验证码图片 `src` 变了，或验证码输入框被清空 | 先等 500ms 复核；仍是登录页则失败，原因取页面错误文案或 `本次尝试未通过` |
| `pageSignature()`（`href + body 前 200 字`）变化 | 给 2.5s 宽限期复核跳转；仍停在登录页则失败：`页面已刷新但仍停留在登录页` |
| 一直没变化直到超时 | 失败：`等待登录结果超时` |

失败原因会先用正则从页面文本里提取「验证码/密码/用户名/账号/学号 + 错误/不正确/无效/失败/超时」附近的一段，提取不到才用上面的默认文案。

`cancelled` 错误在任意等待点都会抛出并向上传播到 `startLogin`，最终落成 `status = idle` +「已取消本次登录」；`fatal` 错误（如关掉了悬浮面板导致无法人工输入）落成 `status = failed`。

### 4.5 人工输入验证码的接口

`showCaptchaPrompt(dataUrl, expectedLength)` 返回 Promise：

- `resolve(验证码字符串)`：面板点「确认」、回车、或收到 `content/submit-captcha`；
- `reject(code='cancelled')`：用户取消、关面板、超过 `captcha.solveTimeoutMs`（默认 120s）；
- `reject(code='fatal')`：`ui.showOverlay === false` 或面板初始化失败——这两种情况下没法人工输入。

`dismissOverlay()` 只收起界面、不打断正在跑的自动登录；但如果此刻正等验证码，关面板等于放弃输入，会取消整个流程。

---

## 5. 验证码数据流

```text
① 页面内取图（首选）
   <img> 验证码
     → Dom.waitForImageLoad(img, 1500)
     → Dom.captchaImageToDataUrl(img)
         canvas.drawImage(img) → canvas.toDataURL('image/png')
   ★ 同源时可用；跨域污染会抛 SecurityError，函数内部 catch 后返回 ''。

② 失败则回后台抓（兜底）
   content --MSG.FETCH_CAPTCHA {url}--> service worker
     fetch(url, { credentials:'include', cache:'no-store' })   // 复用页面 Cookie jar
     → arrayBuffer → Content-Type 校验 / 魔数兜底
     → base64（分块拼接，避免 String.fromCharCode 爆栈）
     → data:image/xxx;base64,...
   ★ credentials:'include' 保证抓到的验证码与页面上的会话是同一个。

③ 识别（仅 auto 模式且 provider != manual）
   content --MSG.OCR_SOLVE {dataUrl, expectedLength}--> service worker
     solveCaptcha():
       baidu  → POST https://aip.baidubce.com/oauth/2.0/token 取 access_token（内存缓存）
                → POST /rest/2.0/ocr/v1/general_basic  (application/x-www-form-urlencoded, image=base64)
                → words_result[0].words
       remote → POST 或 GET 到用户配置的 endpoint
                POST body: { [fieldName]: dataUrl }（默认 {"image": "data:image/png;base64,..."}）
                响应按 responsePath 取值（默认 result，支持 a.b.0.c）
       manual → 直接抛错（不会走到这里）
     cleanCaptchaText(): 去空白、只留 [0-9a-zA-Z]、按 expectedLength 截断
   ★ 所有外部请求 12s AbortController 超时，credentials:'omit'。

④ 回填
   识别失败（抛错或结果为空）→ 记 warn 日志 → 回退到人工输入，不终止本次尝试。
   拿到文本 → Dom.setInputValue(最新的 captchaInput, text) → 提交。
```

「看不清？换一张」走 `Dom.refreshCaptcha(img, 400)`（派发 click + `img.click()` 并等 `src` 变化后重新取 dataURL），失败再退到 ② 并带 `?t=时间戳` 破缓存。

---

## 6. 存储模型

只有两个 key（`STORAGE_KEYS`）：

| key | 内容 | 写入方 |
| --- | --- | --- |
| `settings` | 用户配置：`schemaVersion`、`enabled`、`autoSubmit`、`serverUrls`、`credentials{username,password}`、`captcha{mode,maxAttempts,delayMs,solveTimeoutMs,length}`、`ocr{provider,baidu{apiKey,secretKey},remote{endpoint,method,fieldName,responsePath,headers}}`、`ui{showOverlay,notifyOnSuccess,autoDismissMs}`、`advanced{startDelayMs,debug}`、`silent{enabled,entryUrl,intervalMs,maxAttempts,openOnSuccess,targetPath,stopOnCredentialError,autoStart}` | 设置页 / 弹窗（经 `settings/patch`） |
| `state` | 运行状态：`status`、`message`、`attempts`、`maxAttempts`、`lastRunAt`、`lastSuccessAt`、`lastError`、`origin`、`mode`、`silentRunning`、`silentRequests`、`silentLastKind`、`stateAt`、`pendingCaptcha`、`pendingCaptchaAt`、`logs[]` | content script（经 `state/patch`、`log/append`）、background（`patchState`、`appendLog`、`resetState`、静默循环） |

### 6.1 默认值补齐与深合并

- 读取：`getSettings()` = `normalizeSettings(deepMerge(DEFAULT_SETTINGS, stored))`。旧版本存的数据缺字段时，缺的部分由默认值填上，因此**升级不会丢设置**。
- 合并规则（`deepMerge`）：`undefined` 不覆盖；两边都是纯对象则递归；**数组整体替换**（不按元素合并）；其他值直接深拷贝（优先 `structuredClone`，失败退 `JSON`）。
- 写入：`setSettings` / `patchSettings` 都会再跑一遍 `normalizeSettings`，所以落盘的永远是规范化后的值。
- 规范化要点：`serverUrls` 逐个 `normalizeOrigin`（补 `https://`、只保留 origin、去重、非法丢弃、空则回默认）；`credentials.username` 去首尾空白；`captcha.maxAttempts` 落 1–20、`delayMs` 落 0–60000、`solveTimeoutMs` 落 5000–600000、`length` 落 0–12；`ocr.provider` 只认 `manual|baidu|remote`；`ocr.remote.method` 只认 `GET|POST`。
- `getSettings` 额外兜底：`serverUrls` 为空数组时重置为默认站点（防止用户清空后扩展彻底失效）。
- 日志：`MAX_LOG_ENTRIES = 120`，`appendLog` 和 `setState` 都会 `slice(-120)`；`level === 'error'` 时同步写 `state.lastError`。
- 验证码图片：`MAX_CAPTCHA_DATA_URL_LENGTH = 200000`，超长的 dataURL 不落盘（`setPendingCaptcha` 存空串，content script 侧直接删掉这两个字段），避免撑爆 `storage.local` 配额。
- 订阅：`onStorageChanged` 只关心 `areaName === 'local'`，回传 `{settings?, state?}`，用于 background 同步动态脚本、content 更新面板。

### 6.1.1 为什么状态写入要串行 + 带时间戳

`chrome.storage.local` 没有原子更新，而状态有多个写入方：页面里的 content script、popup、service worker 的静默循环。两个真实踩过的坑：

1. **丢更新**：「页面写 success」和「后台追加一条日志」几乎同时发生，两边读到同一份旧值，后写的一方把前一方整个覆盖掉 —— 结果是状态对了日志没了，或者反过来。解决：`withStateLock` 把读—改—写串到一条 Promise 链上（见 `storage.js`），代价几毫秒。
2. **迟到消息覆盖新状态**：提交登录表单会让页面立刻整页跳转，旧文档被销毁前发出的 `state/patch{status:'running', attempts:N}` 还堵在消息管道里；新页面的 content script 判断「已登录」后写的 `success` 往往先到，随后这条旧消息才送达，界面就永远停在「第 N 次尝试中…」。解决：每条页面消息带 `stateAt = Date.now()`（产生时刻，而不是到达时刻），service worker 的 `patchStateGuarded` 丢弃 `stateAt` 比库里更旧的消息。`appendLog` 不刷新 `stateAt`，否则一条旧消息会因为「追加了日志」而变新。

顺带一个相关的体验修正：登录成功后是新页面在跑 `init()`，要靠 `state.attempts` 把次数接上，才能显示「登录成功（第 N 次尝试）」而不是笼统的「已处于登录状态」——因为旧页面那句成功文案来不及写。

### 6.2 多站点与动态注册

`serverUrls` 里的**默认站点**（`DEFAULT_SERVER_URLS[0]`，即 `https://jwgl.nxu.edu.cn`）由 `manifest.json` 静态声明；**其余 origin**（包括用户排在第一位、但不是默认域名的地址）由 service worker 动态注册：

```text
settings 变化 / onInstalled / onStartup
  → serverUrlsSignature(serverUrls)   // 规范化 + 排序 + 去重的指纹
  → 指纹没变就跳过
  → syncDynamicScripts()              // 串行链 syncChain，避免并发互删
      expected = 非默认 origin 逐个映射成 { id: 'jwgl-dynamic-<i>', origin }
      与 chrome.scripting.getRegisteredContentScripts() 比对（按 id + matches）
      不相同 → 先全部卸载 → 再逐个 registerContentScripts
        ① 带 css 注册
        ② 失败则退回纯 JS（例如 content.css 缺失）
      persistAcrossSessions: true，runAt: 'document_end'，allFrames: false
```

注册脚本的 `js` 顺序敏感：`dom-adapter.js` 必须排在 `content-script.js` 前面。也正因为动态注册依赖 host 权限，添加备用地址时要在设置页里走 `action/request-origin` 申请权限（`chrome.permissions.request` 必须在用户手势内调用）。

---

## 7. 零构建设计

仓库里没有 `package.json`、没有打包器、没有 `dist/`。理由：这是一个只有几个文件的小扩展，构建链带来的复杂度大于收益；而且「加载已解压的扩展程序」本来就要求源码目录可直接运行。

两种模块形态并存，各用各的：

| 上下文 | 形态 | 共享方式 |
| --- | --- | --- |
| service worker（`type: "module"`）、popup / options 页面 | 原生 ESM：`import { ... } from '../shared/xxx.js'` | 正常 `import` / `export` |
| content script（经典脚本） | 两个 IIFE，无 `import` / `export` | 通过 **content script 隔离世界的 `globalThis`** 共享：`dom-adapter.js` 先执行并挂 `globalThis.JWGLDom`，`content-script.js` 读它（缺失时 `Dom` 为 `undefined`，所有调用都走防御式包装，仅 `debug` 提示，不抛错） |

content script 用经典脚本的**原因**：`manifest.json` 的 `content_scripts.js` 不支持 ESM 语法（MV3 至今如此），动态 `chrome.scripting.registerContentScripts` 也一样。要用 ESM 就得引入打包器，与零构建目标冲突。

由此带来的两条纪律：

1. **`constants.js` 不能直接被 content script 引用**，所以 `content-script.js` 顶部复制了协议常量和一份 `FALLBACK_SETTINGS`（仅用于 background 未就绪时保证 UI 可用）。改协议/默认设置要同步这两处。
2. **幂等保护**：`dom-adapter.js` 用 `if (globalThis.JWGLDom) return`，`content-script.js` 用 `if (globalThis.__JWGL_CONTENT_LOADED__) return`。background 可能对同一标签页重复注入（先 `sendMessage` 失败 → 注入 → 再 `sendMessage`），重复执行必须无害。

面板样式也遵循同样的隔离思路：宿主 `#jwgl-auto-login-root` 由 `content.css` 做 `all: initial` + `fixed` 定位，卡片内部样式全在 Shadow DOM 的 `<style>` 里，站点那套 Struts2 全局样式进不来，我们的样式也不会污染站点。

---

## 8. 安全边界

- 密码只存在 `chrome.storage.local`，不参与任何网络请求；`ocr.js` 的所有请求都是 `credentials: 'omit'`，只带验证码图片。
- `fetchCaptchaAsDataUrl` 只接受 `http/https` 绝对地址，并拒绝非图片响应（先看 `Content-Type`，笼统类型才用魔数兜底），避免被当成任意 URL 代理。
- `action/run-login` 会校验 `sender.tab` 的 URL：命中 `settings.serverUrls` 或 `*.nxu.edu.cn` 才继续；`tab.url` 读不到时（未申请 `tabs` 权限）不武断拒绝，交给后续 `sendMessage` / 注入的结果判断。`action/run-login-in-tab` 只校验 `tabId` 是否为正整数，URL 判断交给注入是否成功。
- `action/request-origin` 只接受规范化后的 origin，权限范围是 `<origin>/*`，且依赖用户点击手势，service worker 不能自行提权。
- content script 全部 DOM 操作都在扩展的隔离世界里，不与页面脚本共享变量；面板用 Shadow DOM，站点 CSS 无法选中内部元素。

---

## 9. 站点改版时的改动点

**首选只改 `src/content/dom-adapter.js` 顶部的选择器数组**，按数组顺序逐个 `querySelectorAll` 并取第一个「可用」元素（未 disabled / 未 readonly / 非 `display:none`|`visibility:hidden`|`opacity:0` / 有非零尺寸）：

| 数组 | 覆盖的字段 |
| --- | --- |
| `USERNAME_SELECTORS` | `input[name="loginForm.name"]`、`*userName*`、`*username*`、`*account*`、`*studentNo*`、`*xh*`，最后兜底 `input[type="text"]` |
| `PASSWORD_SELECTORS` | `input[name="loginForm.password"]`、`input[type="password"]`、`*password*`、`*pwd*` |
| `CAPTCHA_INPUT_SELECTORS` | `loginForm.captcha`、`*captcha*`、`*verify*`、`*validate*`、`*checkcode*` |
| `CAPTCHA_IMAGE_SELECTORS` | `img[name="loginForm.captcha"]`、`img[id*="captcha"]`、`img[src*="captcha"|"validate"|"verify"]`、`img[alt*="验证码"]`、`img[title*="验证码"]`；都找不到时退化为「验证码输入框所在容器里的第一张 `<img>`」 |
| `SUBMIT_SELECTORS` | `input[name="loginForm.submit"]`、`button[type=submit]`、`input[type=submit]`、`button[name*=login]`、`#loginButton`、`a[onclick*=login]` |
| `LOGIN_MARKERS` | 判定「已登录」的页面文本标记。**实测真实落地页 `home.action` 的可见正文只有「选择模块 + 姓名」，「退出登录」藏在折叠菜单里 `innerText` 取不到**，所以这里用的是导航上真实可见的词：`退出登录`、`退出`、`注销`、`培养计划`、`培养方案`、`学籍信息`、`课程管理`、`教材管理`、`个人信息`、`我的课表`、`学生课表`、`成绩查询`、`选课` |
| `LOGGED_IN_URL_PATTERN` | 文字判断的补充：命中 `/home.action` 或 `/main.action` 也算已登录（页面模式与静默模式的落地页 URL 不同，只靠文字会漏） |

需要同步检查的次要位置：

- `content-script.js` 的 `captchaUrl()`：验证码 `<img>` 没有可用 `src` 时的兜底地址写死为 `/captcha/image.action?t=...`；
- `content-script.js` 的 `readPageError()`：失败文案提取正则（关键词表）；
- `background/silent-login.js` 的 `classifyLoginResponse()`：静默模式的错误文案分类（`验证码不对` → `captcha`，`账户不存在`/`密码错误` → `credentials`）；
- `service-worker.js` 的 `isLoginUrlAllowed()`：允许的域名后缀 `nxu.edu.cn`；
- `manifest.json` 的 `content_scripts[0].matches` 与 `host_permissions`：默认站点换域名时要一起改；
- `constants.js` 的 `DEFAULT_SERVER_URLS` / `KNOWN_MIRROR_HINTS`。

登录流程本身（状态机、重试、判定）与具体 DOM 解耦，正常情况下不需要动。

### 9.1 真实站点已确认的事实（2026-10）

这些是实测结论，不要凭猜测改：

- 登录页：`GET <base>/index.action`，表单字段 `loginForm.name` / `loginForm.password` / `loginForm.captcha` / `request_locale=zh_CN`。
- 验证码：`GET <base>/captcha/image.action?t=<毫秒>`，约 90×35 的 JPEG，4–5 位小写字母，输入框 `maxlength=5`。
- **表单 `action` 解析出来是 `https://jwgl.nxu.edu.cn/login.action`，但实际 POST 会被 WebVPN 重写到 `webvpn.nxu.edu.cn/https-443/<hex>/login.action`。** 页面内正常提交即可，不要手动改 action。
- 错误文案在 `<div id="errors">`：验证码错是「验证码不对」，账号不存在是「账户不存在」，密码错是「密码错误」。
- 登录成功后 302 到 `home.action?...`；**响应里没有 `Set-Cookie`** —— WebVPN 场景下服务端会话绑在 `wengine_vpn_ticketwebvpn_nxu_edu_cn` 这张票上，所以同一个浏览器（同一张票）后续任何请求都已是登录态，这正是「成功后开页面即可直接进系统」的基础。
- 登出：`<base>/logout.action`，之后 `index.action` 恢复登录表单。测试「从零登录」必须先登出，否则会误判为「第 1 次就成功」。

---

## 10. 已知限制与 TODO

**已知限制**

1. 只有 `captcha.mode === 'auto'` 时会尝试 OCR；`mode` 被规范化为 `'manual' | 'auto'` 两值，没有「只 OCR、绝不人工」（`ocr.provider` 为 `manual` 时等价于纯人工）。
2. 人工输入依赖悬浮面板；`ui.showOverlay === false` 时若又没配 OCR，本次尝试会以 `fatal` 失败。
3. 登录结果判定是基于 DOM 的启发式（指纹、密码框消失、验证码 src 变化、页面文案正则），站点把登录改成 SPA 弹层或异步跳转时要重新校准。
4. `resumeFrom` 依赖 `state.attempts`；如果登录中途手动清空 state，重试计数会从头开始。
5. 百度 OCR 默认走 `accurate_basic`（高精度版）。实测真实站点验证码：`general_basic` 准确率约 60%、`accurate_basic` 约 90%（20 张样本，用「故意错密码」排除凭据干扰）。失败样本里多数是「只认出 1 个字母」，所以低于 3 字符的结果直接换图重试而不提交。`access_token` 只缓存在内存，service worker 被回收后会重新申请。
6. 百度免费版限 1 QPS；`error_code 18` 在 `ocr.js` 内部退避重试 3 次。静默模式的 `intervalMs` 建议不低于 1000–1500 ms，设更小不会更快。
7. 静默模式的 WebVPN 入口地址必须由用户提供（`/https-443/<hex>/` 里的 hex 每个会话可能不同），无法自动推导。票过期后需要重新复制一次地址。
8. 备用站点的权限必须由用户手势触发申请；`http://*/*`、`https://*/*` 虽然在 `optional_host_permissions` 里，但用户拒绝后只能去 `chrome://extensions` 手动放开。
9. 没有独立的 lint / 打包流程，回归依赖在真实页面上手工验证（仓库里不含自动化测试）。
10. 权限集里没有 `tabs`，未授权站点的 `tab.url` 会是空串；popup 此时靠 `content/get-page-info` 探测，`action/run-login` 则只能放行、依赖后续注入结果判断。
11. 设置页的「测试识别服务」会先把当前 OCR 配置 `settings/patch` 落盘再测，因为后台读的是已保存的设置——这意味着点测试会顺带保存 OCR 相关改动（其他字段不受影响）。
12. `persistAttemptProgress` 依赖「消息在页面卸载前发出」。极端情况下（导航极快、service worker 正冷启动）仍可能丢一次写入，此时该次尝试不会被计数，重试上限会被放宽一次。
13. 导入配置只填表单，必须再点「保存设置」才生效；恢复默认同理。
14. 静默模式跑在 MV3 service worker 里，worker 被回收（约 30 秒无事件）会中断循环。循环每轮都有消息/存储写入，通常能续命；若长时间在等网络，仍可能被回收，此时需要重新点「开始」。

**TODO**

- 为 `shared/storage.js` 的 `deepMerge` / `normalizeSettings` / `withStateLock`、`shared/ocr.js` 的 `pickByPath` / `cleanCaptchaText`、`content-script.js` 的判定函数补单元测试。
- 把默认站点 origin 从 `nxu.edu.cn` / `jwgl.nxu.edu.cn` 硬编码里抽出来，做成可配置项（`popup.js` 的 `isJwglUrl`、`service-worker.js` 的 `isLoginUrlAllowed` 都写死了后缀）。
- 静默模式支持多入口（校内直连 + WebVPN）自动择一，而不是单一入口。
- 支持从多标签页并发登录时共享 `state`，避免互相覆盖 `attempts`。
- 给 `options.js` 的导出/导入加 schema 版本迁移（目前只依赖 `normalizeSettings` 兜底）。

---

## 11. 附：一次完整调用的时序

```text
用户打开 https://jwgl.nxu.edu.cn
  │
  ├─ 浏览器注入 dom-adapter.js → 挂 globalThis.JWGLDom
  ├─ 浏览器注入 content-script.js → 注册 onMessage、init()
  │     ├─ settings/get、state/get  ──────────────► service worker
  │     ├─ 渲染悬浮面板
  │     └─ waitForLoginPage(3000) 成功 → setTimeout(startLogin('auto'), 400)
  │
  ├─ startLogin → runLoginFlow
  │     ├─ attemptOnce
  │     │    ├─ 填学号/密码（原生 setter + input/change/blur）
  │     │    ├─ obtainCaptcha：canvas.toDataURL →（失败）action/fetch-captcha
  │     │    ├─ action/ocr-solve（auto 且 provider != manual）
  │     │    │     或 面板人工输入（content/submit-captcha / 回车 / 超时）
  │     │    ├─ 填验证码 → requestSubmit / click / Enter
  │     │    └─ waitForLoginResult（300ms 轮询，最长 15s）
  │     │         失败 → log/append + state/patch → 换图 → 等 delayMs → 下一次
  │     └─ 成功 → state/patch(status=success) + action/notify + 面板 8s 后自动收起
  │
  └─ 站点自行跳转到首页；若页面刷新，新 content script 从 state 里接上进度
```

### 11.1 静默模式时序

```text
popup「开始后台请求登录」→ silent/start ────────────► service worker
  │
  ├─ resolveSilentPlan(settings)
  │     ├─ silent.enabled ？ ocr.provider != manual ？ 入口地址合法 ？ 学号密码齐全 ？
  │     └─ deriveAppBase(entryUrl) → <origin>/https-443/<hex>/  或  <origin>/
  │        buildEndpoints → { index, captcha, login }
  │
  └─ SilentLoginRunner.start()（单例，防止重复启动）
        for attempt in 1..maxAttempts:
          ├─ GET  <base>/captcha/image.action?t=…
          ├─ OCR（solveCaptcha）── 识别不出/过短 → 换图重试（有总次数上限）
          ├─ POST <base>/login.action  loginForm.name / password / captcha
          ├─ classifyLoginResponse(html)
          │     ├─ success     → 记 lastSuccessAt → 通知 → openOnSuccess 时新开标签页 → 结束
          │     ├─ credentials → 立即结束（不重试，避免刷号）
          │     └─ captcha / unknown → 记日志 → 等 intervalMs → 下一轮
          └─ 全部用尽 → status=failed，不开页面
```

新开的标签页直接用浏览器 Cookie 罐里的会话，所以落地就是登录态（实测 `home.action`，正文含「选择模块 + 姓名」）。

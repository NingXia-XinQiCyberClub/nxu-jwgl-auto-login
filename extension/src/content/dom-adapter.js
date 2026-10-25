/**
 * 教务系统页面的 DOM 适配层（经典脚本，无 ESM，零构建）。
 * 与 content-script.js 共享 content script 隔离世界的作用域，挂到 globalThis.JWGLDom。
 *
 * 原项目是「服务端裸 POST」，改造后改为「在页面内填表提交」，
 * 因此把「怎么找到学号/密码/验证码元素」全部收敛到这里，
 * 站点改版时只需要改这一个文件。
 */
(() => {
  'use strict';
  if (globalThis.JWGLDom) return;

  /** 站点上登录表单可能出现的字段名（Struts2 风格） */
  const USERNAME_SELECTORS = [
    'input[name="loginForm.name"]',
    'input[name*="userName" i]',
    'input[name*="username" i]',
    'input[id*="userName" i]',
    'input[id*="username" i]',
    'input[name*="account" i]',
    'input[name*="studentNo" i]',
    'input[name*="xh" i]',
    'input[type="text"]',
  ];

  const PASSWORD_SELECTORS = [
    'input[name="loginForm.password"]',
    'input[type="password"]',
    'input[name*="password" i]',
    'input[name*="pwd" i]',
  ];

  const CAPTCHA_INPUT_SELECTORS = [
    'input[name="loginForm.captcha"]',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[name*="verify" i]',
    'input[id*="verify" i]',
    'input[name*="validate" i]',
    'input[name*="checkcode" i]',
  ];

  const CAPTCHA_IMAGE_SELECTORS = [
    'img[name="loginForm.captcha"]',
    'img[id*="captcha" i]',
    'img[class*="captcha" i]',
    'img[src*="captcha" i]',
    'img[src*="validate" i]',
    'img[src*="verify" i]',
    'img[alt*="验证码"]',
    'img[title*="验证码"]',
  ];

  const SUBMIT_SELECTORS = [
    'input[name="loginForm.submit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name*="login" i]',
    '#loginButton',
    'a[onclick*="login" i]',
  ];

  /**
   * 已登录特征词。
   * 实测真实落地页（home.action）的可见正文只有：
   *   「教务管理系统 选择模块 <姓名> 培养计划 课程管理 学籍信息 教材管理 系统帮助 毕业论文 … 首页」
   * 「退出登录」藏在折叠菜单里，innerText 取不到；所以必须用导航栏上真实可见的词，
   * 否则登录成功后会被判成「当前页面没有登录表单」。
   */
  const LOGIN_MARKERS = [
    '退出登录',
    '退出',
    '注销',
    '培养计划',
    '培养方案',
    '学籍信息',
    '课程管理',
    '教材管理',
    '个人信息',
    '我的课表',
    '学生课表',
    '成绩查询',
    '选课',
  ];

  /** 已登录时常见的落地页路径（登录页是 index.action，不会命中） */
  const LOGGED_IN_URL_PATTERN = /\/home\.action(?:$|[?#])|\/main\.action(?:$|[?#])/i;

  function isUsable(node) {
    if (!node || node.disabled || node.readOnly) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors, root = document) {
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (isUsable(node)) return node;
      }
    }
    return null;
  }

  function findCaptchaImage(root = document) {
    for (const selector of CAPTCHA_IMAGE_SELECTORS) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (node.src && /^https?:/i.test(node.src)) return node;
      }
    }
    // 兜底：找紧邻验证码输入框的图片
    const input = firstVisible(CAPTCHA_INPUT_SELECTORS, root);
    if (input) {
      const container = input.closest('tr, .form-group, .field, li, div') ?? input.parentElement;
      const img = container?.querySelector('img');
      if (img?.src) return img;
    }
    return null;
  }

  /** 定位登录表单各要素 */
  function findLoginForm(root = document) {
    const username = firstVisible(USERNAME_SELECTORS, root);
    const password = firstVisible(PASSWORD_SELECTORS, root);
    return {
      username,
      password,
      captchaInput: firstVisible(CAPTCHA_INPUT_SELECTORS, root),
      captchaImage: findCaptchaImage(root),
      submit: firstVisible(SUBMIT_SELECTORS, root),
      form: password?.form ?? username?.form ?? null,
    };
  }

  /** 页面是否处于「需要登录」状态 */
  function isLoginPage() {
    const form = findLoginForm();
    return Boolean(form.password && form.username);
  }

  /** 登录成功后的典型特征：登录框消失，且出现已登录菜单或已跳到登录后路径 */
  function detectLoggedIn() {
    if (findLoginForm().password) return false;
    const text = document.body?.innerText ?? '';
    if (LOGIN_MARKERS.some((marker) => text.includes(marker))) return true;
    // 真实站点有两种落地页：
    //   静默模式 → home.action?actionName=home        （正文含完整导航）
    //   页面模式 → home.action?method=index&...       （正文只有「选择模块 + 姓名」，导航在折叠菜单里）
    // 后者用文字判断会漏，所以再看 URL——登录成功后服务端一定会把人从 index.action 送到 home.action。
    return LOGGED_IN_URL_PATTERN.test(`${location.pathname}${location.search}`);
  }

  /**
   * 以「像用户一样输入」的方式赋值，触发框架的 input/change 事件。
   */
  function setInputValue(input, value) {
    if (!input) return false;
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  /**
   * 把验证码图片转成 dataURL。
   * 优先用 canvas（页面同源时可用），跨域污染时返回空串由调用方回退。
   */
  function captchaImageToDataUrl(img) {
    if (!img) return '';
    try {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) return '';
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForImageLoad(img, timeoutMs) {
    return new Promise((resolve) => {
      if (img.complete && img.naturalWidth > 0) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const done = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      img.addEventListener('load', () => done(true), { once: true });
      img.addEventListener('error', () => done(false), { once: true });
    });
  }

  /**
   * 点击验证码图片以刷新，返回新的 dataURL。
   */
  async function refreshCaptcha(img, waitMs = 600) {
    if (!img) return '';
    const before = img.currentSrc || img.src;
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (typeof img.click === 'function') img.click();

    const deadline = Date.now() + Math.max(1500, waitMs * 3);
    while (Date.now() < deadline) {
      await sleep(waitMs);
      const current = img.currentSrc || img.src;
      if (current && current !== before) {
        await waitForImageLoad(img, 2000);
        break;
      }
    }
    return captchaImageToDataUrl(img);
  }

  /** 提交表单 */
  function submitLoginForm(form, submitButton) {
    if (!form) return false;
    if (typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit(submitButton ?? undefined);
        return true;
      } catch {
        /* 继续兜底 */
      }
    }
    if (submitButton && typeof submitButton.click === 'function') {
      submitButton.click();
      return true;
    }
    form.submit();
    return true;
  }

  /** 页面指纹，用于判断提交后是否跳转 */
  function pageSignature() {
    return `${location.href}::${(document.body?.innerText ?? '').slice(0, 200)}`;
  }

  globalThis.JWGLDom = {
    findLoginForm,
    isLoginPage,
    detectLoggedIn,
    setInputValue,
    captchaImageToDataUrl,
    refreshCaptcha,
    submitLoginForm,
    pageSignature,
    sleep,
    waitForImageLoad,
  };
})();

/**
 * 运行时消息封装。所有跨上下文调用都走这里，统一错误处理。
 */

import { MSG } from './constants.js';

/**
 * 发送消息到 service worker。
 * @template T
 * @param {string} type
 * @param {any} [payload]
 * @returns {Promise<T>}
 */
export async function send(type, payload) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, payload });
  } catch (error) {
    throw new Error(`消息通道不可用（${type}）：${error?.message ?? error}`);
  }
  if (!response || response.ok !== true) {
    const message = response?.error || '未知错误';
    throw new Error(message);
  }
  return response.data;
}

/**
 * service worker 侧注册处理器。
 * @param {Record<string, (payload: any, sender: chrome.runtime.MessageSender) => any>} handlers
 */
export function handleMessages(handlers) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (typeof type !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(handlers, type)) return false;

    Promise.resolve()
      .then(() => handlers[type](message.payload, sender))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        console.error(`[jwgl] handler ${type} failed:`, error);
        sendResponse({ ok: false, error: error?.message ?? String(error) });
      });

    return true; // 异步响应
  });
}

export const api = {
  getSettings: () => send(MSG.GET_SETTINGS),
  patchSettings: (patch) => send(MSG.PATCH_SETTINGS, patch),
  getState: () => send(MSG.GET_STATE),
  patchState: (patch) => send(MSG.PATCH_STATE, patch),
  log: (message, level) => send(MSG.LOG, { message, level }),
  runLoginInTab: (tabId) => send(MSG.RUN_LOGIN_IN_TAB, { tabId }),
  silentStart: () => send(MSG.SILENT_START),
  silentStop: () => send(MSG.SILENT_STOP),
  silentStatus: () => send(MSG.SILENT_STATUS),
  ocrSolve: (payload) => send(MSG.OCR_SOLVE, payload),
  ocrTest: () => send(MSG.OCR_TEST),
  notify: (payload) => send(MSG.NOTIFY, payload),
  requestOrigin: (origin) => send(MSG.REQUEST_ORIGIN, { origin }),
  registerScripts: () => send(MSG.REGISTER_SCRIPTS),
  ping: () => send(MSG.PING),
};

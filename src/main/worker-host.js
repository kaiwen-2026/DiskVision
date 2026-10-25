/**
 * 工作线程宿主（带降级）
 * ==================================================================
 * 正常情况：new Worker(worker.js)，扫描与哈希跑在独立线程，UI 绝不卡顿。
 * 异常情况（打包成 asar、沙箱限制、权限问题导致 Worker 创建失败）：
 *   自动退化成「进程内 shim」——接口与 Worker 一模一样，任务在主线程跑，
 *   靠 tasks.js 内部的 setImmediate 让出来保持可取消、可响应。
 * 这样无论怎么打包，程序都不会因为线程起不来而白屏。
 */
'use strict';
const path = require('path');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const { runJob, setCancelled } = require('./tasks');

const WORKER_FILE = path.join(__dirname, 'worker.js');

/** 构造一个与 Worker 接口兼容的进程内替身 */
function makeShim() {
  const ee = new EventEmitter();
  const port = { postMessage: (m) => ee.emit('message', m) };
  const shim = {
    _shim: true,
    postMessage(m) {
      if (!m) return;
      if (m.type === 'cancel') return setCancelled(true);
      if (m.type === 'reset') return setCancelled(false);
      if (m.type === 'job') {
        Promise.resolve()
          .then(() => runJob(m.payload || {}, port))
          .catch(err => port.postMessage({
            type: 'error', payload: { message: (err && err.message) || String(err) }
          }));
      }
    },
    on(ev, cb) { ee.on(ev, cb); return shim; },
    once(ev, cb) { ee.once(ev, cb); return shim; },
    removeListener(ev, cb) { ee.removeListener(ev, cb); return shim; },
    terminate() { setCancelled(true); },
    unref() { },
    ref() { }
  };
  return shim;
}

/**
 * 创建一个工作线程（失败则降级为 shim）
 * @param {function} [onFallback] 降级时回调，便于打日志
 */
function spawn(onFallback) {
  try {
    const w = new Worker(WORKER_FILE);
    // 某些环境下 Worker 能创建但脚本加载失败（例如打包进 asar），
    // 这里兜住首次 error：交给调用方按 shim 逻辑重试。
    w._loadFailed = false;
    w.once('error', () => { w._loadFailed = true; });
    if (onFallback) w._onFallback = onFallback;
    return w;
  } catch (e) {
    if (onFallback) onFallback(e);
    return makeShim();
  }
}

module.exports = { spawn, makeShim, WORKER_FILE };

/**
 * 工作线程入口（极薄的一层）
 * ------------------------------------------------------------------
 * 真正的实现都在 tasks.js，这里只负责把 parentPort 的消息转过去。
 * 这样 tasks.js 也能在「无法创建 Worker」的极端环境下被主进程直接调用（见 worker-host.js）。
 */
'use strict';
const { parentPort } = require('worker_threads');
const { runJob, setCancelled } = require('./tasks');

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'cancel') return setCancelled(true);
  if (msg.type === 'reset') return setCancelled(false);
  if (msg.type === 'job') {
    Promise.resolve()
      .then(() => runJob(msg.payload || {}, parentPort))
      .catch(err => {
        parentPort.postMessage({
          type: 'error',
          payload: { message: (err && err.message) || String(err) }
        });
      });
  }
});

/**
 * 工作线程池（Worker Pool）
 * ==================================================================
 * 用于 CPU 密集的 MD5 哈希：开 N 个常驻 Worker（N = min(8, CPU 核数)），
 * 任务排队、空闲复用，跑完自动回调；进度消息原样抛给上层。
 *
 * 若某个线程起不来（asar、权限受限），该槽位自动换成进程内替身（shim），
 * 池子整体照常工作，只是那一格的哈希会占用主线程。
 */
'use strict';
const os = require('os');
const { spawn, makeShim } = require('./worker-host');

class Pool {
  /**
   * @param {number} size 线程数
   * @param {function} onProgress 进度回调
   */
  constructor(size, onProgress) {
    this.onProgress = onProgress || function () { };
    this.size = size || Math.min(8, Math.max(2, (os.cpus() || []).length || 4));
    this.slots = [];
    this.queue = [];
    this.destroyed = false;
    for (let i = 0; i < this.size; i++) this.slots.push(this._makeSlot(false));
  }

  _makeSlot(forceShim) {
    const self = this;
    const w = forceShim ? makeShim() : spawn();
    const slot = { w: w, busy: false, cb: null, payload: null };

    w.on('message', (m) => {
      if (!m) return;
      if (m.type === 'progress') { self.onProgress(m.payload); return; }
      if (m.type === 'done' || m.type === 'error') {
        const cb = slot.cb;
        slot.cb = null; slot.busy = false; slot.payload = null;
        if (cb) cb(m);
        self._pump();
      }
    });

    w.on('error', () => {
      const cb = slot.cb;
      const payload = slot.payload;
      slot.cb = null; slot.busy = false; slot.payload = null;
      try { w.terminate(); } catch (e) { /* 忽略 */ }

      // 线程加载失败 → 这个槽位降级为进程内执行，并立即重跑当前任务
      const shim = self._makeSlot(true);
      const i = self.slots.indexOf(slot);
      if (i >= 0) self.slots[i] = shim;
      if (cb && payload) {
        shim.busy = true; shim.cb = cb; shim.payload = payload;
        shim.w.postMessage({ type: 'reset' });
        shim.w.postMessage({ type: 'job', payload });
      }
      self._pump();
    });

    w.on('exit', () => {
      if (self.destroyed) return;
      const i = self.slots.indexOf(slot);
      if (i >= 0) self.slots[i] = self._makeSlot(false);   // 补一个，保证池子始终可用
      self._pump();
    });

    return slot;
  }

  _pump() {
    while (this.queue.length) {
      const slot = this.slots.find(s => !s.busy && !s.cb);
      if (!slot) break;
      const job = this.queue.shift();
      slot.busy = true;
      slot.cb = job.resolve;
      slot.payload = job.payload;
      slot.w.postMessage({ type: 'reset' });
      slot.w.postMessage({ type: 'job', payload: job.payload });
    }
  }

  /** 提交一个任务 */
  run(payload) {
    return new Promise((resolve) => {
      this.queue.push({ payload, resolve });
      this._pump();
    });
  }

  /** 取消所有正在跑的任务 */
  cancelAll() {
    this.queue.length = 0;
    for (const s of this.slots) {
      try { s.w.postMessage({ type: 'cancel' }); } catch (e) { /* 忽略 */ }
    }
  }

  destroy() {
    this.destroyed = true;
    for (const s of this.slots) { try { s.w.terminate(); } catch (e) { /* 忽略 */ } }
    this.slots.length = 0;
  }
}

module.exports = { Pool };

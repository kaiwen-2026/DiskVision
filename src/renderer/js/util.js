/**
 * 通用工具：格式化 / DOM / 提示 / 二次确认弹窗
 * ------------------------------------------------------------------
 * 全局命名空间 window.DV，所有模块都挂在这里，避免污染全局。
 */
window.DV = window.DV || {};

(function (DV) {
  'use strict';

  /* ------------------------------ 格式化 ------------------------------ */
  const U = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  DV.fmt = {
    /** 字节 → 人类可读（1024 进制，保留 1~2 位小数） */
    size(b) {
      b = Number(b) || 0;
      if (b < 1024) return b + ' B';
      let i = 0, v = b;
      while (v >= 1024 && i < U.length - 1) { v /= 1024; i++; }
      return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + U[i];
    },
    /** 整数千分位 */
    num(n) {
      return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },
    /** 毫秒时间戳 → 2026-10-25 21:03 */
    time(ms) {
      if (!ms) return '-';
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    /** 毫秒时长 → 12.3s / 1分20秒 */
    dur(ms) {
      ms = Number(ms) || 0;
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
      return m + ' 分 ' + s + ' 秒';
    },
    pct(x) { return (Number(x) || 0).toFixed(1) + '%'; }
  };

  /* -------------------------------- DOM -------------------------------- */
  DV.$ = function (id) { return document.getElementById(id); };
  DV.q = function (sel) { return document.querySelector(sel); };
  DV.qa = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  DV.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ------------------------------- Toast ------------------------------- */
  DV.toast = function (msg, type, ms) {
    const box = DV.$('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, ms || 2600);
  };

  /* -------------------------- 二次确认 / 提示框 -------------------------- */
  let dlgResolve = null;

  function closeDlg(v) {
    DV.$('mask').classList.remove('on');
    const r = dlgResolve; dlgResolve = null;
    if (r) r(v);
  }

  document.addEventListener('DOMContentLoaded', () => {
    DV.$('dlgNo').addEventListener('click', () => closeDlg(false));
    DV.$('dlgYes').addEventListener('click', () => closeDlg(true));
    DV.$('mask').addEventListener('mousedown', (e) => {
      if (e.target === DV.$('mask')) closeDlg(false);
    });
  });

  /**
   * 二次确认弹窗（删除操作的最后一道闸）
   * @param {{title:string, html:string, yes?:string, danger?:boolean}} o
   * @returns {Promise<boolean>}
   */
  DV.confirm = function (o) {
    o = o || {};
    DV.$('dlgTitle').textContent = o.title || '请确认';
    DV.$('dlgBody').innerHTML = o.html || '';
    const yes = DV.$('dlgYes');
    yes.textContent = o.yes || '确定';
    yes.className = 'btn tiny ' + (o.danger === false ? 'primary' : 'danger');
    DV.$('mask').classList.add('on');
    return new Promise((res) => { dlgResolve = res; });
  };

  DV.alert = function (title, html) {
    return DV.confirm({ title, html, yes: '知道了', danger: false });
  };

  /**
   * 删除前的统一确认框：列出待删条目 + 安全提示
   * @param {string[]} paths
   * @param {number} totalBytes
   */
  DV.confirmDelete = function (paths, totalBytes) {
    const list = (paths || []).slice(0, 12).map(p => '<li>' + DV.esc(p) + '</li>').join('');
    const more = (paths || []).length > 12 ? '<li>… 等共 ' + paths.length + ' 项</li>' : '';
    return DV.confirm({
      title: '确认删除这 ' + (paths || []).length + ' 项？',
      html: '<div>合计约 <b>' + DV.fmt.size(totalBytes) + '</b>，将<b>移入回收站</b>，可随时还原。</div>' +
        '<ul>' + list + more + '</ul>' +
        '<div class="warnbox">删除操作不可由本程序撤销，但可在回收站右键「还原」恢复原位置。</div>',
      yes: '移入回收站'
    });
  };

})(window.DV);

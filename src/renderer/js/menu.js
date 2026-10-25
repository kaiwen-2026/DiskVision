/**
 * 右键菜单（树图 / 列表共用）
 * ------------------------------------------------------------------
 * 菜单项：打开文件位置 · 删除到回收站 · 复制路径 · 加入忽略列表 · 下钻
 * 受保护（红色）或聚合块的项目，删除项会置灰不可点。
 */
(function (DV) {
  'use strict';

  const Safety = window.Safety;

  function hide() { DV.$('ctxMenu').classList.remove('on'); }

  document.addEventListener('click', hide);
  document.addEventListener('blur', hide);
  window.addEventListener('resize', hide);

  /**
   * @param {number} x 屏幕坐标
   * @param {number} y
   * @param {object} node {name, path, size, kind, isDir}
   * @param {object} [extra] {onDrill:fn, onDeleted:fn}
   */
  function show(x, y, node, extra) {
    const m = DV.$('ctxMenu');
    if (!node || !node.path) return;
    const isDir = node.kind === 'dir';
    const sf = Safety.evaluate(node.path, isDir);
    const locked = sf.level === 'red';

    let html = '<div class="ctx-path">' + DV.esc(node.path) + '</div>';
    const item = (label, act, cls) =>
      '<div class="ctx-item ' + (cls || '') + '" data-act="' + act + '">' + label + '</div>';

    html += item('打开文件位置', 'reveal');
    html += item('删除（移入回收站）', 'del', 'danger' + (locked ? ' disabled' : ''));
    html += '<div class="ctx-sep"></div>';
    html += item('复制路径', 'copy');
    html += item(isDir ? '加入忽略列表（不扫描）' : '忽略该后缀（不清理）', 'ignore');

    m.innerHTML = html;
    m.classList.add('on');

    // 边界收敛，避免菜单跑出窗口
    const w = m.offsetWidth, h = m.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    m.style.left = Math.min(x, vw - w - 8) + 'px';
    m.style.top = Math.min(y, vh - h - 8) + 'px';

    m.onclick = async function (e) {
      const t = e.target.closest('.ctx-item');
      if (!t) return;
      const act = t.getAttribute('data-act');
      hide();

      if (act === 'reveal') {
        await DV.api.reveal(node.path);
      } else if (act === 'copy') {
        await DV.api.copy(node.path);
        DV.toast('路径已复制', 'ok');
      } else if (act === 'ignore') {
        const cfg = DV.S.cfg || {};
        if (isDir) {
          const dirs = (cfg.ignoreDirs || []).slice();
          if (dirs.indexOf(node.path) < 0) dirs.push(node.path);
          cfg.ignoreDirs = dirs;
        } else {
          const nm = node.name || '';
          const ext = nm.indexOf('.') > 0 ? nm.slice(nm.lastIndexOf('.') + 1).toLowerCase() : '';
          if (ext) {
            const exts = (cfg.ignoreExts || []).slice();
            if (exts.indexOf(ext) < 0) exts.push(ext);
            cfg.ignoreExts = exts;
          }
        }
        DV.S.cfg = await DV.api.saveConfig(cfg);
        DV.toast('已加入忽略列表，下次扫描生效', 'ok');
      } else if (act === 'del') {
        if (locked) { DV.toast('系统保护文件，拒绝删除', 'err'); return; }
        await DV.trashPaths([node.path], node.size || 0);
        if (extra && extra.onDeleted) extra.onDeleted();
      }
    };
  }

  DV.menu = { show, hide };

})(window.DV);

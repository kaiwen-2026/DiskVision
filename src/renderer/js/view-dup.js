/**
 * 视图四：重复文件清理
 * ------------------------------------------------------------------
 * 后端已按「体积 + MD5」精确分组；这里负责展示，并让用户决定每组保留哪一个
 * （默认保留修改时间最早的那一份，其余标记为冗余副本）。
 */
(function (DV) {
  'use strict';

  let groups = [];

  function render() {
    const box = DV.$('dupList');
    if (!groups.length) {
      box.innerHTML = '<div class="empty"><div class="empty-title">没有发现重复文件</div>' +
        '<div class="empty-sub">可尝试调小「最小体积」后重新扫描</div></div>';
      DV.$('dupSel').textContent = '将删除 0 个冗余副本 · 0 B';
      return;
    }
    box.innerHTML = groups.map((g, gi) => {
      const head = '<div class="grp-head">' +
        '<span class="grp-arrow">▶</span>' +
        '<span class="grp-title">' + DV.fmt.num(g.count) + ' 份相同文件 · 每个 ' + DV.fmt.size(g.size) + '</span>' +
        '<span class="badge green">可省 ' + DV.fmt.size(g.waste) + '</span>' +
        '<span class="grp-size">MD5 ' + String(g.hash).slice(0, 10) + '</span>' +
        '</div>';
      const items = g.files.map((f, fi) => {
        return '<div class="it">' +
          '<input type="radio" name="dup' + gi + '" data-g="' + gi + '" data-f="' + fi + '"' +
          (f.keep ? ' checked' : '') + (f.locked ? ' disabled' : '') + ' />' +
          '<span class="badge ' + (f.keep ? 'green' : (f.locked ? 'red' : 'yellow')) + '">' +
          (f.keep ? '保留' : (f.locked ? '保护' : '冗余')) + '</span>' +
          '<span class="p" title="' + DV.esc(f.path) + '">' + DV.esc(f.path) + '</span>' +
          '<span class="s">' + DV.fmt.time(f.mtime) + '</span>' +
          '<span class="ops"><span class="lnk" data-go="' + DV.esc(f.path) + '">定位</span></span>' +
          '</div>';
      }).join('');
      return '<div class="grp yellow open" data-g="' + gi + '">' + head + '<div class="grp-items">' + items + '</div></div>';
    }).join('');

    bind();
    updateFoot();
  }

  function bind() {
    const box = DV.$('dupList');
    box.querySelectorAll('.grp-head').forEach(h => {
      h.onclick = () => h.parentNode.classList.toggle('open');
    });
    box.querySelectorAll('input[type=radio]').forEach(r => {
      r.onchange = () => {
        const gi = Number(r.getAttribute('data-g'));
        const fi = Number(r.getAttribute('data-f'));
        groups[gi].files.forEach((f, i) => { f.keep = (i === fi); });
        render();
      };
    });
    box.querySelectorAll('[data-go]').forEach(el => {
      el.onclick = () => DV.api.reveal(el.getAttribute('data-go'));
    });
  }

  function updateFoot() {
    let n = 0, b = 0;
    for (const g of groups) for (const f of g.files) if (!f.keep && !f.locked) { n++; b += f.size; }
    DV.$('dupSel').textContent = '将删除 ' + n + ' 个冗余副本 · ' + DV.fmt.size(b);
  }

  document.addEventListener('DOMContentLoaded', () => {
    DV.$('btnDupScan').onclick = async () => {
      if (DV.S.scanning) { DV.toast('有任务正在进行', 'warn'); return; }
      DV.S.scanning = true;
      DV.lockButtons(true);
      DV.setStatus('扫描重复文件…', 'run');
      try {
        const r = await DV.api.dupStart({
          drives: DV.S.selected,
          minMB: Number(DV.$('dupMin').value) || 1
        });
        if (r && r.error) { DV.toast(r.error, 'err'); DV.setStatus('出错', 'err'); return; }
        groups = r.groups || [];
        DV.S.dup = r;
        DV.$('dupSum').innerHTML =
          '<div class="cs total"><div class="k">可释放空间</div><div class="v">' + DV.fmt.size(r.waste || 0) + '</div></div>' +
          '<div class="cs green"><div class="k">重复组数</div><div class="v">' + DV.fmt.num((r.groups || []).length) + '</div></div>' +
          '<div class="cs yellow"><div class="k">候选文件</div><div class="v">' + DV.fmt.num(r.candidates || 0) + '</div></div>' +
          '<div class="cs total"><div class="k">已比对文件</div><div class="v">' + DV.fmt.num(r.scanned || 0) + '</div></div>';
        render();
        DV.setStatus('重复文件扫描完成', 'ok');
      } catch (e) {
        DV.toast('扫描失败：' + (e && e.message || e), 'err');
        DV.setStatus('出错', 'err');
      } finally {
        DV.S.scanning = false;
        DV.lockButtons(false);
        DV.setProgress(0);
      }
    };

    DV.$('btnDupDel').onclick = async () => {
      const delGroups = groups.map(g => ({
        hash: g.hash, size: g.size,
        files: g.files.map(f => ({ path: f.path, size: f.size, mtime: f.mtime, keep: f.keep }))
      }));
      const paths = [];
      for (const g of delGroups) for (const f of g.files) if (!f.keep) paths.push(f.path);
      if (!paths.length) { DV.toast('没有可删除的冗余副本', 'warn'); return; }
      let b = 0;
      for (const g of delGroups) for (const f of g.files) if (!f.keep) b += f.size;
      const okd = await DV.confirmDelete(paths, b);
      if (!okd) return;
      DV.setStatus('正在删除…', 'run');
      const r = await DV.api.dupDelete({ groups: delGroups });
      if (r && r.error) { DV.toast(r.error, 'err'); DV.setStatus('出错', 'err'); return; }
      DV.toast('已移入回收站 ' + r.ok + ' 个副本，释放 ' + DV.fmt.size(r.freed), 'ok', 4000);
      groups = [];
      DV.S.dup = null;
      render();
      DV.$('dupSum').innerHTML = '';
      DV.setStatus('就绪', 'ok');
    };
  });

  DV.viewDup = {
    applyConfig(cfg) { DV.$('dupMin').value = cfg.dupMinMB; }
  };

})(window.DV);

/**
 * 视图三：大文件 / 大文件夹专项清理
 * ------------------------------------------------------------------
 * 支持按体积、时间排序，按后缀、最小体积过滤；可一键定位与批量删除（回收站）。
 * 红色（系统保护）行禁止勾选。
 */
(function (DV) {
  'use strict';

  const Safety = window.Safety;
  const checked = new Set();

  function rowHtml(r, i) {
    const sf = Safety.evaluate(r.path, r.isDir);
    const lock = sf.level === 'red';
    const on = checked.has(r.path);
    const tm = r.mtime ? DV.fmt.time(r.mtime) : '-';
    const sub = r.isDir ? ('含 ' + DV.fmt.num(r.fileCount) + ' 文件') : ('.' + (r.ext || ''));
    return '<tr data-i="' + i + '" data-p="' + DV.esc(r.path) + '">' +
      '<td><input type="checkbox" data-cb="' + i + '"' + (lock ? ' disabled' : '') + (on ? ' checked' : '') + ' /></td>' +
      '<td><div class="nm" title="' + DV.esc(r.name) + '">' + DV.esc(r.name) + '</div>' +
      '<div style="font-size:10.5px;color:#6d7889">' + sub + '</div></td>' +
      '<td class="sz">' + DV.fmt.size(r.size) + '</td>' +
      '<td class="tm">' + tm + '</td>' +
      '<td class="pt" title="' + DV.esc(r.path) + '">' + DV.esc(r.path) + '</td>' +
      '<td>' +
      '<span class="lnk" data-locate="' + i + '">定位</span> · ' +
      '<span class="lnk" data-tree="' + i + '">树图</span> · ' +
      (lock ? '<span class="badge red">保护</span>'
        : '<span class="lnk del" data-del="' + i + '">删除</span>') +
      '</td></tr>';
  }

  function currentRows() {
    return DV.S.bigTab === 'file' ? (DV.S.topFiles || []) : (DV.S.topDirs || []);
  }

  function render() {
    const tab = DV.S.bigTab;
    const sort = DV.$('bigSort').value;
    const ext = DV.$('bigExt').value;
    const minMB = Number(DV.$('bigMin').value) || 0;

    let rows = (tab === 'file' ? DV.S.topFiles : DV.S.topDirs) || [];
    if (tab === 'file') {
      if (ext && ext !== 'all') rows = rows.filter(r => r.ext === ext);
      if (minMB > 0) rows = rows.filter(r => r.size >= minMB * 1024 * 1024);
      if (sort === 'mtime') rows = rows.slice().sort((a, b) => a.mtime - b.mtime);
      else if (sort === 'mtime-desc') rows = rows.slice().sort((a, b) => b.mtime - a.mtime);
      else rows = rows.slice().sort((a, b) => b.size - a.size);
    } else {
      if (minMB > 0) rows = rows.filter(r => r.size >= minMB * 1024 * 1024);
      rows = rows.slice().sort((a, b) => b.size - a.size);
    }
    rows = rows.slice(0, 30);
    DV.S.bigRows = rows;

    const body = DV.$('bigBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:22px;text-align:center">没有符合条件的数据（先执行一次全盘扫描）</td></tr>';
    } else {
      body.innerHTML = rows.map((r, i) => rowHtml(r, i)).join('');
      bind();
    }
    updateFoot();
  }

  function bind() {
    const body = DV.$('bigBody');
    body.querySelectorAll('input[data-cb]').forEach(cb => {
      cb.onchange = () => {
        const i = Number(cb.getAttribute('data-cb'));
        const p = DV.S.bigRows[i].path;
        if (cb.checked) checked.add(p); else checked.delete(p);
        updateFoot();
      };
    });
    body.querySelectorAll('[data-locate]').forEach(el => {
      el.onclick = () => DV.api.reveal(DV.S.bigRows[Number(el.getAttribute('data-locate'))].path);
    });
    body.querySelectorAll('[data-tree]').forEach(el => {
      el.onclick = () => DV.viewTreemap.goto(DV.S.bigRows[Number(el.getAttribute('data-tree'))].path);
    });
    body.querySelectorAll('[data-del]').forEach(el => {
      el.onclick = async () => {
        const r = DV.S.bigRows[Number(el.getAttribute('data-del'))];
        await DV.trashPaths([r.path], r.size);
        checked.delete(r.path);
        await DV.refreshData();
      };
    });
    body.querySelectorAll('tr').forEach(tr => {
      tr.onclick = (e) => {
        if (e.target.closest('input') || e.target.closest('.lnk')) return;
        const p = tr.getAttribute('data-p');
        const r = DV.S.bigRows.find(x => x.path === p);
        if (r) DV.showDetail(r);
      };
      tr.oncontextmenu = (e) => {
        const p = tr.getAttribute('data-p');
        const r = DV.S.bigRows.find(x => x.path === p);
        if (r) {
          e.preventDefault();
          DV.menu.show(e.clientX, e.clientY, {
            name: r.name, path: r.path, size: r.size,
            kind: (r.isDir || r.fileCount != null) ? 'dir' : 'file'
          });
        }
      };
    });
  }

  function updateFoot() {
    let n = 0, b = 0;
    for (const r of DV.S.bigRows) if (checked.has(r.path)) { n++; b += r.size; }
    DV.$('bigSel').textContent = '已选 ' + n + ' 项 · ' + DV.fmt.size(b);
  }

  document.addEventListener('DOMContentLoaded', () => {
    DV.qa('#bigTabs .tab').forEach(t => {
      t.onclick = () => {
        DV.qa('#bigTabs .tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        DV.S.bigTab = t.getAttribute('data-tab');
        render();
      };
    });
    DV.$('bigSort').onchange = render;
    DV.$('bigExt').onchange = render;
    DV.$('bigMin').oninput = render;
    DV.$('btnBigRefresh').onclick = async () => {
      const one = await DV.api.topFiles({ n: 5000, sort: 'size' });
      DV.S.topFiles = one || [];
      render();
    };
    DV.$('bigAll').onchange = function () {
      const on = this.checked;
      DV.qa('#bigBody input[data-cb]').forEach(cb => {
        if (cb.disabled) return;
        cb.checked = on;
        const i = Number(cb.getAttribute('data-cb'));
        const p = DV.S.bigRows[i].path;
        if (on) checked.add(p); else checked.delete(p);
      });
      updateFoot();
    };
    DV.$('btnBigDel').onclick = async () => {
      const paths = DV.S.bigRows.filter(r => checked.has(r.path)).map(r => r.path);
      if (!paths.length) { DV.toast('请先勾选要删除的行', 'warn'); return; }
      let b = 0;
      DV.S.bigRows.forEach(r => { if (checked.has(r.path)) b += r.size; });
      await DV.trashPaths(paths, b);
      checked.clear();
      await DV.refreshData();
      DV.$('bigAll').checked = false;
    };
  });

  DV.viewBig = { render };

})(window.DV);

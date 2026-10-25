/**
 * 应用主控：启动、导航、扫描调度、状态栏、右侧面板
 * ------------------------------------------------------------------
 * 这是唯一绑定全局事件的模块，其余视图模块只暴露 render/applyConfig。
 */
(function (DV) {
  'use strict';

  const C = window.Category;
  const Safety = window.Safety;

  /* ============================== 视图切换 ============================== */
  DV.switchView = function (name) {
    DV.S.view = name;
    DV.qa('#nav .nav-item').forEach(n => n.classList.toggle('active', n.getAttribute('data-view') === name));
    DV.qa('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    // 从一个隐藏状态切出来的图表尺寸是 0，必须强制重排一次
    setTimeout(() => {
      DV.chart.resizeAll();
      if (name === 'dash' && DV.viewDash) DV.viewDash.render();
      if (name === 'treemap') DV.viewTreemap.paint();
    }, 30);
  };

  /* ============================== 状态栏 ============================== */
  DV.setStatus = function (text, kind) {
    DV.$('sbState').textContent = text;
    DV.$('sbDot').className = 'dot ' + (kind || '');
  };
  DV.setProgress = function (p) {
    DV.$('sbBar').style.width = Math.max(0, Math.min(100, p || 0)) + '%';
  };
  DV.setInfo = function (t) { DV.$('sbInfo').textContent = t; };
  DV.lockButtons = function (busy) {
    DV.$('btnScan').disabled = busy;
    DV.$('btnStop').disabled = !busy;
  };

  /* ============================== 右侧面板 ============================== */
  DV.renderRightPanel = function () {
    // ① TOP 大文件
    const rf = DV.$('rankFiles');
    const tops = (DV.S.topFiles || []).slice(0, 14);
    const max = tops.length ? tops[0].size : 1;
    rf.innerHTML = tops.length
      ? tops.map((f, i) => {
        const col = C.colorOf(f.category);
        return '<div class="rk" data-p="' + DV.esc(f.path) + '" title="' + DV.esc(f.path) + '">' +
          '<span class="i">' + (i + 1) + '</span>' +
          '<span style="flex:1;min-width:0">' +
          '<span class="n">' + DV.esc(f.name) + '</span>' +
          '<span class="bar" style="width:' + Math.max(6, f.size / max * 100) + '%;background:' + col + ';display:block"></span>' +
          '</span>' +
          '<span class="s">' + DV.fmt.size(f.size) + '</span></div>';
      }).join('')
      : '<div class="muted small">扫描后显示</div>';
    rf.querySelectorAll('.rk').forEach(el => {
      el.onclick = () => {
        const p = el.getAttribute('data-p');
        const f = DV.S.topFiles.find(x => x.path === p);
        if (f) DV.showDetail(f);
      };
      el.oncontextmenu = (e) => {
        const p = el.getAttribute('data-p');
        const f = DV.S.topFiles.find(x => x.path === p);
        if (f) { e.preventDefault(); DV.menu.show(e.clientX, e.clientY, { name: f.name, path: f.path, size: f.size, kind: 'file' }); }
      };
    });

    // ② 可清理空间
    const j = DV.S.junk;
    const cb = DV.$('cleanBars');
    if (!j) {
      cb.innerHTML = '<div class="muted small">扫描垃圾后显示</div>';
    } else {
      const rows = [
        { k: '安全可清理', v: j.safeSize, c: '#3fb950' },
        { k: '谨慎删除', v: j.warnSize, c: '#d9a441' },
        { k: '系统保护', v: j.lockedSize, c: '#f0616d' }
      ];
      const mx = Math.max(1, j.totalSize || 1);
      cb.innerHTML = rows.map(r =>
        '<div class="cb-row"><div class="cb-top"><span>' + r.k + '</span><span>' + DV.fmt.size(r.v) + '</span></div>' +
        '<div class="cb-bar"><i style="width:' + (r.v / mx * 100) + '%;background:' + r.c + '"></i></div></div>'
      ).join('') +
        '<div class="muted small" style="margin-top:6px">合计可释放 ' + DV.fmt.size(j.totalSize) + '</div>';
    }
  };

  /** 显示文件/目录详情（右侧底部卡片） */
  DV.showDetail = function (o) {
    if (!o) return;
    DV.S.detail = o;
    const isDir = o.kind === 'dir' || o.isDir || o.fileCount != null;
    const sf = Safety.evaluate(o.path, isDir);
    DV.$('detail').innerHTML =
      '<div class="dt-name">' + DV.esc(o.name || o.path) + '</div>' +
      row('体积', DV.fmt.size(o.size)) +
      row('类型', C.labelOf(isDir ? C.ofDir(o.name || '') : C.ofFile(o.name || '')) +
        (!isDir && (o.name || '').indexOf('.') > 0 ? '（.' + o.name.slice(o.name.lastIndexOf('.') + 1).toLowerCase() + '）' : '')) +
      row('修改时间', DV.fmt.time(o.mtime)) +
      row('路径', DV.esc(o.path)) +
      row('安全等级', '<span class="badge ' + sf.level + '">' +
        (sf.level === 'green' ? '安全' : sf.level === 'yellow' ? '谨慎' : '锁定') + '</span> ' +
        '<span class="muted">' + DV.esc(sf.reason || '') + '</span>') +
      '<div class="dt-ops">' +
      '<button class="btn tiny ghost" id="dtOpen">打开位置</button>' +
      '<button class="btn tiny ghost" id="dtCopy">复制路径</button>' +
      '<button class="btn tiny ' + (sf.level === 'red' ? 'ghost' : 'danger') + '" id="dtDel"' +
      (sf.level === 'red' ? ' disabled' : '') + '>移入回收站</button>' +
      '</div>';

    DV.$('dtOpen').onclick = () => DV.api.reveal(o.path);
    DV.$('dtCopy').onclick = async () => { await DV.api.copy(o.path); DV.toast('路径已复制', 'ok'); };
    DV.$('dtDel').onclick = () => DV.trashPaths([o.path], o.size || 0);

    function row(k, v) {
      return '<div class="dt-row"><div class="dt-k">' + k + '</div><div class="dt-v">' + v + '</div></div>';
    }
  };

  /* ============================== 盘符选择 ============================== */
  function renderDrives() {
    const box = DV.$('driveList');
    box.innerHTML = DV.S.drives.map(d => {
      const on = DV.S.selected.indexOf(d.letter + ':') >= 0 ? ' on' : '';
      const pct = d.total ? Math.round((d.total - d.free) / d.total * 100) : 0;
      return '<div class="dchip' + on + '" data-l="' + d.letter + '">' +
        '<span class="dk">' + d.letter + ':</span>' +
        '<span class="dv">' + DV.fmt.size(d.free) + ' 可用 · ' + pct + '%</span>' +
        '</div>';
    }).join('');
    box.querySelectorAll('.dchip').forEach(el => {
      el.onclick = () => {
        const L = el.getAttribute('data-l') + ':';
        const i = DV.S.selected.indexOf(L);
        if (i >= 0) {
          if (DV.S.selected.length === 1) return;   // 至少保留一个
          DV.S.selected.splice(i, 1);
        } else DV.S.selected.push(L);
        renderDrives();
        if (DV.S.summary) DV.viewDash.render();
      };
    });
  }

  /* ============================== 扫描流程 ============================== */
  let targetBytes = 0;

  function bindProgress() {
    DV.api.on('scan:progress', (p) => {
      const pct = targetBytes ? Math.min(99, p.bytes / targetBytes * 100) : 0;
      DV.setProgress(pct);
      DV.setStatus('扫描中…', 'run');
      DV.setInfo(DV.fmt.num(p.files) + ' 文件 · ' + DV.fmt.num(p.dirs) + ' 目录 · ' +
        DV.fmt.size(p.bytes) + ' · ' + DV.fmt.dur(p.elapsed));
    });
    DV.api.on('junk:progress', (p) => {
      DV.setStatus('扫描垃圾…', 'run');
      DV.setInfo(DV.fmt.num(p.files) + ' 文件 · 命中 ' + DV.fmt.num(p.found || 0) + ' 项');
    });
    DV.api.on('dup:progress', (p) => {
      if (p.stage === 'hash' && p.total) {
        DV.setProgress(Math.min(100, p.done / p.total * 100));
        DV.setStatus('MD5 比对…', 'run');
        DV.setInfo('已完成 ' + DV.fmt.num(p.done) + ' / ' + DV.fmt.num(p.total));
      } else {
        DV.setStatus('枚举文件…', 'run');
        DV.setInfo(DV.fmt.num(p.files || p.scanned || 0) + ' 文件');
      }
    });
  }

  async function doScan() {
    if (!DV.S.selected.length) { DV.toast('请至少选择一个盘符', 'warn'); return; }
    DV.S.scanning = true;
    DV.lockButtons(true);
    DV.setProgress(0);
    DV.setStatus('准备扫描…', 'run');

    targetBytes = 0;
    for (const d of DV.S.drives) {
      if (DV.S.selected.indexOf(d.letter + ':') >= 0) targetBytes += Math.max(0, d.total - d.free);
    }

    const t0 = Date.now();
    try {
      const r = await DV.api.scanStart({
        drives: DV.S.selected,
        keepMB: DV.S.cfg ? DV.S.cfg.keepFileMB : 1
      });
      if (r && r.error) { DV.toast('扫描出错：' + r.error, 'err'); DV.setStatus('出错', 'err'); return; }
      if (r && r.cancelled) { DV.setStatus('已取消', 'ok'); DV.toast('扫描已取消', 'warn'); return; }

      DV.S.scanned = true;
      DV.setProgress(100);
      await DV.refreshData();
      await DV.viewTreemap.reset();
      DV.switchView('treemap');
      const el = (r.elapsed || (Date.now() - t0));
      DV.setStatus('扫描完成 · ' + DV.fmt.dur(el), 'ok');
      DV.setInfo(DV.fmt.num(r.counters.files) + ' 文件 · ' + DV.fmt.num(r.counters.dirs) + ' 目录 · ' +
        DV.fmt.size(r.counters.bytes) + (r.counters.errors ? ' · 跳过 ' + DV.fmt.num(r.counters.errors) : ''));
      DV.toast('扫描完成，共 ' + DV.fmt.num(r.counters.files) + ' 个文件，用时 ' + DV.fmt.dur(el), 'ok', 3600);
    } catch (e) {
      DV.toast('扫描失败：' + ((e && e.message) || e), 'err');
      DV.setStatus('出错', 'err');
    } finally {
      DV.S.scanning = false;
      DV.lockButtons(false);
    }
  }

  /* ============================== 启动 ============================== */
  document.addEventListener('DOMContentLoaded', async () => {
    // 导航
    DV.qa('#nav .nav-item').forEach(n => {
      n.onclick = () => DV.switchView(n.getAttribute('data-view'));
    });

    // 按钮
    DV.$('btnScan').onclick = doScan;
    DV.$('btnStop').onclick = async () => {
      await DV.api.scanCancel();
      DV.toast('正在停止…', 'warn');
    };

    bindProgress();

    // 配置 + 盘符
    DV.S.cfg = await DV.api.config();
    DV.viewIgnore.fill(DV.S.cfg);
    DV.viewClean.applyConfig(DV.S.cfg);
    DV.viewDup.applyConfig(DV.S.cfg);

    DV.S.drives = await DV.api.drives();
    const saved = (DV.S.cfg && DV.S.cfg.lastDrives) || [];
    DV.S.selected = saved.filter(l => DV.S.drives.some(d => d.letter + ':' === l));
    if (!DV.S.selected.length) DV.S.selected = DV.S.drives.length ? [DV.S.drives[0].letter + ':'] : ['C:'];
    renderDrives();

    DV.viewDash.render();
    DV.renderRightPanel();
    DV.setStatus('就绪', 'ok');
    DV.setInfo('选择盘符后点击「开始扫描」');

    // 删除后：重扫增量数据
    DV.refreshAfterDelete = async function () {
      if (!DV.S.scanned) return;
      await DV.refreshData();
      DV.viewTreemap.load(DV.S.curId);
    };
  });

})(window.DV);

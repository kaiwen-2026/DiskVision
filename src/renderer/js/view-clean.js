/**
 * 视图二：一键智能清理（安全分级）
 * ------------------------------------------------------------------
 * 绿色 = 100% 安全（临时/缓存/日志/空目录）→ 支持一键清理
 * 黄色 = 谨慎删除（个人文件、过期安装包、闲置大文件）→ 需自行确认
 * 红色 = 系统关键 → 锁定，禁止勾选，后端也会拒绝
 */
(function (DV) {
  'use strict';

  const sel = new Set();          // 已勾选的路径
  let groups = [];                // 当前分组

  const LV = {
    green: { txt: '安全', cls: 'green' },
    yellow: { txt: '谨慎', cls: 'yellow' },
    red: { txt: '锁定', cls: 'red' }
  };

  function sumSel() {
    let n = 0, b = 0;
    for (const g of groups) for (const it of g.items) {
      if (sel.has(it.path)) { n++; b += it.size; }
    }
    return { n, b };
  }

  function updateFoot() {
    const s = sumSel();
    DV.$('junkSel').textContent = '已选 ' + s.n + ' 项 · ' + DV.fmt.size(s.b);
  }

  function renderSum(d) {
    DV.$('cleanSum').innerHTML =
      cs('total', '可释放合计', d.totalSize) +
      cs('green', '安全可清理', d.safeSize) +
      cs('yellow', '谨慎删除', d.warnSize) +
      cs('red', '系统保护（锁定）', d.lockedSize);
    function cs(k, t, v) {
      return '<div class="cs ' + k + '"><div class="k">' + t + '</div><div class="v">' + DV.fmt.size(v) + '</div></div>';
    }
  }

  function render() {
    const box = DV.$('junkList');
    if (!groups.length) {
      box.innerHTML = '<div class="empty"><div class="empty-title">没有可清理项</div>' +
        '<div class="empty-sub">当前扫描范围内未发现匹配的垃圾文件</div></div>';
      updateFoot();
      return;
    }
    box.innerHTML = groups.map((g, gi) => {
      const lv = LV[g.level] || LV.yellow;
      const disabled = g.level === 'red' ? ' disabled' : '';
      const checked = (g.level !== 'red' && g.items.every(it => sel.has(it.path))) ? ' checked' : '';
      const items = g.items.slice(0, 30).map(it => {
        const lvv = LV[it.level] || LV.yellow;
        return '<div class="it">' +
          '<span class="badge ' + lvv.cls + '">' + lvv.txt + '</span>' +
          '<span class="p" title="' + DV.esc(it.path) + '">' + DV.esc(it.path) + '</span>' +
          '<span class="s">' + DV.fmt.size(it.size) + '</span>' +
          '<span class="ops"><span class="lnk" data-go="' + DV.esc(it.path) + '">定位</span>' +
          (it.level === 'red' ? '' : '<span class="lnk del" data-del="' + DV.esc(it.path) + '" data-size="' + it.size + '">删除</span>') +
          '</span></div>';
      }).join('');
      const more = g.items.length > 30
        ? '<div class="it muted">… 另有 ' + (g.items.length - 30) + ' 项未列出（清理时会一并处理）</div>' : '';

      return '<div class="grp ' + lv.cls + '" data-g="' + gi + '">' +
        '<div class="grp-head">' +
        '<input type="checkbox" data-all="' + gi + '"' + disabled + checked + ' />' +
        '<span class="grp-arrow">▶</span>' +
        '<span class="grp-title">' + DV.esc(g.title) + '</span>' +
        '<span class="badge ' + lv.cls + '">' + lv.txt + '</span>' +
        '<span class="grp-size">' + DV.fmt.size(g.size) + '</span>' +
        '<span class="grp-cnt">' + DV.fmt.num(g.count) + ' 项</span>' +
        '</div>' +
        '<div class="grp-items">' +
        '<div class="grp-desc" style="margin-bottom:6px">' + DV.esc(g.desc || '') + '</div>' +
        items + more + '</div>' +
        '</div>';
    }).join('');

    // 展开 / 收起
    box.querySelectorAll('.grp-head').forEach(h => {
      h.onclick = (e) => {
        if (e.target.tagName === 'INPUT') return;
        h.parentNode.classList.toggle('open');
      };
    });
    // 整组勾选
    box.querySelectorAll('input[data-all]').forEach(cb => {
      cb.onclick = (e) => {
        e.stopPropagation();
        const gi = Number(cb.getAttribute('data-all'));
        const g = groups[gi];
        if (cb.checked) g.items.forEach(it => { if (it.level !== 'red') sel.add(it.path); });
        else g.items.forEach(it => sel.delete(it.path));
        render();
      };
    });
    // 定位 / 单条删除
    box.querySelectorAll('[data-go]').forEach(el => {
      el.onclick = () => DV.api.reveal(el.getAttribute('data-go'));
    });
    box.querySelectorAll('[data-del]').forEach(el => {
      el.onclick = async () => {
        const p = el.getAttribute('data-del');
        await DV.trashPaths([p], Number(el.getAttribute('data-size')) || 0);
        sel.delete(p);
        render();
      };
    });
    updateFoot();
  }

  /** 收集所有非红色项的 path */
  function allSafePaths() {
    const out = [];
    for (const g of groups) for (const it of g.items) if (it.level !== 'red') out.push(it.path);
    return out;
  }

  async function doClean(paths) {
    if (!paths.length) { DV.toast('请先选择要清理的项目', 'warn'); return; }
    let bytes = 0;
    const set = new Set(paths);
    for (const g of groups) for (const it of g.items) if (set.has(it.path)) bytes += it.size;
    const okd = await DV.confirmDelete(paths, bytes);
    if (!okd) return;
    DV.setStatus('正在清理…', 'run');
    const r = await DV.api.junkClean({ paths });
    if (r && r.error) { DV.toast(r.error, 'err'); DV.setStatus('就绪', 'ok'); return; }
    DV.toast('清理完成：移入回收站 ' + r.ok + ' 项，释放 ' + DV.fmt.size(r.freed), 'ok', 4000);
    DV.setStatus('就绪', 'ok');
    sel.clear();
    groups = [];
    DV.S.junk = null;
    renderSum({ totalSize: 0, safeSize: 0, warnSize: 0, lockedSize: 0 });
    render();
    DV.renderRightPanel();
  }

  document.addEventListener('DOMContentLoaded', () => {
    DV.$('btnJunkScan').onclick = async () => {
      if (DV.S.scanning) { DV.toast('有任务正在进行', 'warn'); return; }
      DV.setStatus('扫描垃圾文件…', 'run');
      DV.S.scanning = true;
      DV.lockButtons(true);
      try {
        const r = await DV.api.junkStart({
          drives: DV.S.selected,
          idleDays: Number(DV.$('clIdle').value) || 180,
          bigFileMB: Number(DV.$('clBig').value) || 100,
          includePersonal: DV.$('clPersonal').checked
        });
        if (r && r.error) { DV.toast(r.error, 'err'); DV.setStatus('出错', 'err'); return; }
        groups = r.groups || [];
        DV.S.junk = r;
        renderSum(r);
        render();
        DV.renderRightPanel();
        DV.setStatus('垃圾扫描完成 · ' + DV.fmt.dur(r.elapsed || 0), 'ok');
      } catch (e) {
        DV.toast('扫描失败：' + (e && e.message || e), 'err');
        DV.setStatus('出错', 'err');
      } finally {
        DV.S.scanning = false;
        DV.lockButtons(false);
        DV.setProgress(0);
      }
    };

    DV.$('btnCleanSafe').onclick = () => {
      const paths = [];
      for (const g of groups) if (g.level === 'green') for (const it of g.items) if (it.level === 'green') paths.push(it.path);
      doClean(paths);
    };
    DV.$('btnCleanSel').onclick = () => doClean(Array.from(sel));
    DV.$('btnRecycle').onclick = () => DV.api.recycleBin();
    DV.$('btnRecycle2').onclick = () => DV.api.recycleBin();
  });

  DV.viewClean = {
    render,
    /** 供设置页等处调用：写入当前配置的默认值 */
    applyConfig(cfg) {
      DV.$('clIdle').value = cfg.idleDays;
      DV.$('clBig').value = cfg.bigFileMB;
      DV.$('clPersonal').checked = !!cfg.includePersonal;
    }
  };

})(window.DV);

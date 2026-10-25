/**
 * 视图一：全盘可视化（矩形树图 + 类型饼图 + 文件夹饼图）
 * ------------------------------------------------------------------
 * 交互：
 *   单击目录 → 下钻；单击文件 → 右侧详情
 *   右键 → 打开位置 / 删除 / 复制路径 / 加入忽略
 *   顶部面包屑 → 逐级返回；图例 → 按分类筛除
 */
(function (DV) {
  'use strict';

  const C = window.Category;
  DV.hiddenCats = new Set();   // 被图例筛掉的分类

  function renderCrumb() {
    const box = DV.$('crumb');
    box.innerHTML = DV.S.trail.map((t, i) => {
      const cls = 'crumb-item' + (i === DV.S.trail.length - 1 ? ' cur' : '');
      return '<span class="' + cls + '" data-id="' + t.id + '" data-i="' + i + '" title="' + DV.esc(t.path || t.name) + '">' +
        DV.esc(t.name) + '</span>' + (i < DV.S.trail.length - 1 ? '<span class="crumb-sep">›</span>' : '');
    }).join('');
    box.querySelectorAll('.crumb-item').forEach(el => {
      el.onclick = () => {
        const i = Number(el.getAttribute('data-i'));
        DV.S.trail = DV.S.trail.slice(0, i + 1);
        load(DV.S.trail[i].id);
      };
    });
  }

  function renderLegend() {
    DV.$('legend').innerHTML = C.LIST.map(c => {
      const off = DV.hiddenCats.has(c.key) ? ' off' : '';
      return '<span class="lg' + off + '" data-k="' + c.key + '"><i style="background:' + c.color + '"></i>' + c.label + '</span>';
    }).join('');
    DV.qa('#legend .lg').forEach(el => {
      el.onclick = () => {
        const k = el.getAttribute('data-k');
        if (DV.hiddenCats.has(k)) DV.hiddenCats.delete(k); else DV.hiddenCats.add(k);
        renderLegend();
        paint();
      };
    });
  }

  /** 把当前层数据画到树图（应用图例筛选） */
  function paint() {
    const items = DV.S.curItems.filter(it => !DV.hiddenCats.has(it.category));
    DV.chart.treemap(items);
    DV.$('tmEmpty').style.display = items.length ? 'none' : 'flex';
  }

  /** 载入某一层的子项 */
  async function load(id) {
    const items = await DV.api.children(id);
    DV.S.curId = id;
    DV.S.curItems = items || [];
    renderCrumb();
    paint();

    // 同步两个饼图：类型占比 + 大文件夹占比
    if (id === 0) {
      DV.chart.pie('pieType', DV.S.typeStats || []);
      const dirPie = (DV.S.topDirs || []).slice(0, 8).map(d => ({
        name: d.name, size: d.size, color: C.colorOf(d.category)
      }));
      DV.chart.pie('pieDir', dirPie);
    } else {
      const dirs = items.filter(i => i.kind !== 'file').slice(0, 10).map(d => ({
        name: d.name, size: d.size, color: C.colorOf(d.category)
      }));
      DV.chart.pie('pieDir', dirs);
      const byCat = {};
      for (const it of items) byCat[it.category] = (byCat[it.category] || 0) + it.size;
      DV.chart.pie('pieType', C.LIST.filter(c => byCat[c.key]).map(c => ({
        name: c.label, size: byCat[c.key], color: c.color
      })));
    }
  }

  /** 下钻到某个目录 */
  function drill(node) {
    DV.S.trail.push({ id: node.id, name: node.name, path: node.path });
    load(node.id);
  }

  function up() {
    if (DV.S.trail.length <= 1) return;
    DV.S.trail.pop();
    load(DV.S.trail[DV.S.trail.length - 1].id);
  }

  /** 树图事件（点击 / 右键）只注册一次 */
  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    const c = DV.chart.get('treemap');
    if (!c) return;

    c.on('click', function (p) {
      const it = p.data && p.data._it;
      if (!it) return;
      DV.showDetail({ name: it.name, path: it.path, size: it.size, mtime: it.mtime, kind: it.kind });
      if (it.kind === 'dir' && it.id > 0) drill(it);
    });

    // 右键菜单：用 mouseover 记住当前悬停的色块，再用 DOM 的 contextmenu 触发。
    // （比依赖图表库的右键事件更稳，任何版本都能生效）
    let hover = null;
    c.on('mouseover', function (p) { if (p.data && p.data._it) hover = p.data._it; });
    c.on('mouseout', function () { hover = null; });

    DV.$('treemap').addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!hover) return;
      DV.menu.show(e.clientX, e.clientY, {
        name: hover.name, path: hover.path, size: hover.size,
        kind: hover.kind === 'dir' ? 'dir' : 'file'
      }, { onDeleted: () => load(DV.S.curId) });
    });
  }

  DV.viewTreemap = {
    /** 扫描完成后：重置到根并绘制 */
    async reset() {
      DV.S.trail = [{ id: 0, name: '全部磁盘', path: '' }];
      renderLegend();
      bindOnce();
      await load(0);
    },
    load, drill, up, paint,
    /** 从「大文件列表」等处跳转到某个路径 */
    async goto(path) {
      let r = await DV.api.goto(path);
      // 传进来的是文件路径时，退回到它所在的目录
      if (!r) {
        const parent = String(path).replace(/\\[^\\]+$/, '');
        if (parent && parent !== path) r = await DV.api.goto(parent);
      }
      if (!r) { DV.toast('未找到该路径（可能未扫描或被忽略）', 'warn'); return; }
      DV.S.trail = r.trail;
      await load(r.id);
      DV.switchView('treemap');
      DV.chart.resizeAll();
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    DV.$('btnUp').onclick = up;
  });

})(window.DV);

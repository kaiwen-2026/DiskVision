/**
 * ECharts 图表封装：矩形树图 / 饼图 / 仪表盘 / 分类柱状图
 * ------------------------------------------------------------------
 * 统一使用 dark 主题 + 透明背景，跟随窗口大小自适应（ResizeObserver）。
 */
(function (DV) {
  'use strict';

  const inst = {};   // name -> echarts 实例

  /** 基础配色（文字/轴线/背景），保证在深色 UI 下可读 */
  const T = {
    text: '#dbe2ec',
    text2: '#9aa5b6',
    muted: '#6d7889',
    line: '#232c3a',
    tipBg: '#1b2230'
  };

  function get(name) {
    if (inst[name]) return inst[name];
    const el = DV.$(name);
    if (!el) return null;
    const c = echarts.init(el, 'dark');
    inst[name] = c;
    return c;
  }

  function base() {
    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 260,
      textStyle: { fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' }
    };
  }

  function tip(extra) {
    return Object.assign({
      confine: true,
      backgroundColor: T.tipBg,
      borderColor: '#2c3644',
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: T.text, fontSize: 11 },
      extraCssText: 'box-shadow:0 8px 22px rgba(0,0,0,.45);border-radius:6px;'
    }, extra || {});
  }

  const C = window.Category;

  /* ============================== 矩形树图 ============================== */
  /**
   * @param {Array} items DV 统一子项 {id,kind,name,path,size,mtime,category}
   */
  function treemap(items) {
    const c = get('treemap');
    if (!c) return;
    const data = (items || []).map(it => {
      const col = C.colorOf(it.category);
      return {
        id: it.id,
        name: it.name,
        value: Math.max(1, it.size || 0),
        itemStyle: {
          color: col,
          borderColor: '#0d1117',
          borderWidth: 1,
          gapWidth: 1,
          // 目录用实色，文件稍亮一点，聚合块压暗，视觉层次分明
          opacity: it.kind === 'aggregate' ? 0.55 : (it.kind === 'file' ? 0.92 : 1)
        },
        _it: it
      };
    });

    c.setOption(Object.assign(base(), {
      tooltip: tip({
        formatter: function (p) {
          const it = p.data && p.data._it;
          if (!it) return '';
          const ext = it.kind === 'file'
            ? (it.name.indexOf('.') > 0 ? it.name.slice(it.name.lastIndexOf('.') + 1).toLowerCase() : '无后缀')
            : (it.kind === 'dir' ? '文件夹' : '合并项');
          return '<div style="max-width:330px">' +
            '<div style="font-weight:600;margin-bottom:5px;word-break:break-all">' + DV.esc(it.name) + '</div>' +
            '<div>大小：<b style="color:#fff">' + DV.fmt.size(it.size) + '</b></div>' +
            '<div>类型：' + C.labelOf(it.category) + ' · ' + DV.esc(ext) + '</div>' +
            (it.fileCount ? '<div>含 ' + DV.fmt.num(it.fileCount) + ' 个文件</div>' : '') +
            '<div>修改：' + DV.fmt.time(it.mtime) + '</div>' +
            (it.path ? '<div style="color:' + T.muted + ';word-break:break-all;margin-top:5px;font-size:10.5px">' + DV.esc(it.path) + '</div>' : '') +
            '</div>';
        }
      }),
      series: [{
        type: 'treemap',
        data: data,
        leafDepth: 1,            // 只渲染一层，下钻由我们自己控制
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        animation: false,
        width: '100%',
        height: '100%',
        top: 0, left: 0, right: 0, bottom: 0,
        label: {
          show: true,
          position: 'insideTopLeft',
          color: '#f2f6fb',
          fontSize: 11,
          lineHeight: 14,
          textBorderColor: 'rgba(0,0,0,.55)',
          textBorderWidth: 2,
          formatter: function (p) {
            const it = p.data._it;
            if (!it) return p.name;
            return p.name + '\n' + DV.fmt.size(it.size);
          }
        },
        itemStyle: { borderColor: '#0d1117', borderWidth: 1, gapWidth: 1 },
        emphasis: {
          itemStyle: { borderColor: '#ffffff', borderWidth: 1, shadowBlur: 0 },
          label: { color: '#ffffff' }
        },
        levels: [{
          itemStyle: { borderColor: '#0d1117', borderWidth: 1, gapWidth: 1 }
        }]
      }]
    }), true);
  }

  /* ================================ 饼图 ================================ */
  function pie(name, list, opts) {
    const c = get(name);
    if (!c) return;
    const data = (list || []).map(x => ({
      name: x.name,
      value: x.size,
      itemStyle: { color: x.color || C.colorOf(x.category) },
      _x: x
    }));
    c.setOption(Object.assign(base(), {
      tooltip: tip({
        trigger: 'item',
        formatter: function (p) {
          const x = p.data && p.data._x;
          const extra = x && x.count ? '<br/>数量：' + DV.fmt.num(x.count) : '';
          return '<b>' + DV.esc(p.name) + '</b><br/>' + DV.fmt.size(p.value) + ' （' + p.percent + '%）' + extra;
        }
      }),
      series: [{
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '52%'],
        minAngle: 2,
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#161c26', borderWidth: 2 },
        label: {
          color: T.text2, fontSize: 10, lineHeight: 13,
          formatter: '{b}\n{d}%'
        },
        labelLine: { length: 6, length2: 8, lineStyle: { color: T.line } },
        data: data
      }]
    }), true);
  }

  /* ============================== 仪表盘 ============================== */
  function gauge(percent, sub) {
    const c = get('gauge');
    if (!c) return;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const color = p >= 90 ? '#f0616d' : (p >= 75 ? '#d9a441' : '#3fb950');
    c.setOption(Object.assign(base(), {
      series: [{
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0, max: 100,
        radius: '88%',
        center: ['50%', '58%'],
        splitNumber: 5,
        progress: { show: true, width: 13, itemStyle: { color: color } },
        axisLine: { lineStyle: { width: 13, color: [[1, '#222b38']] } },
        axisTick: { show: false },
        splitLine: { length: 8, distance: -13, lineStyle: { color: '#3a4557', width: 1 } },
        axisLabel: { color: T.muted, fontSize: 9, distance: 15 },
        pointer: { show: false },
        anchor: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '-6%'],
          fontSize: 26, fontWeight: 600,
          color: '#dbe2ec',
          formatter: '{value}%'
        },
        title: { offsetCenter: [0, '26%'], color: T.muted, fontSize: 11 },
        data: [{ value: +p.toFixed(1), name: sub || '已使用' }]
      }]
    }), true);
  }

  /* ============================ 分类柱状图 ============================ */
  function barCat(list) {
    const c = get('barCat');
    if (!c) return;
    const data = (list || []).slice().sort((a, b) => a.size - b.size);   // 横向条形：小的在下
    c.setOption(Object.assign(base(), {
      grid: { left: 8, right: 46, top: 6, bottom: 6, containLabel: true },
      tooltip: tip({
        trigger: 'item',
        formatter: function (p) {
          const x = p.data && p.data._x;
          return '<b>' + DV.esc(x ? x.label : p.name) + '</b><br/>' + DV.fmt.size(p.value) +
            (x && x.count ? '<br/>数量：' + DV.fmt.num(x.count) : '');
        }
      }),
      xAxis: { type: 'value', show: false },
      yAxis: {
        type: 'category',
        data: data.map(x => x.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: T.text2, fontSize: 11 }
      },
      series: [{
        type: 'bar',
        barWidth: 14,
        data: data.map(x => ({
          value: x.size,
          itemStyle: { color: x.color, borderRadius: [0, 3, 3, 0] },
          _x: x
        })),
        label: {
          show: true, position: 'right', color: T.text2, fontSize: 10.5,
          formatter: function (p) { return DV.fmt.size(p.value); }
        }
      }]
    }), true);
  }

  /* ============================== 自适应 ============================== */
  function resizeAll() {
    for (const k in inst) {
      try { inst[k].resize(); } catch (e) { /* 忽略 */ }
    }
  }

  window.addEventListener('resize', resizeAll);
  if (window.ResizeObserver) {
    window.addEventListener('DOMContentLoaded', () => {
      const ro = new ResizeObserver(() => resizeAll());
      ['treemap', 'pieType', 'pieDir', 'gauge', 'barCat'].forEach(id => {
        const el = DV.$(id);
        if (el) ro.observe(el);
      });
    });
  }

  DV.chart = { get, treemap, pie, gauge, barCat, resizeAll };

})(window.DV);

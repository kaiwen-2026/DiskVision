/**
 * 视图五：磁盘仪表盘
 * ------------------------------------------------------------------
 * 使用率仪表盘 + 扫描概况卡片 + 八大类空间占用条形图
 */
(function (DV) {
  'use strict';

  function card(k, v) {
    return '<div class="st"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  function render() {
    const s = DV.S.summary;
    const drives = DV.S.selected;
    let total = 0, free = 0;
    for (const d of DV.S.drives) {
      if (drives.indexOf(d.letter + ':') >= 0) { total += d.total; free += d.free; }
    }
    const used = Math.max(0, total - free);
    const pct = total ? (used / total * 100) : 0;
    DV.chart.gauge(pct, (drives.join(' ') || '-') + ' 已使用');

    if (!s) {
      DV.$('statCards').innerHTML = card('状态', '<span style="font-size:13px">未扫描</span>');
      DV.chart.barCat([]);
      return;
    }
    DV.$('statCards').innerHTML =
      card('总容量', DV.fmt.size(s.totalBytes)) +
      card('已用', DV.fmt.size(s.usedBytes)) +
      card('剩余', DV.fmt.size(s.freeBytes)) +
      card('使用率', DV.fmt.pct(s.usedPercent)) +
      card('文件数', DV.fmt.num(s.fileCount)) +
      card('文件夹数', DV.fmt.num(s.dirCount)) +
      card('扫描耗时', DV.fmt.dur(s.elapsed)) +
      card('跳过/无权限', DV.fmt.num((s.errorCount || 0) + (s.skippedCount || 0))) +
      card('已统计体积', DV.fmt.size(s.scannedBytes));

    DV.chart.barCat(DV.S.catStats || []);
  }

  DV.viewDash = { render };

})(window.DV);

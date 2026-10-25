/**
 * 全局状态 + 后端 API 封装
 * ------------------------------------------------------------------
 * 所有与主进程的通信都收敛在这里，视图层只跟 DV.S（状态）和 DV.api 打交道。
 */
(function (DV) {
  'use strict';

  const api = window.api;

  /** ------------------------------ 全局状态 ------------------------------ */
  DV.S = {
    cfg: null,               // 用户配置
    drives: [],              // [{letter,mount,total,free,used,usedPercent}]
    selected: [],            // 选中盘符 ['C:']
    scanning: false,         // 是否有任务在跑
    scanned: false,          // 是否已完成过一次树扫描
    view: 'treemap',         // 当前视图
    trail: [{ id: 0, name: '全部磁盘', path: '' }],  // 树图面包屑
    curId: 0,                // 当前树图节点 id
    curItems: [],            // 当前树图层的子项
    detail: null,            // 右侧详情
    summary: null,           // 扫描汇总
    topFiles: [],
    topDirs: [],
    typeStats: [],
    catStats: [],
    junk: null,              // 垃圾扫描结果 {groups, safeSize, ...}
    dup: null,               // 重复文件结果 {groups, waste}
    bigTab: 'file',
    bigRows: [],             // 当前大文件表格行
    bigChecked: new Set()    // 大文件表格勾选
  };

  /** ------------------------------ API 封装 ------------------------------ */
  DV.api = {
    config: () => api.config(),
    saveConfig: (c) => api.saveConfig(c),
    drives: () => api.drives(),

    scanStart: (arg) => api.scanStart(arg),
    scanCancel: () => api.scanCancel(),

    children: (id) => api.treeChildren(id),
    goto: (p) => api.treeGoto(p),

    topFiles: (a) => api.topFiles(a),
    topDirs: (a) => api.topDirs(a),
    typeStats: (a) => api.typeStats(a),
    catStats: () => api.categoryStats(),
    extList: () => api.extList(),
    summary: (a) => api.summary(a),

    junkStart: (a) => api.junkStart(a),
    junkClean: (a) => api.junkClean(a),
    dupStart: (a) => api.dupStart(a),
    dupDelete: (a) => api.dupDelete(a),

    stat: (p) => api.stat(p),
    reveal: (p) => api.reveal(p),
    openDir: (p) => api.openDir(p),
    copy: (t) => api.copy(t),
    recycleBin: () => api.recycleBin(),
    trash: (paths) => api.trash(paths),

    on: (ch, cb) => api.on(ch, cb)
  };

  /**
   * 删除一批路径（统一入口：确认 → 回收站 → 提示 → 刷新）
   * @param {string[]} paths
   * @param {number} bytes 合计体积（用于提示文案）
   */
  DV.trashPaths = async function (paths, bytes) {
    if (!paths || !paths.length) return;
    const okd = await DV.confirmDelete(paths, bytes || 0);
    if (!okd) return;
    const r = await DV.api.trash(paths);
    if (r && r.error) { DV.toast(r.error, 'err'); return; }
    if (r && r.failed && r.failed.length) {
      DV.toast('成功 ' + r.ok + ' 项，失败 ' + r.failed.length + ' 项（多为被占用或受保护）', 'warn', 4200);
    } else {
      DV.toast('已移入回收站 ' + r.ok + ' 项，释放 ' + DV.fmt.size(r.freed), 'ok');
    }
    // 删除后刷新相关视图
    if (DV.refreshAfterDelete) DV.refreshAfterDelete();
  };

  /** 扫描后统一刷新所有派生数据 */
  DV.refreshData = async function () {
    const [tf, td, ts, cs, sm] = await Promise.all([
      DV.api.topFiles({ n: 30 }),
      DV.api.topDirs({ n: 30 }),
      DV.api.typeStats({ n: 12 }),
      DV.api.catStats(),
      DV.api.summary({ drives: DV.S.selected })
    ]);
    DV.S.topFiles = tf || [];
    DV.S.topDirs = td || [];
    DV.S.typeStats = ts || [];
    DV.S.catStats = cs || [];
    DV.S.summary = sm;
    if (DV.renderRightPanel) DV.renderRightPanel();
    if (DV.viewBig && DV.viewBig.render) DV.viewBig.render();
    if (DV.viewDash && DV.viewDash.render) DV.viewDash.render();
  };

})(window.DV);

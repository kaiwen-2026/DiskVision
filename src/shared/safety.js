/**
 * 安全防误删引擎（单一数据源，主进程 + 渲染进程共用）
 * ------------------------------------------------------------------
 * 分级结果：
 *   red    红色 —— 系统关键文件 / 关键目录，永久锁定，禁止删除（UI 上禁止勾选）
 *   yellow 黄色 —— 用户个人文件（文档/下载/桌面/图片…），谨慎删除
 *   green  绿色 —— 明确可安全清理（临时/缓存/日志/浏览器缓存/卸载残留…）
 *
 * 判定顺序（越靠前优先级越高）：
 *   1. 显式绿色例外（Windows\Temp、SoftwareDistribution\Download 等虽在 Windows 下但确实可清）
 *   2. 红色锁定根目录 + 红色关键后缀
 *   3. 绿色垃圾规则（temp / cache / log / 浏览器缓存 …）
 *   4. 黄色个人目录
 *   5. 兜底：默认黄色（宁可让用户多确认一次，也不误删）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Safety = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- Windows 环境变量（Worker 里同样能拿到） ---------------- */
  function env() {
    const e = (typeof process !== 'undefined' && process.env) || {};
    return {
      sysRoot: (e.SystemRoot || 'C:\\Windows').toLowerCase(),
      programFiles: (e.ProgramFiles || 'C:\\Program Files').toLowerCase(),
      programFilesX86: (e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase(),
      programData: (e.ProgramData || 'C:\\ProgramData').toLowerCase(),
      userProfile: (e.USERPROFILE || '').toLowerCase(),
      appData: (e.APPDATA || '').toLowerCase(),
      localAppData: (e.LOCALAPPDATA || '').toLowerCase(),
      temp: (e.TEMP || '').toLowerCase(),
      windir: (e.windir || 'C:\\Windows').toLowerCase()
    };
  }

  /** 统一成小写反斜杠路径，末尾不带分隔符（目录比对时另加） */
  function norm(p) {
    if (!p) return '';
    let s = String(p).replace(/\//g, '\\').toLowerCase();
    while (s.endsWith('\\')) s = s.slice(0, -1);
    return s;
  }

  /** 判断 child 是否位于 parent 目录内（或就是它自己） */
  function under(child, parent) {
    if (!parent) return false;
    const c = norm(child), p = norm(parent);
    if (!c || !p) return false;
    return c === p || c.startsWith(p + '\\');
  }

  /* ---------------------------- 红色：锁定目录 ---------------------------- */
  const LOCKED_DIR_SUFFIX = [
    '\\windows',
    '\\windows\\system32',
    '\\windows\\syswow64',
    '\\windows\\winsxs',
    '\\windows\\servicing',
    '\\windows\\assembly',
    '\\windows\\boot',
    '\\windows\\security',
    '\\windows\\systemapps',
    '\\windows\\apppatch',
    '\\windows\\resources',
    '\\windows\\fonts',
    '\\windows\\driver store',
    '\\program files',
    '\\program files (x86)',
    '\\programdata\\microsoft',
    '\\programdata\\package cache',
    '\\$recycle.bin',
    '\\system volume information',
    '\\recovery',
    '\\hiberfil.sys',
    '\\pagefile.sys',
    '\\swapfile.sys',
    '\\boot',
    '\\efi',
    '\\windowsapps',
    '\\perflogs',
    '\\users\\default',
    '\\users\\public\\libraries',
    '\\onedrivetemp'
  ];

  /** 红色：这些目录即使里面有 junk 也不能碰（由 GREEN_EXCEPT 单独开白） */
  function lockedRoots() {
    const e = env();
    const list = [e.sysRoot, e.windir, e.programFiles, e.programFilesX86, e.programData + '\\microsoft'];
    // 盘符根下的系统目录（例如 D:\Windows）
    for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const s of LOCKED_DIR_SUFFIX) list.push(d + ':' + s);
    }
    return list.filter(Boolean);
  }

  /** 显式绿色例外：虽然是系统目录，但内容确属可清理 */
  const GREEN_EXCEPT = [
    '\\windows\\temp',
    '\\windows\\softwaredistribution\\download',
    '\\windows\\logs',
    '\\windows\\prefetch',
    '\\windows\\installer\\$patchcache$',
    '\\windows\\panther',
    '\\windows\\minidump',
    '\\windows\\livekernelreports',
    '\\windows\\serviceprofiles\\localservice\\appdata\\local\\temp',
    '\\windows\\serviceprofiles\\networkservice\\appdata\\local\\temp'
  ];

  /* ---------------------------- 红色：关键后缀 ---------------------------- */
  const CRITICAL_EXT = new Set([
    'sys', 'dll', 'drv', 'mui', 'manifest', 'cat', 'inf', 'nls', 'hiv', 'ocx',
    'efi', 'wim', 'mof', 'msu', 'cpl', 'pnf', 'rll', 'tlb', 'wdf'
  ]);

  /** 黄色：用户个人目录（删了会心疼的） */
  function personalDirs() {
    const e = env();
    if (!e.userProfile) return [];
    return ['\\desktop', '\\documents', '\\downloads', '\\pictures', '\\videos',
      '\\music', '\\onedrive', '\\contacts', '\\favorites', '\\saved games', '\\searches']
      .map(s => e.userProfile + s);
  }

  /* ---------------------------- 绿色：垃圾特征 ---------------------------- */
  const GREEN_DIR_NAME = /(^|[^a-z])(temp|tmp|cache|caches|logs?|crashdumps?|code cache|gpucache|shader cache|crashpad|thumbnails|tempstate|最近使用的项目)([^a-z]|$)/;
  const GREEN_EXT = new Set(['tmp', 'temp', 'bak', 'old', 'log', 'etl', 'dmp', 'crdownload', 'part', 'partial', 'swp', 'ds_store', 'chk']);

  /**
   * 判定一个路径的安全等级
   * @param {string} fullPath 绝对路径
   * @param {boolean} isDir   是否目录
   * @param {string} [junkCategory] 若该项已被垃圾规则命中，传入类别名（temp/log/cache/...）
   * @returns {{level:'green'|'yellow'|'red', reason:string, locked:boolean}}
   */
  function evaluate(fullPath, isDir, junkCategory) {
    const p = norm(fullPath);
    const name = p.slice(p.lastIndexOf('\\') + 1);
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

    // 1) 显式绿色例外
    for (const g of GREEN_EXCEPT) {
      for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        if (under(p, d + ':' + g)) {
          return { level: 'green', reason: '系统可清理目录（例外放行）', locked: false };
        }
      }
    }

    // 2) 红色：锁定目录
    for (const r of lockedRoots()) {
      if (under(p, r)) {
        return { level: 'red', reason: '系统关键目录，永久锁定', locked: true };
      }
    }
    if (!isDir && CRITICAL_EXT.has(ext)) {
      return { level: 'red', reason: '系统关键后缀 .' + ext + '，禁止删除', locked: true };
    }

    // 3) 绿色：临时 / 缓存 / 日志 / 浏览器缓存
    if (isDir && GREEN_DIR_NAME.test(name)) {
      return { level: 'green', reason: '临时/缓存/日志目录', locked: false };
    }
    if (!isDir && GREEN_EXT.has(ext)) {
      return { level: 'green', reason: '临时/缓存/日志文件', locked: false };
    }
    if (junkCategory) {
      return { level: 'green', reason: '智能垃圾识别：' + junkCategory, locked: false };
    }

    // 4) 黄色：个人目录
    for (const d of personalDirs()) {
      if (under(p, d)) return { level: 'yellow', reason: '用户个人文件，谨慎删除', locked: false };
    }

    // 5) 兜底
    return { level: 'yellow', reason: isDir ? '普通目录，删除前请确认' : '普通文件，删除前请确认', locked: false };
  }

  /** 是否禁止删除（UI 用） */
  function isLocked(fullPath, isDir) {
    return evaluate(fullPath, isDir).level === 'red';
  }

  return { evaluate, isLocked, under, norm, CRITICAL_EXT, GREEN_EXCEPT, env };
});

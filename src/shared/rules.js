/**
 * 垃圾识别规则 + 默认忽略列表（单一数据源，主进程 / Worker / 渲染进程共用）
 * ------------------------------------------------------------------
 * 设计思路：
 *   - 垃圾扫描不做全盘遍历（太慢），而是围绕一组「目标根目录」做定向扫描。
 *     每个目标根带一个 tag，遍历出来的条目带上 tag，规则据此判定类别。
 *   - 每条规则给出 类别 / 名称 / 说明 / 是否强制安全（safe）。
 *     safe=true 的类别会走 Safety.evaluate(…, junkCategory) → 判为绿色；
 *     safe=false（旧安装包、闲置大文件这类“用户个人财产”）→ 由 Safety 自行判黄/绿。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- 后缀集合 ----------------------------- */
  const LOG_EXT = new Set(['log', 'etl', 'dmp', 'old', 'bak', 'tmp', 'temp', 'wer', 'mdmp', 'hdmp']);
  const INSTALLER_EXT = new Set(['msi', 'msp', 'msu', 'exe', 'appx', 'msix', 'appxbundle', 'apk']);
  const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cab', 'iso', 'wim', 'esd', 'vhd', 'vhdx', 'dmg', 'lzh', 'arj']);

  const DAY = 86400000;

  /* ----------------------------- 规则定义 ----------------------------- */
  const RULES = [
    {
      id: 'sysTemp', title: '系统临时文件', desc: 'Windows 临时目录、%TEMP%、更新下载缓存、预读取文件',
      safe: true, test: i => i.tag === 'sysTemp' && !i.isDir
    },
    {
      id: 'log', title: '日志文件 / 崩溃转储', desc: '*.log、*.etl、*.dmp、崩溃报告与错误报告',
      safe: true, test: i => !i.isDir && LOG_EXT.has(i.ext)
    },
    {
      id: 'thumb', title: '缩略图缓存', desc: 'Windows 资源管理器 thumbcache_*、iconcache_* 数据库',
      safe: true, test: i => i.tag === 'thumb' && !i.isDir
    },
    {
      id: 'browser', title: '浏览器缓存', desc: 'Chrome / Edge / Firefox 的 Cache、Code Cache、GPUCache、Service Worker 缓存',
      safe: true, test: i => i.tag === 'browser' && !i.isDir
    },
    {
      id: 'crash', title: '崩溃转储 / 错误报告', desc: 'CrashDumps、Windows 错误报告 WER',
      safe: true, test: i => (i.tag === 'crash' || i.tag === 'wer') && !i.isDir
    },
    {
      id: 'emptyDir', title: '空文件夹 / 卸载残留', desc: '软件卸载后遗留的空目录',
      safe: true, test: i => i.isDir && i.isEmpty
    },
    {
      // 只命中 Windows.old 本身（depth===0），避免把它内部成千上万个文件逐条列出来
      id: 'winOld', title: '旧系统残留 Windows.old', desc: '升级系统后留下的旧 Windows 目录，删除后无法回退',
      safe: false, test: i => i.tag === 'winOld' && i.depth === 0
    },
    {
      id: 'oldInstaller', title: '过期安装包', desc: '长时间未使用的安装程序（.msi / .exe / .msu …）',
      safe: false, test: i => !i.isDir && INSTALLER_EXT.has(i.ext) && i.ageDays >= i.cfg.idleDays
    },
    {
      id: 'oldArchive', title: '过期压缩包 / 镜像', desc: '长时间未使用的压缩包与光盘镜像（.zip / .rar / .iso …）',
      safe: false, test: i => !i.isDir && ARCHIVE_EXT.has(i.ext) && i.ageDays >= i.cfg.idleDays
    },
    {
      id: 'idleBig', title: '长期闲置大文件', desc: '体积超过阈值且长期未访问的文件，需自行确认',
      safe: false, test: i => !i.isDir && i.size >= i.cfg.bigFileBytes && i.ageDays >= i.cfg.idleDays
    }
  ];

  const RULE_MAP = {};
  for (const r of RULES) RULE_MAP[r.id] = r;

  /* ------------------------- 垃圾扫描目标根目录 ------------------------- */
  /**
   * 按环境变量拼出待扫描的目标根目录
   * @param {object} e  环境变量快照（小写路径）
   * @param {string[]} drives  选中的盘符，如 ['C:','D:']
   * @param {object} cfg  { includePersonal:boolean }
   */
  function buildTargets(e, drives, cfg) {
    const T = [];
    const add = (p, tag, depth) => { if (p) T.push({ path: p, tag, maxDepth: depth || 8 }); };

    // —— 系统临时 / 更新缓存 / 日志 / 预读取 ——
    add(e.temp, 'sysTemp', 6);
    add(e.localAppData ? e.localAppData + '\\Temp' : '', 'sysTemp', 6);
    add(e.sysRoot + '\\Temp', 'sysTemp', 5);
    add(e.sysRoot + '\\SoftwareDistribution\\Download', 'sysTemp', 4);
    add(e.sysRoot + '\\Prefetch', 'sysTemp', 2);
    add(e.sysRoot + '\\Logs', 'sysTemp', 4);
    add(e.sysRoot + '\\Installer\\$PatchCache$', 'sysTemp', 5);
    add(e.sysRoot + '\\Minidump', 'sysTemp', 2);
    add(e.sysRoot + '\\LiveKernelReports', 'sysTemp', 3);
    add(e.sysRoot + '\\Panther', 'sysTemp', 4);

    // —— 缩略图缓存 ——
    add(e.localAppData ? e.localAppData + '\\Microsoft\\Windows\\Explorer' : '', 'thumb', 1);

    // —— 崩溃转储 / 错误报告 ——
    add(e.localAppData ? e.localAppData + '\\CrashDumps' : '', 'crash', 2);
    add(e.localAppData ? e.localAppData + '\\Microsoft\\Windows\\WER' : '', 'wer', 4);

    // —— 浏览器缓存 ——
    const browsers = [
      [e.localAppData + '\\Google\\Chrome\\User Data', 5],
      [e.localAppData + '\\Microsoft\\Edge\\User Data', 5],
      [e.localAppData + '\\Chromium\\User Data', 5],
      [e.localAppData + '\\Mozilla\\Firefox\\Profiles', 5],
      [e.appData + '\\Mozilla\\Firefox\\Profiles', 5],
      [e.localAppData + '\\BraveSoftware\\Brave-Browser\\User Data', 5],
      [e.localAppData + '\\360Chrome\\Chrome\\User Data', 5]
    ];
    for (const [p, d] of browsers) add(p, 'browser', d);

    // —— ProgramData 下的日志与残留（深度受限，避免过慢）——
    add(e.programData, 'programdata', 5);

    // —— 旧系统残留 ——
    for (const d of drives) add(d + '\\Windows.old', 'winOld', 1);

    // —— 个人目录（可选，默认开启；用于识别过期安装包/闲置大文件）——
    if (cfg && cfg.includePersonal && e.userProfile) {
      for (const sub of ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music']) {
        add(e.userProfile + '\\' + sub, 'personal', 6);
      }
    }
    // 去重：%TEMP% 与 %LOCALAPPDATA%\Temp 在绝大多数机器上是同一个目录，
    // 不去重会导致同一批临时文件被扫描两次、体积翻倍统计。
    const seen = new Set();
    return T.filter(t => {
      if (!t.path) return false;
      const k = String(t.path).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * 浏览器缓存目录过滤：只收 Cache / Code Cache / GPUCache / Service Worker 等子目录
   * 用相对路径判断，避免把整个 User Data（含书签/密码）算进去
   */
  /** 浏览器缓存相关的子目录名特征（Chrome/Edge/Firefox 通用），直接对目录名做匹配 */
  const BROWSER_CACHE_DIR = /cache|crashpad|service worker|session storage|storage/i;
  const BROWSER_SUB_ANY = BROWSER_CACHE_DIR;

  function isBrowserCacheDir(relPathLower) {
    return BROWSER_SUB_ANY.test(relPathLower);
  }

  /* --------------------------- 默认忽略列表 --------------------------- */
  const DEFAULT_IGNORE_DIRS = [
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    'C:\\Recovery',
    'C:\\Windows\\WinSxS',
    'C:\\Windows\\System32\\DriverStore',
    'C:\\ProgramData\\Microsoft',
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ];

  const DEFAULT_IGNORE_EXT = [
    'sys', 'dll', 'mui', 'manifest', 'cat', 'inf', 'nls', 'drv', 'ocx'
  ];

  /* ----------------------- 遍历时跳过的死锁目录 ----------------------- */
  /** 这些目录会导致极慢遍历 / 循环 / 权限报错，扫描时直接跳过（但计入已忽略统计） */
  const ALWAYS_SKIP_DIR = new Set([
    '$recycle.bin', 'system volume information', 'recovery', 'winsxs',
    '$windows.~bt', '$windows.~ws', 'onedrivetemp', 'config.msi',
    'system32\\config', 'syswow64\\config', 'servicing'
  ]);

  return {
    RULES, RULE_MAP, LOG_EXT, INSTALLER_EXT, ARCHIVE_EXT, DAY,
    buildTargets, isBrowserCacheDir,
    DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_EXT, ALWAYS_SKIP_DIR
  };
});

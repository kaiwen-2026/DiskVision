/**
 * 文件分类与配色（单一数据源）
 * ------------------------------------------------------------------
 * 这个模块同时被 主进程（CommonJS require） 和 渲染进程（<script> 标签）使用，
 * 因此写成 UMD 形式：有 module.exports 时走 Node，否则挂到全局 window.Category。
 *
 * 分类直接对应需求里的 8 类：
 *   视频 / 压缩包 / 安装包 / 图片 / 文档 / 程序 / 缓存 / 其他
 * （额外加了 音频 一类，避免 mp3/flac 混进“其他”显得不专业）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Category = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 分类定义：key -> 名称 + 主题色（深色 UI 下高对比、低饱和） */
  const LIST = [
    { key: 'video',     label: '视频',     color: '#e0567a' },
    { key: 'audio',     label: '音频',     color: '#4ec2a5' },
    { key: 'image',     label: '图片',     color: '#4fb0c6' },
    { key: 'document',  label: '文档',     color: '#6aa9e0' },
    { key: 'archive',   label: '压缩包',   color: '#f0a04b' },
    { key: 'installer', label: '安装包',   color: '#d97757' },
    { key: 'program',   label: '程序',     color: '#9b8bf0' },
    { key: 'cache',     label: '缓存/临时', color: '#8a94a6' },
    { key: 'other',     label: '其他',     color: '#5b6472' }
  ];

  const MAP = {};
  for (const c of LIST) MAP[c.key] = c;

  /** 后缀 -> 分类 key */
  const EXT = {
    // 视频
    mp4: 'video', mkv: 'video', avi: 'video', rmvb: 'video', rm: 'video', mov: 'video',
    wmv: 'video', flv: 'video', webm: 'video', mpg: 'video', mpeg: 'video', ts: 'video',
    m2ts: 'video', vob: 'video', m4v: 'video', '3gp': 'video', asf: 'video', swf: 'video',
    // 音频
    mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', wma: 'audio',
    m4a: 'audio', ape: 'audio', opus: 'audio', mid: 'audio', midi: 'audio',
    // 图片
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', bmp: 'image', webp: 'image',
    tif: 'image', tiff: 'image', svg: 'image', ico: 'image', heic: 'image', psd: 'image',
    ai: 'image', eps: 'image', raw: 'image', jfif: 'image',
    // 文档
    doc: 'document', docx: 'document', xls: 'document', xlsx: 'document', ppt: 'document',
    pptx: 'document', pdf: 'document', txt: 'document', md: 'document', rtf: 'document',
    csv: 'document', log: 'document', ini: 'document', json: 'document', xml: 'document',
    yaml: 'document', yml: 'document', epub: 'document', mobi: 'document',
    // 压缩包
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
    bz2: 'archive', xz: 'archive', cab: 'archive', lzh: 'archive', arj: 'archive',
    z: 'archive', tgz: 'archive', lzma: 'archive',
    // 安装包 / 镜像
    exe: 'installer', msi: 'installer', dmg: 'installer', pkg: 'installer', deb: 'installer',
    rpm: 'installer', apk: 'installer', iso: 'installer', wim: 'installer', esd: 'installer',
    vhd: 'installer', vhdx: 'installer', appx: 'installer', msix: 'installer', msp: 'installer',
    // 程序 / 可执行文件与库
    dll: 'program', sys: 'program', ocx: 'program', drv: 'program', cpl: 'program',
    pyd: 'program', so: 'program', bin: 'program', cmd: 'program', bat: 'program',
    ps1: 'program', sh: 'program', jar: 'program', class: 'program', py: 'program',
    js: 'program', ts: 'program', java: 'program', cpp: 'program', c: 'program', h: 'program',
    cs: 'program', go: 'program', rs: 'program', php: 'program', rb: 'program', pl: 'program',
    // 缓存 / 临时
    tmp: 'cache', temp: 'cache', bak: 'cache', old: 'cache', swp: 'cache', crdownload: 'cache',
    part: 'cache', partial: 'cache', ds_store: 'cache', thumb: 'cache', db: 'cache',
    etl: 'cache', dmp: 'cache', '': 'other'
  };

  /** 取后缀（不含点，小写）；无后缀返回 ''；隐藏文件如 .gitignore 返回 'gitignore' 之外的处理 */
  function extOf(name) {
    const i = name.lastIndexOf('.');
    if (i <= 0) return '';                 // 无后缀 或 以点开头(隐藏文件)
    return name.slice(i + 1).toLowerCase();
  }

  /** 文件 -> 分类 key */
  function ofFile(name) {
    return EXT[extOf(name)] || 'other';
  }

  /** 目录 -> 分类 key（目录没有后缀，按名称猜；猜不出用 other） */
  function ofDir(name) {
    const n = name.toLowerCase();
    if (/(^|[^a-z])(cache|caches|temp|tmp|logs?|crash|code cache|gpucache)([^a-z]|$)/.test(n)) return 'cache';
    if (/(node_modules|\.git|__pycache__|bin|obj|build|dist)/.test(n)) return 'program';
    if (/(videos?|movies?)/.test(n)) return 'video';
    if (/(music|audio|sounds?)/.test(n)) return 'audio';
    if (/(pictures?|images?|photos?|screenshots?|wallpapers?)/.test(n)) return 'image';
    if (/(docs?|documents?|books?|notes?)/.test(n)) return 'document';
    return 'other';
  }

  function colorOf(key) { return (MAP[key] || MAP.other).color; }
  function labelOf(key) { return (MAP[key] || MAP.other).label; }

  return { LIST, MAP, EXT, extOf, ofFile, ofDir, colorOf, labelOf };
});

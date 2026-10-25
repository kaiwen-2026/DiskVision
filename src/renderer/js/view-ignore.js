/**
 * 视图六：忽略列表与扫描参数
 * ------------------------------------------------------------------
 * 修改后点击保存 → 写入 %APPDATA%\disk-vision\config.json，下次扫描生效。
 */
(function (DV) {
  'use strict';

  const DEF = {
    idleDays: 180, bigFileMB: 100, keepFileMB: 1, dupMinMB: 1,
    skipSystemHeavy: true, includePersonal: true
  };

  function fill(cfg) {
    DV.$('igDirs').value = (cfg.ignoreDirs || []).join('\n');
    DV.$('igExts').value = (cfg.ignoreExts || []).join(', ');
    DV.$('igKeep').value = cfg.keepFileMB;
    DV.$('igIdle').value = cfg.idleDays;
    DV.$('igBig').value = cfg.bigFileMB;
    DV.$('igDup').value = cfg.dupMinMB;
    DV.$('igHeavy').checked = cfg.skipSystemHeavy !== false;
    DV.$('igPersonal').checked = !!cfg.includePersonal;
  }

  function read() {
    const dirs = DV.$('igDirs').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const exts = DV.$('igExts').value.split(/[,\s，、]+/).map(s => s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
    return {
      ignoreDirs: dirs,
      ignoreExts: exts,
      keepFileMB: Number(DV.$('igKeep').value) || 0,
      idleDays: Number(DV.$('igIdle').value) || 180,
      bigFileMB: Number(DV.$('igBig').value) || 100,
      dupMinMB: Number(DV.$('igDup').value) || 1,
      skipSystemHeavy: DV.$('igHeavy').checked,
      includePersonal: DV.$('igPersonal').checked
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    DV.$('btnIgSave').onclick = async () => {
      const patch = read();
      DV.S.cfg = await DV.api.saveConfig(patch);
      DV.viewClean.applyConfig(DV.S.cfg);
      DV.viewDup.applyConfig(DV.S.cfg);
      DV.$('igMsg').textContent = '已保存，下次扫描生效';
      DV.toast('设置已保存', 'ok');
      setTimeout(() => { DV.$('igMsg').textContent = ''; }, 3000);
    };
    DV.$('btnIgReset').onclick = async () => {
      const okd = await DV.confirm({
        title: '恢复默认忽略列表？',
        html: '将清空你自定义的目录与后缀，恢复为程序内置默认值。',
        yes: '恢复默认', danger: false
      });
      if (!okd) return;
      const cfg = Object.assign({}, DV.S.cfg, {
        ignoreDirs: window.Rules ? window.Rules.DEFAULT_IGNORE_DIRS : [],
        ignoreExts: window.Rules ? window.Rules.DEFAULT_IGNORE_EXT : []
      });
      DV.S.cfg = await DV.api.saveConfig(cfg);
      fill(DV.S.cfg);
      DV.toast('已恢复默认', 'ok');
    };
  });

  DV.viewIgnore = { fill, DEF };

})(window.DV);

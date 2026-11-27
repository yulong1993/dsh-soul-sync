/* global window, document, fetch, navigator, setTimeout, clearTimeout */
window.__ModuleLoader__.load({
  id: 'dsh-soul-sync',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    var AUTO_MIRROR_SENTINEL = '__AUTO_MIRROR__';
    var CUSTOM_TARGET_SENTINEL = '__CUSTOM__';
    var STYLE_ID = 'dsh-soul-sync-settings-style';
    var CSS_TEXT = [
      '.dss-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.5;}',
      '.dss-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));}',
      '.dss-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#1f2329);}',
      '.dss-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin:2px 0 0;word-break:break-all;}',
      '.dss-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
      '.dss-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background .15s,border-color .15s;}',
      '.dss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}',
      '.dss-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.dss-btn-sm{padding:2px 8px;font-size:11px;border-radius:6px;}',
      '.dss-btn-primary{background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.dss-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8);}',
      '.dss-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.dss-banner{padding:9px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}',
      '.dss-notice-sticky{position:sticky;top:4px;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,.14);backdrop-filter:blur(6px);}',
      '.dss-banner-ok{border-color:var(--dsw-alias-state-success-primary,#16a34a);background:var(--dsw-alias-state-success-tertiary,rgba(22,163,74,.14));}',
      '.dss-banner-warn{border-color:var(--dsw-alias-state-warn-primary,#d97706);background:rgba(217,119,6,.12);color:var(--dsw-alias-label-primary,inherit);}',
      '.dss-banner-err{border-color:var(--dsw-alias-state-error-primary,#dc2626);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.12));}',
      '.dss-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));}',
      '.dss-card-title{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      '.dss-conn-grid{display:grid;grid-template-columns:1fr;gap:11px;margin-top:8px;}',
      '.dss-input-row{display:flex;gap:6px;align-items:center;min-width:0;}',
      '.dss-input-row .dss-input{flex:1;min-width:0;}',
      '.dss-radio-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;}',
      '.dss-radio-card{text-align:left;padding:10px 12px;border-radius:9px;border:1.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-bg-base,transparent);color:inherit;cursor:pointer;transition:border-color .15s,background .15s;}',
      '.dss-radio-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}',
      '.dss-radio-card.active{border-color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-bg-layer-2,rgba(37,99,235,.08));}',
      '.dss-radio-head{font-weight:600;font-size:13px;margin-bottom:4px;}',
      '.dss-radio-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.dss-map-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}',
      '.dss-map-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:12px;flex-wrap:wrap;}',
      '.dss-map-paths{overflow:hidden;text-overflow:ellipsis;word-break:break-all;flex:1;min-width:180px;}',
      '.dss-form-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;}',
      '@media (max-width:680px){.dss-form-grid{grid-template-columns:1fr;}}',
      '.dss-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dss-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.dss-input,.dss-select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;min-width:0;}',
      '.dss-input-err{border-color:var(--dsw-alias-state-error-primary,#dc2626) !important;background:rgba(220,38,38,.05);}',
      '.dss-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));margin-bottom:10px;overflow-x:auto;}',
      '.dss-tab{padding:7px 12px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;flex-shrink:0;}',
      '.dss-tab.active{color:var(--dsw-alias-brand-primary,#2563eb);border-bottom-color:var(--dsw-alias-brand-primary,#2563eb);}',
      '.dss-ws-group{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:8px;margin-bottom:8px;overflow:hidden;background:var(--dsw-alias-bg-base,transparent);}',
      '.dss-ws-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));}',
      '.dss-ws-left{display:flex;align-items:center;gap:7px;min-width:0;flex:1;flex-wrap:wrap;}',
      '.dss-ws-name{font-weight:600;font-size:12.5px;}',
      '.dss-ws-path{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;}',
      '.dss-sess-list{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12));}',
      '.dss-sess-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 6px 26px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.08));font-size:12px;flex-wrap:wrap;}',
      '.dss-sess-row:first-child{border-top:none;}',
      '.dss-sess-left{display:flex;align-items:center;gap:7px;min-width:0;flex:1;}',
      '.dss-sess-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dss-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);white-space:nowrap;}',
      '.dss-badge{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10.5px;font-weight:500;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));white-space:nowrap;flex-shrink:0;}',
      '.dss-badge-new{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a);}',
      '.dss-badge-wl{color:var(--dsw-alias-brand-primary,#2563eb);border-color:var(--dsw-alias-brand-primary,#2563eb);}',
      '.dss-badge-behind{color:var(--dsw-alias-state-warn-primary,#d97706);border-color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.dss-badge-diverged{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.dss-badge-vault{color:var(--dsw-alias-brand-primary,#2563eb);border-color:var(--dsw-alias-brand-primary,#2563eb);background:rgba(37,99,235,.06);}',
      '.dss-footer-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;margin-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));}',
      '.dss-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;}',
      '.dss-custom-path-row{padding:6px 10px 8px 26px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.1));display:flex;align-items:center;gap:8px;}',
      '.dss-custom-path-row .dss-meta{white-space:nowrap;flex-shrink:0;}',
      '.dss-custom-path-row .dss-input{flex:1;min-width:0;}',
      '.dss-conn-summary{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;margin-top:6px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:12px;}',
      '.dss-code-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;padding:2px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));word-break:break-all;}',
      '.dss-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);margin:2px 0 8px;}',
      '.dss-hint-tight{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);margin:2px 0 0;}',
      '.dss-pair-box{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:190px;overflow-y:auto;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));margin:6px 0 8px;}',
      '.dss-step-box{padding:8px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));background:var(--dsw-alias-bg-base,rgba(128,128,128,.04));font-size:12px;margin-top:8px;}',
      '.dss-reveal-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));}',
      '.dss-danger-zone{margin-top:12px;padding:10px 12px;border-radius:8px;border:1px dashed var(--dsw-alias-state-error-primary,rgba(220,38,38,.45));background:rgba(220,38,38,.04);font-size:12px;}',
      '.dss-maint-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));background:var(--dsw-alias-bg-base,rgba(128,128,128,.03));margin-top:8px;font-size:12px;}',
      '.dss-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.04));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));font-size:11.5px;}',
    ].join('\n');

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {};
      if (document.getElementById(STYLE_ID)) return function () {};
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS_TEXT;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }

    function stripOuterQuotesClient(raw) {
      var s = String(raw || '').trim();
      while (
        s.length >= 2
        && ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') || (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'"))
      ) {
        s = s.slice(1, -1).trim();
      }
      return s;
    }

    function detectInitialPlatform() {
      try {
        var nav = typeof navigator !== 'undefined' ? navigator : null;
        var ua = String((nav && (nav.platform || nav.userAgent)) || '').toLowerCase();
        if (ua.indexOf('mac') !== -1 || ua.indexOf('darwin') !== -1) return 'darwin';
        if (ua.indexOf('linux') !== -1) return 'linux';
      } catch (_e) {
        // ignore
      }
      return 'win32';
    }

    function apiFetch(path, options) {
      var opts = options || {};
      var headers = Object.assign(
        { 'x-dsh-soul-sync': '1' },
        opts.body ? { 'content-type': 'application/json' } : {},
        opts.headers || {},
      );
      return fetch('/__soul-sync/api' + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(function (resp) {
        return resp.text().then(function (rawText) {
          var parsed = null;
          if (rawText && rawText.trim()) {
            try {
              parsed = JSON.parse(rawText);
            } catch (_e) {
              parsed = null;
            }
          }
          if (!resp.ok || (parsed && parsed.ok === false)) {
            var errMsg = (parsed && parsed.error) || (rawText && rawText.trim().slice(0, 200)) || ('HTTP ' + resp.status);
            throw new Error(errMsg);
          }
          return parsed || { ok: true };
        });
      });
    }

    function formatTime(ts) {
      if (!ts || !Number.isFinite(ts)) return '-';
      try {
        var d = new Date(ts);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      } catch (_e) {
        return '-';
      }
    }

    function statusBadge(localStatus) {
      var map = {
        new: ['新对话', 'dss-badge dss-badge-new'],
        behind: ['有新回复', 'dss-badge dss-badge-behind'],
        'up-to-date': ['已最新', 'dss-badge'],
        diverged: ['双端分叉', 'dss-badge dss-badge-diverged'],
      };
      var pair = map[localStatus] || [localStatus || '未知', 'dss-badge'];
      return h('span', { className: pair[1] }, pair[0]);
    }

    function SoulSyncIcon(props) {
      var size = (props && props.size) || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
        h('path', { d: 'M3 3v5h5' }),
        h('path', { d: 'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16' }),
        h('path', { d: 'M16 16h5v5' }),
      );
    }

    function buildWhitelistSelection(localWorkspaces) {
      var nextWs = {};
      var nextSess = {};
      (localWorkspaces || []).forEach(function (ws) {
        var sessions = ws.sessions || [];
        if (ws.selected && ws.path) {
          nextWs[ws.path] = true;
          sessions.forEach(function (s) {
            if (!s.excluded) nextSess[s.sessionId] = true;
          });
        } else {
          sessions.forEach(function (s) {
            if (s.selected) nextSess[s.sessionId] = true;
          });
        }
      });
      return { ws: nextWs, sess: nextSess };
    }

    function extractLeafFolderName(rawPath) {
      if (!rawPath) return '';
      var cleaned = stripOuterQuotesClient(rawPath).replace(/[\\/]+$/, '');
      var idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
      return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
    }

    function copyTextToClipboard(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
          return fallbackCopyText(text);
        });
      }
      return Promise.resolve(fallbackCopyText(text));
    }

    function fallbackCopyText(text) {
      try {
        if (typeof document === 'undefined') return false;
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return Boolean(ok);
      } catch (_e) {
        return false;
      }
    }

    function buildPeerPairingPrompt(opts) {
      var peerOs = (opts && opts.peerPlatform) === 'win32' ? 'win32' : 'darwin';
      var fromLabel = (opts && opts.deviceLabel) || '第一台电脑';
      var vaultLeaf = extractLeafFolderName((opts && opts.vaultDir) || '') || 'dsh-vault';
      var encrypted = Boolean(opts && opts.encrypted);
      var mappingCount = Number((opts && opts.mappingCount) || 0);
      var installCmd = peerOs === 'win32'
        ? (
            'powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\\scripts\\install-win.ps1" -NonInteractive -VaultDir "<这台电脑上的网盘金库路径>" '
            + (encrypted ? '-Passphrase "<与第一台电脑一致的加密口令>"' : '-NoPassphrase')
          )
        : (
            'bash "<repo>/scripts/install-mac.sh" --non-interactive --vault "<这台电脑上的网盘金库路径>" '
            + (encrypted ? '--passphrase "<与第一台电脑一致的加密口令>"' : '--no-passphrase')
          );
      var restartHint = peerOs === 'win32'
        ? '右键右下角托盘图标彻底退出 DeepSeek Harness 再重新打开'
        : '按 Cmd+Q 彻底退出 DeepSeek Harness 再重新打开';

      return [
        '请你帮我在这台电脑上安装并配对 DeepSeek Harness 跨机同步插件（dsh-soul-sync），接入我在「' + fromLabel + '」上已经配好的防灾金库。',
        '我不需要手动敲命令行，请你全程替我执行并用通俗中文和我沟通，按以下 4 步完成：',
        '',
        '1. 定位或准备最新版 dsh-soul-sync 插件文件夹：',
        '   - 先检查当前工作区或常见固定目录（如 ~/Documents/dsh-soul-sync 或 ~/Documents/deepseek-harness/dsh-soul-sync）是否已有 dsh-soul-sync（含 scripts/ 与 bin/dsh-soul.js）；',
        '   - 如果找到了且里面包含 .git 目录，请自动先执行一次 git pull 更新到最新版；如果还没放好，请先礼貌问我插件文件夹放在哪里（提醒我可以放到「文档」等固定目录并直接把文件夹拖进对话框，切勿放在易被清理的临时下载目录）。',
        '',
        '2. 用大白话一次性向我确认 2 件事：',
        '   - 这台电脑上网盘同步过来的同一个「防灾金库」文件夹路径（我在「' + fromLabel + '」上用的金库文件夹名叫「' + vaultLeaf + '」，提醒我先在网盘里右键勾选「始终保留在此设备上 / Always keep on this device」，再把路径发给你）；',
        encrypted
          ? ('   - 端到端加密口令（「' + fromLabel + '」已开启加密，请让我输入与「' + fromLabel + '」完全相同的口令；如果不想在聊天里发口令，也可先跳过，装好重启后我自己去左下角「设置 → Soul Sync 跨机迁移」密码框里填写）。')
          : ('   - 「' + fromLabel + '」当前为明文模式，向我确认这台电脑也使用明文接入即可。'),
        '',
        '3. 自动运行一键安装并核对解密体检：',
        '   ' + installCmd,
        '   检查末尾 dsh-soul doctor 是否显示「体检通过」（含 vault-decrypt 成功读取金库记录；若提示解密失败说明口令不一致，请帮我核对并重设口令）。',
        '',
        '4. 完成后告诉我只需重启一次软件（' + restartHint + '）：',
        mappingCount > 0
          ? ('   重启后会自动从金库同步我在「' + fromLabel + '」已绑好的 ' + mappingCount + ' 组跨系统文件夹对应关系、全局规则与推送的对话，无需在这台电脑重复配置！')
          : ('   重启后会自动从金库拉取全局规则与推送的对话，以后也可随时在左下角「设置 → Soul Sync 跨机迁移」图形面板管理！'),
      ].join('\n');
    }

    function SoulSyncMigrationPanel() {
      var _state = useState(null);
      var data = _state[0];
      var setData = _state[1];

      var _loading = useState(true);
      var loading = _loading[0];
      var setLoading = _loading[1];

      var _busy = useState(false);
      var busy = _busy[0];
      var setBusy = _busy[1];

      var _notice = useState(null);
      var notice = _notice[0];
      var setNotice = _notice[1];

      var _guideOpen = useState(false);
      var guideOpen = _guideOpen[0];
      var setGuideOpen = _guideOpen[1];

      var _tab = useState('push');
      var activeTab = _tab[0];
      var setActiveTab = _tab[1];

      var _expanded = useState({});
      var expanded = _expanded[0];
      var setExpanded = _expanded[1];

      // Section 0: Vault & encryption connection form state
      var _connOpen = useState(false);
      var connOpen = _connOpen[0];
      var setConnOpen = _connOpen[1];

      var _connVaultDir = useState('');
      var connVaultDir = _connVaultDir[0];
      var setConnVaultDir = _connVaultDir[1];

      var _connPassphrase = useState('');
      var connPassphrase = _connPassphrase[0];
      var setConnPassphrase = _connPassphrase[1];

      var _showPass = useState(false);
      var showPass = _showPass[0];
      var setShowPass = _showPass[1];

      // Figure 1: Read-only revealed passphrase state (30s auto-hide, never written into edit input!)
      var _revealedPass = useState(null);
      var revealedPass = _revealedPass[0];
      var setRevealedPass = _revealedPass[1];

      var _revealUnavailable = useState(false);
      var revealUnavailable = _revealUnavailable[0];
      var setRevealUnavailable = _revealUnavailable[1];

      var _revealLoading = useState(false);
      var revealLoading = _revealLoading[0];
      var setRevealLoading = _revealLoading[1];

      var _connLabel = useState('');
      var connLabel = _connLabel[0];
      var setConnLabel = _connLabel[1];

      var _connStepSync = useState(true);
      var connStepSync = _connStepSync[0];
      var setConnStepSync = _connStepSync[1];

      var _pendingKeyRotation = useState(null);
      var pendingKeyRotation = _pendingKeyRotation[0];
      var setPendingKeyRotation = _pendingKeyRotation[1];

      // Figure 2: Inline 2-step confirmation for clearing key (plaintext downgrade)
      var _confirmClearOpen = useState(false);
      var confirmClearOpen = _confirmClearOpen[0];
      var setConfirmClearOpen = _confirmClearOpen[1];

      // Peer-device pairing wizard drawer state
      var _pairOpen = useState(false);
      var pairOpen = _pairOpen[0];
      var setPairOpen = _pairOpen[1];

      var _peerOs = useState('');
      var peerOs = _peerOs[0];
      var setPeerOs = _peerOs[1];

      var _copiedPair = useState(false);
      var copiedPair = _copiedPair[0];
      var setCopiedPair = _copiedPair[1];

      // Inline confirmations for mapping delete, session withdraw, scope switch, maintenance
      var _confirmDeleteMapId = useState(null);
      var confirmDeleteMapId = _confirmDeleteMapId[0];
      var setConfirmDeleteMapId = _confirmDeleteMapId[1];

      var _confirmWithdrawSid = useState(null);
      var confirmWithdrawSid = _confirmWithdrawSid[0];
      var setConfirmWithdrawSid = _confirmWithdrawSid[1];

      var _confirmSwitchScopeOpen = useState(false);
      var confirmSwitchScopeOpen = _confirmSwitchScopeOpen[0];
      var setConfirmSwitchScopeOpen = _confirmSwitchScopeOpen[1];

      // Bottom Maintenance / Reset / Uninstall card
      var _maintOpen = useState(false);
      var maintOpen = _maintOpen[0];
      var setMaintOpen = _maintOpen[1];

      var _confirmMaintAction = useState(null); // 'disconnect' | 'reset' | 'uninstall' | null
      var confirmMaintAction = _confirmMaintAction[0];
      var setConfirmMaintAction = _confirmMaintAction[1];

      var _uninstalledDone = useState(false);
      var uninstalledDone = _uninstalledDone[0];
      var setUninstalledDone = _uninstalledDone[1];

      var initializedRef = useRef(false);
      var mappingSectionRef = useRef(null);
      var revealTimerRef = useRef(null);

      // New mapping form state
      var _winPath = useState('');
      var winPath = _winPath[0];
      var setWinPath = _winPath[1];

      var _macPath = useState('');
      var macPath = _macPath[0];
      var setMacPath = _macPath[1];

      // Push selection state (tri-state + pre-filled from whitelist)
      var _pushWs = useState({});
      var pushWs = _pushWs[0];
      var setPushWs = _pushWs[1];

      var _pushSess = useState({});
      var pushSess = _pushSess[0];
      var setPushSess = _pushSess[1];

      var _withdrawUnselected = useState(false);
      var withdrawUnselected = _withdrawUnselected[0];
      var setWithdrawUnselected = _withdrawUnselected[1];

      // Pull selection & per-workspace target override state
      var _pullWs = useState({});
      var pullWs = _pullWs[0];
      var setPullWs = _pullWs[1];

      var _pullSess = useState({});
      var pullSess = _pullSess[0];
      var setPullSess = _pullSess[1];

      var _pullTargets = useState({});
      var pullTargets = _pullTargets[0];
      var setPullTargets = _pullTargets[1];

      var _pullCustomPaths = useState({});
      var pullCustomPaths = _pullCustomPaths[0];
      var setPullCustomPaths = _pullCustomPaths[1];

      var _pullMissingCustomKeys = useState({});
      var pullMissingCustomKeys = _pullMissingCustomKeys[0];
      var setPullMissingCustomKeys = _pullMissingCustomKeys[1];

      var _pullOnlyUpdates = useState(false);
      var pullOnlyUpdates = _pullOnlyUpdates[0];
      var setPullOnlyUpdates = _pullOnlyUpdates[1];

      var _savePullMap = useState(false);
      var savePullMap = _savePullMap[0];
      var setSavePullMap = _savePullMap[1];

      var clearRevealedPassphrase = useCallback(function () {
        if (revealTimerRef.current) {
          clearTimeout(revealTimerRef.current);
          revealTimerRef.current = null;
        }
        setRevealedPass(null);
        setRevealUnavailable(false);
      }, []);

      useEffect(function () {
        return function () {
          if (revealTimerRef.current) {
            clearTimeout(revealTimerRef.current);
            revealTimerRef.current = null;
          }
        };
      }, []);

      var resetConnDraftState = useCallback(function () {
        setConnPassphrase('');
        setShowPass(false);
        setPendingKeyRotation(null);
        setConfirmClearOpen(false);
        clearRevealedPassphrase();
      }, [clearRevealedPassphrase]);

      var handleRevealPassphrase = function () {
        if (revealedPass !== null) {
          clearRevealedPassphrase();
          return;
        }
        setRevealLoading(true);
        setRevealUnavailable(false);
        apiFetch('/passphrase/reveal', { method: 'POST', body: {} })
          .then(function (res) {
            if (res && res.available && res.passphrase) {
              setRevealedPass(res.passphrase);
              if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
              revealTimerRef.current = setTimeout(function () {
                setRevealedPass(null);
                revealTimerRef.current = null;
              }, 30000);
            } else {
              setRevealedPass(null);
              setRevealUnavailable(true);
            }
          })
          .catch(function (err) {
            setNotice({ level: 'err', text: '查看当前口令失败：' + (err && err.message ? err.message : String(err)) });
          })
          .finally(function () {
            setRevealLoading(false);
          });
      };

      var syncPushSelectionFromCatalog = useCallback(function (localWorkspaces) {
        var prefill = buildWhitelistSelection(localWorkspaces);
        setPushWs(prefill.ws);
        setPushSess(prefill.sess);
      }, []);

      var loadState = useCallback(function (silent, resyncSelection) {
        if (!silent) setLoading(true);
        return apiFetch('/state')
          .then(function (res) {
            setData(res);
            setLoading(false);
            var cfgRes = (res && res.config) || {};
            var needsConnAttention = !res.vaultConfigured
              || (cfgRes.encryptionEnabled && !res.hasSecretKey)
              || (res.decryptionFailedCount || 0) > 0
              || (res.startupErrors && res.startupErrors.length > 0)
              || Boolean(res.vaultError);

            if (!initializedRef.current) {
              initializedRef.current = true;
              setConnVaultDir(cfgRes.vaultDir || '');
              setConnLabel(cfgRes.deviceLabel || '');
              setConnStepSync(cfgRes.stepSyncEnabled !== false);
              setConnOpen(needsConnAttention);
              setGuideOpen(!res.vaultConfigured);
              syncPushSelectionFromCatalog((res.localCatalog && res.localCatalog.workspaces) || []);
            } else {
              if (needsConnAttention) setConnOpen(true);
              if (resyncSelection) {
                syncPushSelectionFromCatalog((res.localCatalog && res.localCatalog.workspaces) || []);
              }
            }
          })
          .catch(function (err) {
            setLoading(false);
            setNotice({ level: 'err', text: '加载 Soul Sync 状态失败：' + (err && err.message ? err.message : String(err)) });
          });
      }, [syncPushSelectionFromCatalog]);

      useEffect(function () {
        loadState(false, false);
      }, [loadState]);

      var runAction = function (fn, okMsgFn, options) {
        var opts = options || {};
        setBusy(true);
        setNotice(null);
        return Promise.resolve()
          .then(fn)
          .then(function (res) {
            var out = typeof okMsgFn === 'function' ? okMsgFn(res) : (okMsgFn || '操作完成');
            if (typeof out === 'string') {
              setNotice({ level: 'ok', text: out });
            } else if (out && out.text) {
              setNotice({ level: out.level || 'ok', text: out.text });
            }
            if (opts.skipReload) return res;
            return loadState(true, Boolean(opts.resyncSelection));
          })
          .catch(function (err) {
            setNotice({ level: 'err', text: '操作失败：' + (err && err.message ? err.message : String(err)) });
          })
          .finally(function () {
            setBusy(false);
          });
      };

      var cfg = (data && data.config) || {};
      var platform = (data && data.platform) || detectInitialPlatform();
      var localWorkspaces = (data && data.localCatalog && data.localCatalog.workspaces) || [];
      var vaultWorkspaces = (data && data.vaultCatalog && data.vaultCatalog.workspaces) || [];
      var mappings = cfg.workspaceMappings || [];
      var alerts = (data && data.alerts) || [];
      var startupErrors = (data && data.startupErrors) || [];
      var decryptionFailedCount = (data && data.decryptionFailedCount) || 0;
      var decryptionFailedDevices = (data && data.decryptionFailedDevices) || {};
      var decryptionFailedDeviceLabels = (data && data.decryptionFailedDeviceLabels) || {};
      var hydrationPendingCount = (data && data.hydrationPendingCount) || 0;
      var vaultError = (data && data.vaultError) || null;
      var hasSecretKey = Boolean(data && data.hasSecretKey);
      var vaultConfigured = Boolean(data && data.vaultConfigured);
      var isEncrypted = Boolean(data && data.encrypted);
      var isUninstalled = Boolean(uninstalledDone || (data && data.uninstalled));
      var writeDisabled = Boolean(busy || isUninstalled);
      var pairBlockedReason = !vaultConfigured
        ? '请先在上方填写并保存本机的「网盘防灾金库目录」，再配对另一台电脑。'
        : (cfg.encryptionEnabled && !hasSecretKey)
          ? '本机缺少加密密钥，请先在上方补填加密口令并保存后再配对。'
          : decryptionFailedCount > 0
            ? '当前存在解密失败记录，请先在上方确认本机加密口令无误后再配对另一台电脑。'
            : null;

      var toggleExpanded = function (key) {
        setExpanded(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = prev[key] === false ? true : false;
          return next;
        });
      };

      var togglePushWorkspace = function (ws) {
        var sessions = ws.sessions || [];
        var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
        var targetSessions = nonExcluded.length > 0 ? nonExcluded : sessions;
        var selectedCount = targetSessions.filter(function (s) { return Boolean(pushSess[s.sessionId]); }).length;
        var shouldCheck = targetSessions.length > 0 ? selectedCount < targetSessions.length : !pushWs[ws.path];

        var nextWs = Object.assign({}, pushWs);
        if (shouldCheck && ws.path) nextWs[ws.path] = true; else delete nextWs[ws.path];
        var nextSess = Object.assign({}, pushSess);
        sessions.forEach(function (s) {
          if (shouldCheck && !s.excluded) nextSess[s.sessionId] = true; else delete nextSess[s.sessionId];
        });
        setPushWs(nextWs);
        setPushSess(nextSess);
      };

      var togglePushSession = function (ws, sid) {
        var nextSess = Object.assign({}, pushSess);
        var nowChecked = !nextSess[sid];
        if (nowChecked) nextSess[sid] = true; else delete nextSess[sid];

        var sessions = ws.sessions || [];
        var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
        var allNonExcludedChecked = nonExcluded.length > 0 && nonExcluded.every(function (s) { return Boolean(nextSess[s.sessionId]); });
        var nextWs = Object.assign({}, pushWs);
        if (nowChecked && allNonExcludedChecked && ws.path) {
          nextWs[ws.path] = true;
        } else {
          delete nextWs[ws.path];
        }
        setPushSess(nextSess);
        setPushWs(nextWs);
      };

      var togglePullWorkspace = function (ws) {
        var sessions = ws.sessions || [];
        var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
        var targetSessions = nonExcluded.length > 0 ? nonExcluded : sessions;
        var selectedCount = targetSessions.filter(function (s) { return Boolean(pullSess[s.sessionId]); }).length;
        var shouldCheck = targetSessions.length > 0 ? selectedCount < targetSessions.length : !pullWs[ws.sourceCwd];

        var nextWs = Object.assign({}, pullWs);
        if (shouldCheck && ws.sourceCwd) nextWs[ws.sourceCwd] = true; else delete nextWs[ws.sourceCwd];
        var nextSess = Object.assign({}, pullSess);
        sessions.forEach(function (s) {
          if (shouldCheck && !s.excluded) nextSess[s.sessionId] = true; else delete nextSess[s.sessionId];
        });
        setPullWs(nextWs);
        setPullSess(nextSess);
      };

      var togglePullSession = function (ws, sid) {
        var nextSess = Object.assign({}, pullSess);
        var nowChecked = !nextSess[sid];
        if (nowChecked) nextSess[sid] = true; else delete nextSess[sid];

        var sessions = ws.sessions || [];
        var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
        var allNonExcludedChecked = nonExcluded.length > 0 && nonExcluded.every(function (s) { return Boolean(nextSess[s.sessionId]); });
        var nextWs = Object.assign({}, pullWs);
        if (nowChecked && allNonExcludedChecked && ws.sourceCwd) {
          nextWs[ws.sourceCwd] = true;
        } else {
          delete nextWs[ws.sourceCwd];
        }
        setPullSess(nextSess);
        setPullWs(nextWs);
      };

      var handleSelectAllUnsyncedPull = function () {
        var nextWs = {};
        var nextSess = {};
        var count = 0;
        vaultWorkspaces.forEach(function (ws) {
          var sessions = ws.sessions || [];
          var unsynced = sessions.filter(function (s) { return !s.excluded && s.localStatus !== 'up-to-date'; });
          unsynced.forEach(function (s) {
            nextSess[s.sessionId] = true;
            count += 1;
          });
          if (sessions.length > 0 && unsynced.length === sessions.length && ws.sourceCwd) {
            nextWs[ws.sourceCwd] = true;
          }
        });
        setPullWs(nextWs);
        setPullSess(nextSess);
        if (count === 0) {
          setNotice({ level: 'ok', text: '金库中的所有远端对话在当前电脑上均已是最新版本。' });
        } else {
          setNotice({ level: 'ok', text: '已一键勾选 ' + count + ' 条有更新或新增的远端对话。' });
        }
      };

      var handleSaveConnectionClick = function (confirmRotation) {
        var trimmedVault = stripOuterQuotesClient(connVaultDir);
        if (!trimmedVault) {
          setNotice({ level: 'err', text: '请先填写网盘防灾金库目录路径。' });
          return;
        }
        var body = {
          vaultDir: trimmedVault,
          deviceLabel: connLabel.trim() || undefined,
          stepSyncEnabled: Boolean(connStepSync),
        };
        var passToUse = confirmRotation && pendingKeyRotation ? pendingKeyRotation.passphrase : connPassphrase;
        if (passToUse && passToUse.length > 0) {
          body.passphrase = passToUse;
        }
        if (confirmRotation === true) {
          body.confirmKeyRotation = true;
        }
        runAction(
          function () { return apiFetch('/settings', { method: 'POST', body: body }); },
          function (res) {
            if (res && res.requiresKeyRotationConfirm) {
              setPendingKeyRotation({
                confirmKind: res.confirmKind || 'rotate-passphrase',
                passphrase: passToUse,
                warning: res.warning || '新口令无法解密现有金库记录，未覆盖本地密钥。',
              });
              setConnOpen(true);
              return { level: 'warn', text: res.warning || '新口令无法解密现有金库记录，未覆盖本地密钥。' };
            }
            resetConnDraftState();
            setConnVaultDir((res && res.config && res.config.vaultDir) || trimmedVault);
            setConnOpen(false);
            return confirmRotation
              ? '已确认轮换整个金库加密口令并重新加密推送本机全部对话与产出。'
              : '金库连接与加密设置已保存并立即生效。';
          },
        );
      };

      var handleClearPassphraseClick = function (confirmDowngrade) {
        var body = { clearPassphrase: true };
        if (confirmDowngrade === true) {
          body.confirmKeyRotation = true;
        }
        runAction(
          function () { return apiFetch('/settings', { method: 'POST', body: body }); },
          function (res) {
            if (res && res.requiresKeyRotationConfirm) {
              setConfirmClearOpen(false);
              setPendingKeyRotation({
                confirmKind: res.confirmKind || 'clear-to-plaintext',
                passphrase: '',
                warning: res.warning || '当前金库存在加密历史记录，直接切明文将导致历史记录无法读取。',
              });
              setConnOpen(true);
              return { level: 'warn', text: res.warning || '当前金库存在加密历史记录，未删除本地密钥。' };
            }
            resetConnDraftState();
            return confirmDowngrade
              ? '已确认关闭加密并切回明文模式，并已清理本机旧密文提交重新推送明文。请务必同步将另一台电脑切为明文或换用新空金库。'
              : '已关闭加密并切换为明文模式。';
          },
        );
      };

      var handleAddMappingClick = function () {
        var cleanWin = stripOuterQuotesClient(winPath);
        var cleanMac = stripOuterQuotesClient(macPath);
        if (!cleanWin || !cleanMac) {
          setNotice({ level: 'err', text: '请同时填写或选择 Windows 路径与 macOS 路径。' });
          return;
        }
        runAction(
          function () {
            return apiFetch('/mappings', {
              method: 'POST',
              body: { winPath: cleanWin, macPath: cleanMac },
            });
          },
          function () {
            setWinPath('');
            setMacPath('');
            return '已绑定跨系统文件夹一一对应关系并同步到金库（对端将自动接收）。';
          },
        );
      };

      var handlePrefillMappingForLocalWs = function (wsPath) {
        if (!wsPath) return;
        if (platform === 'win32') {
          setWinPath(wsPath);
        } else {
          setMacPath(wsPath);
        }
        if (mappingSectionRef.current && typeof mappingSectionRef.current.scrollIntoView === 'function') {
          mappingSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setNotice({ level: 'ok', text: '已将「' + wsPath + '」填入上方目录对应表单，请补全对端系统路径后点击「+ 绑定对应」。' });
      };

      var handleToggleExcludeSession = function (sid, currentlyExcluded) {
        var cur = (cfg.excludedSessionIds || []).slice();
        var next = currentlyExcluded
          ? cur.filter(function (id) { return id !== sid; })
          : cur.concat([sid]);
        runAction(
          function () { return apiFetch('/settings', { method: 'POST', body: { excludedSessionIds: next } }); },
          currentlyExcluded ? '已取消屏蔽该对话，恢复参与同步。' : '已将该对话加入屏蔽清单（永不自动同步）。',
          { resyncSelection: true },
        );
      };

      var handleUnpublishSession = function (sid) {
        setConfirmWithdrawSid(null);
        runAction(
          function () { return apiFetch('/unpublish', { method: 'POST', body: { sessionIds: [sid] } }); },
          function (res) {
            return '已从金库撤回该对话快照（删除 ' + (res.removedCommits || 0) + ' 份提交、回收 ' + (res.prunedBlobs || 0) + ' 个历史快照块）并加入屏蔽清单；本机磁盘上的对话与工作区文件保持原样未删。';
          },
          { resyncSelection: true },
        );
      };

      var computePushSelection = function (rememberSelection) {
        var wsList = [];
        var sidList = [];
        localWorkspaces.forEach(function (ws) {
          var sessions = ws.sessions || [];
          var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
          var picked = sessions.filter(function (s) { return Boolean(pushSess[s.sessionId]); });
          var allChecked = sessions.length > 0 && picked.length === sessions.length;
          var allNonExcludedChecked = nonExcluded.length > 0 && nonExcluded.every(function (s) { return Boolean(pushSess[s.sessionId]); });
          var includeWholeWs = Boolean(
            ws.path
            && pushWs[ws.path]
            && (
              allChecked
              || (rememberSelection && (sessions.length === 0 || allNonExcludedChecked))
            ),
          );
          if (includeWholeWs) {
            wsList.push(ws.path);
          } else {
            picked.forEach(function (s) { sidList.push(s.sessionId); });
          }
        });
        return { wsList: wsList, sidList: sidList };
      };

      var handlePushSelectedClick = function (rememberSelection, confirmedScopeSwitch) {
        var sel = computePushSelection(rememberSelection);
        var wsList = sel.wsList;
        var sidList = sel.sidList;
        if (wsList.length === 0 && sidList.length === 0) {
          setNotice({ level: 'err', text: '请先勾选至少一个本机工作区或对话。' });
          return;
        }
        if (rememberSelection) {
          if (cfg.syncScope !== 'selected' && confirmedScopeSwitch !== true) {
            setConfirmSwitchScopeOpen(true);
            return;
          }
          setConfirmSwitchScopeOpen(false);
          runAction(
            function () {
              return apiFetch('/settings', {
                method: 'POST',
                body: {
                  syncScope: 'selected',
                  selectedWorkspaces: wsList,
                  selectedSessionIds: sidList,
                  withdrawUnselected: Boolean(withdrawUnselected),
                },
              });
            },
            function (res) {
              var extra = res && res.withdrawnCount > 0 ? ('，并已从金库撤回 ' + res.withdrawnCount + ' 条未勾选的本机旧会话') : '';
              return '已保存日常持续同步白名单（' + wsList.length + ' 个工作区 / ' + sidList.length + ' 条单选对话' + extra + '）。';
            },
            { resyncSelection: true },
          );
          return;
        }
        runAction(
          function () {
            return apiFetch('/push-selected', {
              method: 'POST',
              body: {
                workspacePaths: wsList,
                sessionIds: sidList,
                rememberSelection: false,
              },
            });
          },
          function (res) {
            var skippedOuts = (res && res.skippedOutputs) || [];
            var wsUploaded = (res && res.workspaces || []).reduce(function (acc, w) { return acc + ((w.uploaded && w.uploaded.length) || 0); }, 0);
            var prefix = isEncrypted ? '加密上传完成：共推送 ' : '上传完成（明文模式）：共推送 ';
            var baseMsg = prefix + (res.sessionPushedCount || 0) + ' 条对话记录' + (wsUploaded > 0 ? ('、' + wsUploaded + ' 个工作区产出') : '') + '。';
            if (skippedOuts.length > 0) {
              return {
                level: 'warn',
                text: baseMsg + ' ⚠️ 有 ' + skippedOuts.length + ' 个 outputs/ 文件因超限或含敏感信息被跳过：' + skippedOuts.slice(0, 3).map(function (o) { return o.path + '(' + o.reason + ')'; }).join('、'),
              };
            }
            return { level: 'ok', text: baseMsg };
          },
        );
      };

      var handlePullSelectedClick = function () {
        var wsList = [];
        var sidList = [];
        var selectedUnmappedMissingTarget = [];
        var missingCustomNames = [];
        var nextMissingCustomMap = {};
        var cleanOverrides = {};

        vaultWorkspaces.forEach(function (ws) {
          var sessions = ws.sessions || [];
          var picked = sessions.filter(function (s) { return Boolean(pullSess[s.sessionId]); });
          var wsCheckedFull = sessions.length > 0 && picked.length === sessions.length && pullWs[ws.sourceCwd] && ws.sourceCwd;
          var hasAnySelected = wsCheckedFull || picked.length > 0;
          if (!hasAnySelected) return;

          var rawTarget = pullTargets[ws.sourceCwd] || '';
          if (rawTarget === CUSTOM_TARGET_SENTINEL) {
            var customVal = stripOuterQuotesClient(pullCustomPaths[ws.sourceCwd] || '');
            if (!customVal) {
              missingCustomNames.push(ws.sourceTitle || ws.sourceCwd);
              nextMissingCustomMap[ws.sourceCwd] = true;
            } else {
              cleanOverrides[ws.sourceCwd] = customVal;
            }
          } else {
            var resolvedOverride = rawTarget.trim();
            if (resolvedOverride) {
              cleanOverrides[ws.sourceCwd] = resolvedOverride;
            } else if (
              cfg.folderMatchMode === 'mapped-only'
              && picked.some(function (s) { return s.targetMatchKind === 'unmapped-skipped'; })
            ) {
              selectedUnmappedMissingTarget.push(ws.sourceTitle || ws.sourceCwd);
            }
          }

          if (wsCheckedFull) {
            wsList.push(ws.sourceCwd);
          } else {
            picked.forEach(function (s) { sidList.push(s.sessionId); });
          }
        });

        setPullMissingCustomKeys(nextMissingCustomMap);

        if (wsList.length === 0 && sidList.length === 0) {
          setNotice({ level: 'err', text: '请先勾选至少一个金库工作区或对话。' });
          return;
        }

        if (missingCustomNames.length > 0) {
          setNotice({
            level: 'err',
            text: '请先在红框中填写工作区「' + missingCustomNames.join('、') + '」的自定义本机目标目录路径，或改选其他落入选项。',
          });
          return;
        }

        if (selectedUnmappedMissingTarget.length > 0) {
          setNotice({
            level: 'warn',
            text: '⚠️ 严格一一对应模式下，请先为未对应工作区「' + selectedUnmappedMissingTarget.join('、') + '」在右侧下拉框选择「✨ 自动创建独立同名工作区」、已有本机目录或自定义输入路径，再点击拉取。',
          });
          return;
        }

        var hasAutoMirrorOnly = Object.keys(cleanOverrides).length > 0 && Object.keys(cleanOverrides).every(function (k) {
          return cleanOverrides[k] === AUTO_MIRROR_SENTINEL;
        });

        runAction(
          function () {
            return apiFetch('/pull-selected', {
              method: 'POST',
              body: {
                workspaceSources: wsList,
                sessionIds: sidList,
                targetOverrides: cleanOverrides,
                saveMappings: Boolean(savePullMap && !hasAutoMirrorOnly),
              },
            });
          },
          function (res) {
            var s = (res.sessions && res.sessions.summary) || {};
            var imported = s.imported || 0;
            var ff = s.fastForwarded || 0;
            var forked = s.forkedBranches || 0;
            var skippedUnmapped = s.skippedUnmapped || 0;
            var applied = (res.workspaces || []).reduce(function (acc, w) { return acc + ((w.applied && w.applied.length) || 0); }, 0);
            var text = '按需拉取完成：新增 ' + imported + ' / 快进 ' + ff + ' / 分叉 ' + forked
              + (applied > 0 ? (' / 产出更新 ' + applied) : '')
              + (skippedUnmapped > 0 ? (' / 跳过未对应 ' + skippedUnmapped + '（请先绑定对应或在下拉框指定落入目录）') : '（已置顶至左侧边栏）')
              + '。';
            return { level: skippedUnmapped > 0 ? 'warn' : 'ok', text: text };
          },
        );
      };

      var handleDisconnectVault = function () {
        setConfirmMaintAction(null);
        runAction(
          function () { return apiFetch('/disconnect', { method: 'POST', body: {} }); },
          function () {
            resetConnDraftState();
            setConnVaultDir('');
            return '已暂停跨机同步并断开金库连接；本机全部对话与工作区文件均完好保留。';
          },
        );
      };

      var handleResetLocalConfig = function () {
        setConfirmMaintAction(null);
        runAction(
          function () { return apiFetch('/reset', { method: 'POST', body: { confirm: true } }); },
          function () {
            resetConnDraftState();
            setConnVaultDir('');
            setConnLabel('');
            setConnStepSync(true);
            setConnOpen(true);
            return '已重置本机 Soul Sync 同步配置与密钥；本机历史对话、工作区文件与登录账号均完好保留。';
          },
          { resyncSelection: true },
        );
      };

      var handleUninstallPlugin = function () {
        setConfirmMaintAction(null);
        runAction(
          function () { return apiFetch('/uninstall', { method: 'POST', body: { confirm: true } }); },
          function () {
            resetConnDraftState();
            setUninstalledDone(true);
            return '✅ 插件已安全卸载！您的全部历史对话、工作区文件与登录账号均完好保留，请退出并重新打开一次 DeepSeek Harness 完成移除。';
          },
          { skipReload: true },
        );
      };

      // Filter out vaultDir AND broad system/personal dirs from quick-pick dropdowns!
      var localPathOptions = localWorkspaces.filter(function (w) {
        return Boolean(w.path) && !w.isVaultDir && !w.isBroadSystemDir;
      });
      var winRemoteOptions = vaultWorkspaces.filter(function (w) { return Boolean(w.sourceCwd) && w.fromPlatform === 'win32'; });
      var macRemoteOptions = vaultWorkspaces.filter(function (w) { return Boolean(w.sourceCwd) && w.fromPlatform !== 'win32'; });
      var winDropdownOptions = platform === 'win32' ? localPathOptions : winRemoteOptions;
      var macDropdownOptions = platform === 'darwin' ? localPathOptions : macRemoteOptions;
      var effectivePeerOs = peerOs || (platform === 'win32' ? 'darwin' : 'win32');
      var peerOsShortLabel = platform === 'win32' ? 'Mac' : 'Win';

      var toggleConnDrawer = function () {
        resetConnDraftState();
        if (!connOpen) {
          setConnVaultDir(cfg.vaultDir || '');
          setConnLabel(cfg.deviceLabel || '');
          setConnStepSync(cfg.stepSyncEnabled !== false);
        }
        setConnOpen(!connOpen);
      };

      var togglePairDrawer = function () {
        if (pairOpen && !connOpen) {
          clearRevealedPassphrase();
        }
        setPairOpen(!pairOpen);
      };

      var jumpToReenterPassphrase = function () {
        setConnVaultDir(cfg.vaultDir || '');
        setConnLabel(cfg.deviceLabel || '');
        setConnStepSync(cfg.stepSyncEnabled !== false);
        setConnOpen(true);
      };

      var emptyWhitelistWarning = cfg.syncScope === 'selected'
        && (cfg.selectedWorkspaces || []).length === 0
        && (cfg.selectedSessionIds || []).length === 0;

      // Determine whether any currently selected pull workspace uses AUTO_MIRROR_SENTINEL without concrete targets
      var anyAutoMirrorOverride = Object.keys(pullTargets).some(function (k) { return pullTargets[k] === AUTO_MIRROR_SENTINEL; });
      var anyConcreteTargetOverride = Object.keys(pullTargets).some(function (k) { return Boolean(pullTargets[k]) && pullTargets[k] !== AUTO_MIRROR_SENTINEL; });
      var savePullMapNotApplicable = anyAutoMirrorOverride && !anyConcreteTargetOverride;

      if (loading && !data) {
        return h('div', { className: 'dss-root' }, h('div', { className: 'dss-empty' }, '正在加载 Soul Sync 跨机迁移面板…'));
      }

      return h(
        'div',
        { className: 'dss-root' },
        // Header
        h(
          'div',
          { className: 'dss-header' },
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('h2', { className: 'dss-title' }, 'Soul Sync 跨机迁移与目录对应'),
            h(
              'p',
              { className: 'dss-sub' },
              data && data.hasVault
                ? ('金库：' + cfg.vaultDir + ' · ' + (isEncrypted ? '已开启端到端加密' : '明文模式') + ' · 本机：' + (cfg.deviceLabel || platform))
                : '尚未完成金库连接，请在下方「🔑 金库连接与加密基础设置」填写网盘金库路径与加密口令。',
            ),
          ),
          h(
            'div',
            { className: 'dss-actions' },
            h('button', {
              type: 'button',
              className: 'dss-btn',
              onClick: function () { setGuideOpen(!guideOpen); },
            }, guideOpen ? '收起上手说明' : '❓ 30秒上手说明'),
            h('button', {
              type: 'button',
              className: 'dss-btn',
              disabled: writeDisabled,
              title: '仅重新扫描刷新本页面的列表显示，不会上传或下载任何数据',
              onClick: function () { loadState(false, false); },
            }, '🔄 刷新列表显示'),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-primary',
              disabled: writeDisabled || !(data && data.hasVault),
              title: '立即接收另一台电脑的新对话/新回复，并把本机最新进度上传到网盘',
              onClick: function () {
                runAction(
                  function () { return apiFetch('/sync', { method: 'POST', body: {} }); },
                  function () { return '收发同步已完成，左侧对话列表已更新。'; },
                );
              },
            }, '⚡ 立即收发同步'),
          ),
        ),

        // Post-uninstall prominent banner
        isUninstalled && h(
          'div',
          { className: 'dss-banner dss-banner-ok' },
          h(
            'span',
            null,
            '✅ Soul Sync 插件已安全卸载！您电脑上的全部历史对话、工作区文件与登录账号 100% 完好保留。请退出并重新打开一次 DeepSeek Harness（Windows 右键右下角托盘退出；Mac 按 Cmd+Q 退出）以完成界面移除。',
          ),
        ),

        // 30-second Quickstart Guide Card
        guideOpen && h(
          'div',
          { className: 'dss-card' },
          h(
            'div',
            { className: 'dss-card-title' },
            h('span', null, '📖 30 秒上手说明（零技术门槛三步走）'),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-sm',
              onClick: function () { setGuideOpen(false); },
            }, '知道了'),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px' } },
            h('div', null, h('strong', null, '① 金库放网盘存密文：'), '在坚果云 / OneDrive / iCloud 等网盘里新建一个专用空文件夹（如 dsh-vault）当作同步中转站，并右键勾选「始终保留在此设备上」；两台电脑填同一个网盘目录 + 同一个加密口令即可自动互通。'),
            h('div', null, h('strong', null, '② 项目文件夹选自动或绑对应：'), '您平时干活的代码/文档文件夹继续留在本地电脑，绝不要放进网盘。默认会自动创建独立同名目录；若希望跨系统（Win ⇄ Mac）全目录同步脚本/表格与 Excel 防锁，在下方绑一次一一对应即可。'),
            h('div', null, h('strong', null, '③ 下方打勾上传/拉取：'), '平时无需任何操作，每聊完一轮会自动同步；需要按需挑选对话上传、拉取、屏蔽或从网盘撤回时，直接在最下方工作台打勾操作即可。'),
          ),
        ),

        // Sticky Action Feedback Notice (always visible even when scrolled to bottom!)
        notice && h(
          'div',
          {
            className: 'dss-banner dss-notice-sticky ' + (
              notice.level === 'err' ? 'dss-banner-err' : notice.level === 'warn' ? 'dss-banner-warn' : 'dss-banner-ok'
            ),
          },
          h('span', { style: { flex: 1 } }, notice.text),
          h('button', {
            type: 'button',
            className: 'dss-btn dss-btn-sm',
            onClick: function () { setNotice(null); },
          }, '关闭'),
        ),

        // Diagnostic & Error Recovery Banners
        (cfg.encryptionEnabled && !hasSecretKey) && h(
          'div',
          { className: 'dss-banner dss-banner-err' },
          h('span', null, '🔐 本机已开启加密模式但缺少本地密钥，同步已暂停。请在下方「金库连接与加密基础设置」重新输入与另一台电脑一致的加密口令并保存。'),
        ),
        decryptionFailedCount > 0 && h(
          'div',
          { className: 'dss-banner dss-banner-err' },
          h(
            'span',
            null,
            '⚠️ 加密口令不一致：金库中有 ' + decryptionFailedCount + ' 条远端记录无法解密'
              + (Object.keys(decryptionFailedDevices).length > 0
                ? ('（涉及设备：' + Object.keys(decryptionFailedDevices).map(function (d) { return (decryptionFailedDeviceLabels[d] || d) + ' ' + decryptionFailedDevices[d] + ' 条'; }).join('、') + '）')
                : '')
              + '。请检查本机下方口令是否与另一台电脑完全一致并重新保存；若本机已能正常显示其他设备对话，则说明对应设备曾用错误口令写入过记录，在该设备上改回正确口令保存后将自动清理。',
          ),
        ),
        vaultError && h(
          'div',
          { className: 'dss-banner dss-banner-err' },
          h('span', null, '⚠️ 金库目录读取异常（可能是网盘暂时离线或权限不足）：' + vaultError + '。您仍可在下方修改金库路径或稍后刷新。'),
        ),
        startupErrors.length > 0 && h(
          'div',
          { className: 'dss-banner dss-banner-err' },
          h('span', null, '⚠️ 启动诊断提示：' + startupErrors.join('；')),
        ),
        vaultConfigured && data && data.vaultLooksLikeCloudDrive === false && h(
          'div',
          { className: 'dss-banner dss-banner-warn' },
          h('span', null, '💡 当前金库路径看起来不在常见网盘同步目录内（OneDrive / 坚果云 / iCloud / 百度网盘 / NAS）。如果只放在单机本地目录，另一台电脑将收不到更新，请确认该目录已开启云盘同步。'),
        ),
        hydrationPendingCount > 0 && h(
          'div',
          { className: 'dss-banner dss-banner-warn' },
          h('span', null, '⏳ 网盘同步中：金库有 ' + hydrationPendingCount + ' 条记录尚未从云端下载到本地，待网盘下载完成后将自动恢复。'),
        ),
        alerts.length > 0 && h(
          'div',
          { className: 'dss-banner dss-banner-warn' },
          h(
            'div',
            null,
            h('strong', null, '🔔 同步提醒（' + alerts.length + ' 条）：'),
            alerts.map(function (a) { return a.text; }).join('；'),
          ),
          h('button', {
            type: 'button',
            className: 'dss-btn dss-btn-sm',
            disabled: writeDisabled,
            onClick: function () {
              runAction(
                function () { return apiFetch('/alerts/dismiss', { method: 'POST', body: { all: true } }); },
                '已清除全部同步提醒。',
              );
            },
          }, '清除提醒'),
        ),
        emptyWhitelistWarning && h(
          'div',
          { className: 'dss-banner dss-banner-warn' },
          h('span', null, '⚠️ 当前处于「精选白名单模式」，但白名单为空——本机所有对话均不会自动推送到金库。请在下方勾选工作区或对话后点击「保存为日常持续同步白名单」。'),
        ),

        // Section 0: Vault & Passphrase Basic Settings Card (Figure 1 + Figure 2)
        h(
          'div',
          { className: 'dss-card' },
          h(
            'div',
            { className: 'dss-card-title', style: { marginBottom: connOpen ? '8px' : '0' } },
            h('span', null, '🔑 金库连接与加密基础设置（网盘同步中转站）'),
            h(
              'div',
              { className: 'dss-actions' },
              h('button', {
                type: 'button',
                className: 'dss-btn dss-btn-sm',
                disabled: isUninstalled,
                onClick: togglePairDrawer,
              }, pairOpen ? '收起配对向导' : '📲 配对另一台电脑'),
              h('button', {
                type: 'button',
                className: connOpen ? 'dss-btn dss-btn-sm' : 'dss-btn dss-btn-sm dss-btn-primary',
                disabled: isUninstalled,
                onClick: toggleConnDrawer,
              }, connOpen ? '收起设置' : '更换金库 / 修改口令'),
            ),
          ),
          !connOpen && vaultConfigured && h(
            'div',
            { className: 'dss-conn-summary' },
            h(
              'div',
              { style: { minWidth: 0, flex: 1 } },
              h('span', { className: 'dss-label' }, '当前防灾金库目录：'),
              h('code', { className: 'dss-code-inline' }, cfg.vaultDir),
            ),
            h(
              'span',
              { className: 'dss-meta' },
              (isEncrypted ? '🔐 端到端加密已开启' : '🔓 明文模式')
              + ' · 30秒快照：' + (cfg.stepSyncEnabled !== false ? '开' : '关')
              + ' · 本机：' + (cfg.deviceLabel || platform),
            ),
          ),
          connOpen && h(
            'div',
            null,
            h(
              'p',
              { className: 'dss-hint' },
              '💡 这里填网盘同步文件夹里的专用空目录（如坚果云 / OneDrive / iCloud 下的 dsh-vault），专门存加密同步快照，不要填日常本地项目目录。',
            ),
            h(
              'div',
              { className: 'dss-conn-grid' },
              // Field 1: Vault directory
              h(
                'div',
                { className: 'dss-field' },
                h('label', { className: 'dss-label' }, '防灾金库目录（两台电脑指向网盘里的同一个同步文件夹）'),
                h('input', {
                  className: 'dss-input',
                  type: 'text',
                  placeholder: platform === 'win32' ? '例如 D:\\OneDrive\\dsh-vault 或 D:\\我的坚果云\\DSH' : '例如 /Users/你的名字/Nutstore Files/我的坚果云/DSH',
                  value: connVaultDir,
                  onChange: function (e) { setConnVaultDir(e.target.value); },
                }),
                h(
                  'div',
                  { className: 'dss-hint-tight' },
                  '📋 复制路径方法：Windows 按住 Shift+右键文件夹 →「复制文件地址」；Mac 访达按住 Option+右键 →「拷贝路径名称」（粘贴带引号会自动清理）。',
                ),
              ),

              // Field 2a (Figure 1): Read-only current passphrase viewer when hasSecretKey
              hasSecretKey && h(
                'div',
                { className: 'dss-field' },
                h('label', { className: 'dss-label' }, '当前生效加密口令（只读查看，方便配对另一台电脑）'),
                h(
                  'div',
                  { className: 'dss-reveal-row' },
                  h(
                    'span',
                    { className: 'dss-code-inline', style: { flex: 1, minWidth: 0 } },
                    revealedPass !== null ? revealedPass : '••••••••••••',
                  ),
                  h(
                    'div',
                    { className: 'dss-actions' },
                    revealedPass !== null && h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      onClick: function () {
                        copyTextToClipboard(revealedPass).then(function (ok) {
                          setNotice({
                            level: ok ? 'ok' : 'warn',
                            text: ok ? '✅ 已复制当前生效加密口令到剪贴板（30 秒后界面自动隐藏）。' : '请手动选中上方口令复制。',
                          });
                        });
                      },
                    }, '📋 复制口令'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: revealLoading,
                      onClick: handleRevealPassphrase,
                    }, revealedPass !== null ? '隐藏' : (revealLoading ? '读取中…' : '👁 显示明文')),
                  ),
                ),
                revealUnavailable && h(
                  'div',
                  { className: 'dss-banner dss-banner-warn', style: { marginTop: '4px' } },
                  h('span', null, '当前为旧版密钥文件，本机尚未记录可查看的明文口令。您只需在下方输入框重新输入一次相同口令并点击「保存连接设置」，以后就能随时点击查看或复制。'),
                ),
              ),

              // Field 2b (Figure 1): Independent modify / set passphrase input
              h(
                'div',
                { className: 'dss-field' },
                h(
                  'label',
                  { className: 'dss-label' },
                  hasSecretKey
                    ? '修改 / 更换加密口令（不修改请留空）'
                    : '设置端到端加密口令（双机填同一个；留空为明文模式）',
                ),
                h(
                  'div',
                  { className: 'dss-input-row' },
                  h('input', {
                    className: 'dss-input',
                    type: showPass ? 'text' : 'password',
                    placeholder: hasSecretKey
                      ? '不改请留空；直接输入新口令并点保存即可修改密码'
                      : '输入双机一致的加密口令（留空为明文模式）',
                    value: connPassphrase,
                    onChange: function (e) { setConnPassphrase(e.target.value); },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-sm',
                    onClick: function () { setShowPass(!showPass); },
                  }, showPass ? '隐藏' : '显示'),
                ),
              ),

              // Field 3: Device label
              h(
                'div',
                { className: 'dss-field' },
                h('label', { className: 'dss-label' }, '本机昵称（方便在另一台电脑识别来源，如「公司Win」「家里Mac」）'),
                h('input', {
                  className: 'dss-input',
                  type: 'text',
                  placeholder: '例如 公司Win / 家里Mac',
                  value: connLabel,
                  onChange: function (e) { setConnLabel(e.target.value); },
                }),
              ),

              // Field 4: Step sync checkbox
              h(
                'div',
                { className: 'dss-field' },
                h(
                  'label',
                  { className: 'dss-label', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(connStepSync),
                    onChange: function (e) { setConnStepSync(e.target.checked); },
                  }),
                  '开启运行中每 30 秒防断电快照（关闭后仍会在每轮对话结束自动同步）',
                ),
              ),
            ),

            // Key rotation / plaintext downgrade confirmation banner returned by backend guard
            pendingKeyRotation && h(
              'div',
              { className: 'dss-banner dss-banner-warn', style: { marginTop: '10px' } },
              h('span', { style: { flex: 1 } }, '⚠️ ' + pendingKeyRotation.warning),
              h(
                'div',
                { className: 'dss-actions' },
                h('button', {
                  type: 'button',
                  className: 'dss-btn dss-btn-sm',
                  disabled: writeDisabled,
                  onClick: function () { setPendingKeyRotation(null); },
                }, '取消'),
                h('button', {
                  type: 'button',
                  className: 'dss-btn dss-btn-sm dss-btn-danger',
                  disabled: writeDisabled,
                  onClick: function () {
                    if (pendingKeyRotation.confirmKind === 'clear-to-plaintext') {
                      handleClearPassphraseClick(true);
                    } else {
                      handleSaveConnectionClick(true);
                    }
                  },
                }, pendingKeyRotation.confirmKind === 'clear-to-plaintext' ? '确认放弃加密并切回明文' : '确认轮换整个金库口令'),
              ),
            ),

            // Primary Save Bar (Figure 2: NO red clear-key button next to primary save!)
            h(
              'div',
              { className: 'dss-footer-bar' },
              h(
                'span',
                { className: 'dss-hint-tight', style: { flex: 1, minWidth: '200px' } },
                '💡 想修改密码？直接在上方输入框填入新口令并点右侧「保存连接设置」即可，切勿点清除密钥！（密钥仅存本机，绝不上传网盘）',
              ),
              h(
                'div',
                { className: 'dss-actions' },
                h('button', {
                  type: 'button',
                  className: 'dss-btn dss-btn-primary',
                  disabled: writeDisabled,
                  onClick: function () { handleSaveConnectionClick(false); },
                }, '保存连接设置'),
              ),
            ),

            // Figure 2: Isolated secondary danger zone for disabling encryption
            (hasSecretKey || cfg.encryptionEnabled) && h(
              'div',
              { className: 'dss-danger-zone' },
              h(
                'div',
                { style: { marginBottom: '8px' } },
                h('strong', null, '⚠️ 关闭加密说明：'),
                '点击「关闭加密（清除密钥）」会删除本机加密密钥并切回明文模式——金库里已有的加密历史将无法继续读取，另一台开启加密的电脑也会报错！仅在双机决定放弃加密时使用；若只是换密码请直接在上方输入新口令保存。',
              ),
              !confirmClearOpen
                ? h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-sm dss-btn-danger',
                    disabled: writeDisabled,
                    onClick: function () { setConfirmClearOpen(true); },
                  }, '关闭加密（清除密钥）')
                : h(
                    'div',
                    { className: 'dss-actions' },
                    h('span', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontWeight: 500 } }, '确定删除本机密钥并切换为明文模式吗？'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: function () { setConfirmClearOpen(false); },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm dss-btn-danger',
                      disabled: writeDisabled,
                      onClick: function () { handleClearPassphraseClick(false); },
                    }, '确认关闭加密（切回明文）'),
                  ),
            ),
          ),
        ),

        // Section 0.5: Peer Computer Pairing Wizard Drawer (P1-3)
        pairOpen && h(
          'div',
          { className: 'dss-card' },
          h(
            'div',
            { className: 'dss-card-title' },
            h('span', null, '📲 首次安装：如何让另一台电脑知道怎么同步？'),
            h(
              'div',
              { className: 'dss-actions' },
              h('button', {
                type: 'button',
                className: 'dss-btn dss-btn-sm' + (effectivePeerOs === 'darwin' ? ' dss-btn-primary' : ''),
                onClick: function () { setPeerOs('darwin'); setCopiedPair(false); },
              }, '🍎 另一台是 Mac'),
              h('button', {
                type: 'button',
                className: 'dss-btn dss-btn-sm' + (effectivePeerOs === 'win32' ? ' dss-btn-primary' : ''),
                onClick: function () { setPeerOs('win32'); setCopiedPair(false); },
              }, '🪟 另一台是 Windows'),
            ),
          ),
          pairBlockedReason && h(
            'div',
            { className: 'dss-banner dss-banner-warn', style: { marginBottom: '8px' } },
            h('span', null, '⚠️ ' + pairBlockedReason),
          ),
          h(
            'div',
            { className: 'dss-step-box', style: { marginTop: 0, marginBottom: '8px' } },
            h('strong', null, '配对前 2 件准备工作（30 秒）：'),
            h('div', null, '① 把 dsh-soul-sync 插件文件夹发到另一台电脑并放到固定目录（如「文档」），不要放在临时「下载」目录；'),
            h('div', null, '② 在另一台电脑右键网盘里的金库文件夹，勾选「始终保留在此设备上 / Always keep on this device」并等网盘同步出绿勾。'),
          ),
          hasSecretKey && h(
            'div',
            { style: { marginBottom: '8px' } },
            h(
              'div',
              { className: 'dss-reveal-row' },
              h(
                'span',
                { style: { fontSize: '12px' } },
                '🔑 配对需填相同口令（为防误发群聊，下方提示词不含明文口令）：',
                revealedPass !== null && h('code', { className: 'dss-code-inline', style: { marginLeft: '6px' } }, revealedPass),
              ),
              h(
                'div',
                { className: 'dss-actions' },
                revealedPass !== null && h('button', {
                  type: 'button',
                  className: 'dss-btn dss-btn-sm',
                  onClick: function () {
                    copyTextToClipboard(revealedPass).then(function (ok) {
                      setNotice({ level: ok ? 'ok' : 'warn', text: ok ? '✅ 已复制本机当前口令。' : '请手动复制上方口令。' });
                    });
                  },
                }, '📋 复制口令'),
                h('button', {
                  type: 'button',
                  className: 'dss-btn dss-btn-sm',
                  disabled: revealLoading || isUninstalled,
                  onClick: handleRevealPassphrase,
                }, revealedPass !== null ? '隐藏口令' : '👁 查看/复制本机当前口令'),
              ),
            ),
            revealUnavailable && h(
              'div',
              { className: 'dss-banner dss-banner-warn', style: { marginTop: '6px' } },
              h('span', { style: { flex: 1 } }, '当前为旧版密钥文件，本机尚未记录可查看的明文口令。请展开上方「更换金库 / 修改口令」重新输入一次相同口令并保存，以后即可随时查看或复制。'),
              h('button', {
                type: 'button',
                className: 'dss-btn dss-btn-sm',
                disabled: isUninstalled,
                onClick: jumpToReenterPassphrase,
              }, '展开上方设置重填一次口令'),
            ),
          ),
          h(
            'div',
            { className: 'dss-step-box' },
            h('strong', null, '方式 A（另一台电脑还没装插件 · 最省心）：'),
            ' 点击下方按钮复制配对指令 → 在另一台电脑打开 DeepSeek Harness 粘贴发给 AI → 把网盘里同一个金库文件夹路径和相同口令告诉它即可全自动装好。',
            h(
              'pre',
              { className: 'dss-pair-box' },
              buildPeerPairingPrompt({
                peerPlatform: effectivePeerOs,
                deviceLabel: cfg.deviceLabel || platform,
                vaultDir: cfg.vaultDir || '',
                encrypted: isEncrypted,
                mappingCount: mappings.length,
              }),
            ),
            h(
              'div',
              { className: 'dss-actions' },
              h('button', {
                type: 'button',
                className: 'dss-btn dss-btn-primary',
                disabled: !vaultConfigured,
                onClick: function () {
                  var promptText = buildPeerPairingPrompt({
                    peerPlatform: effectivePeerOs,
                    deviceLabel: cfg.deviceLabel || platform,
                    vaultDir: cfg.vaultDir || '',
                    encrypted: isEncrypted,
                    mappingCount: mappings.length,
                  });
                  copyTextToClipboard(promptText).then(function (ok) {
                    setCopiedPair(ok);
                    setNotice({
                      level: ok ? 'ok' : 'warn',
                      text: ok
                        ? '✅ 已复制另一台电脑的安装配对指令！去另一台电脑打开 DeepSeek Harness 直接粘贴发送给 AI 即可。'
                        : '请手动全选上方文本框复制并发送给另一台电脑的 DeepSeek Harness。',
                    });
                  });
                },
              }, copiedPair ? '✅ 已复制！点击可重新复制' : '📋 一键复制发给另一台电脑 DSH 的安装配对指令'),
            ),
          ),
          h(
            'div',
            { className: 'dss-step-box' },
            h('strong', null, '方式 B（另一台电脑已经装好插件了）：'),
            ' 直接打开另一台电脑左下角「⚙️ 设置 → Soul Sync 跨机迁移」，点顶部「更换金库 / 修改口令」，填入同一个网盘金库文件夹在那台电脑上的路径'
              + (cfg.vaultDir ? ('（即网盘里的「' + extractLeafFolderName(cfg.vaultDir) + '」文件夹）') : '')
              + '和相同口令并保存，所有文件夹对应关系与对话会自动同步过来。',
          ),
        ),

        // Section 1: Folder Match Mode
        h(
          'div',
          { className: 'dss-card' },
          h('div', { className: 'dss-card-title' }, '1. 文件夹对应方式'),
          h(
            'div',
            { className: 'dss-radio-grid' },
            h(
              'button',
              {
                type: 'button',
                disabled: writeDisabled,
                className: 'dss-radio-card' + (cfg.folderMatchMode !== 'mapped-only' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { folderMatchMode: 'auto-mirror' } }); },
                    '已切换为「自动同名生成并对应」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '✨ 自动同名生成并对应（省心推荐）'),
              h('div', { className: 'dss-radio-desc' }, '已配对目录按一一对应全量追踪；未配对目录自动创建独立同名工作区并同步 outputs/（≤30MB），同名冲突时自动追加短后缀绝不混在一起。'),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: writeDisabled,
                className: 'dss-radio-card' + (cfg.folderMatchMode === 'mapped-only' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { folderMatchMode: 'mapped-only' } }); },
                    '已切换为「严格仅同步手动一一对应文件夹」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🔗 仅同步手动一一对应的文件夹'),
              h('div', { className: 'dss-radio-desc' }, '自动同步严格只处理下方映射表里配好对的工作区；按需拉取未配对项目时可当场选定落入目录或自动建同名目录，绝不静默乱建文件夹。'),
            ),
          ),
        ),

        // Section 2: Outbound Sync Scope
        h(
          'div',
          { className: 'dss-card' },
          h('div', { className: 'dss-card-title' }, '2. 本机日常自动推送范围'),
          h(
            'div',
            { className: 'dss-radio-grid' },
            h(
              'button',
              {
                type: 'button',
                disabled: writeDisabled,
                className: 'dss-radio-card' + (cfg.syncScope !== 'selected' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { syncScope: 'active' } }); },
                    '已切换为「自动同步活跃对话（过滤空窗口）」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🟢 自动同步活跃对话（自动过滤空窗口）'),
              h('div', { className: 'dss-radio-desc' }, '自动剔除 0 轮发言空壳窗口、/soul 体检卡与安装引导对话，单工作区默认按最近活跃同步前 ' + ((cfg.quotas && cfg.quotas.maxAutoSessionsPerWorkspace) || 25) + ' 条对话。'),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: writeDisabled,
                className: 'dss-radio-card' + (cfg.syncScope === 'selected' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { syncScope: 'selected' } }); },
                    '已切换为「仅自动推送我勾选的白名单（精选模式）」。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🎯 仅自动推送我勾选的工作区与对话（精选模式）'),
              h('div', { className: 'dss-radio-desc' }, '本机仅自动推送白名单中的 ' + ((cfg.selectedWorkspaces || []).length) + ' 个工作区与 ' + ((cfg.selectedSessionIds || []).length) + ' 条对话，未勾选项 100% 留在单机本地；对端主动推入金库的对话仍可正常自动接收。'),
            ),
          ),
        ),

        // Section 3: Workspace mappings management
        h(
          'div',
          { className: 'dss-card', ref: mappingSectionRef },
          h(
            'div',
            { className: 'dss-card-title' },
            h('span', null, '📂 本地项目文件夹一一对应管理（Windows ⇄ macOS · 绑定一次双机自动同步）'),
            h('span', { className: 'dss-meta' }, '已绑定 ' + mappings.length + ' 组'),
          ),
          h(
            'p',
            { className: 'dss-hint' },
            '💡 仅跨系统（Windows ⇄ macOS）需要在此绑定；同系统双机（Win ⇄ Win / Mac ⇄ Mac）保持相同文件夹名即可自动匹配，或直接在下方拉取时选落入目录。请绑定具体的单个项目子文件夹（不要绑定桌面/文档/网盘根目录或防灾金库目录）。',
          ),
          mappings.length === 0
            ? h('div', { className: 'dss-empty' }, '尚未手动绑定文件夹一一对应（未绑定工作区仅同步 outputs/ ≤30MB；绑定后支持全目录产出追踪与 Excel 防锁）。')
            : h(
                'div',
                { className: 'dss-map-list' },
                mappings.map(function (m) {
                  var isConfirmingDel = confirmDeleteMapId === m.id;
                  return h(
                    'div',
                    { key: m.id, className: 'dss-map-row' },
                    h(
                      'div',
                      { className: 'dss-map-paths' },
                      h('strong', null, '[' + m.id + '] '),
                      'Win: ', m.win32 || '(未设)', '  ⇄  Mac: ', m.darwin || '(未设)',
                    ),
                    isConfirmingDel
                      ? h(
                          'div',
                          { className: 'dss-actions' },
                          h('button', {
                            type: 'button',
                            className: 'dss-btn dss-btn-sm dss-btn-danger',
                            disabled: writeDisabled,
                            onClick: function () {
                              setConfirmDeleteMapId(null);
                              runAction(
                                function () { return apiFetch('/mappings/delete', { method: 'POST', body: { id: m.id } }); },
                                '已解除工作区映射 [' + m.id + '] 并同步至金库（本机原文件夹与文件不受影响）。',
                              );
                            },
                          }, '确认删除（同步解除双机对应）?'),
                          h('button', {
                            type: 'button',
                            className: 'dss-btn dss-btn-sm',
                            disabled: writeDisabled,
                            onClick: function () { setConfirmDeleteMapId(null); },
                          }, '取消'),
                        )
                      : h('button', {
                          type: 'button',
                          className: 'dss-btn dss-btn-sm dss-btn-danger',
                          disabled: writeDisabled,
                          onClick: function () { setConfirmDeleteMapId(m.id); },
                        }, '删除'),
                  );
                }),
              ),
          h(
            'div',
            { className: 'dss-form-grid' },
            h(
              'div',
              { className: 'dss-field' },
              h('label', { className: 'dss-label' }, 'Windows 文件夹路径（可下拉快选或手填）'),
              h('input', {
                className: 'dss-input',
                type: 'text',
                placeholder: '例如 D:\\美股分析',
                value: winPath,
                onChange: function (e) { setWinPath(e.target.value); },
              }),
              h(
                'select',
                {
                  className: 'dss-select',
                  value: '',
                  onChange: function (e) { if (e.target.value) setWinPath(e.target.value); },
                },
                h('option', { value: '' }, '从检测到的 Windows 项目工作区快选…'),
                winDropdownOptions.map(function (w) {
                  var p = platform === 'win32' ? w.path : w.sourceCwd;
                  var t = platform === 'win32' ? w.title : w.sourceTitle;
                  return h('option', { key: 'w-' + p, value: p }, t + ' (' + p + ')');
                }),
              ),
            ),
            h(
              'div',
              { className: 'dss-field' },
              h('label', { className: 'dss-label' }, 'macOS 文件夹路径（可下拉快选或手填）'),
              h('input', {
                className: 'dss-input',
                type: 'text',
                placeholder: '例如 /Users/me/美股分析',
                value: macPath,
                onChange: function (e) { setMacPath(e.target.value); },
              }),
              h(
                'select',
                {
                  className: 'dss-select',
                  value: '',
                  onChange: function (e) { if (e.target.value) setMacPath(e.target.value); },
                },
                h('option', { value: '' }, '从检测到的 macOS 项目工作区快选…'),
                macDropdownOptions.map(function (w) {
                  var p = platform === 'darwin' ? w.path : w.sourceCwd;
                  var t = platform === 'darwin' ? w.title : w.sourceTitle;
                  return h('option', { key: 'm-' + p, value: p }, t + ' (' + p + ')');
                }),
              ),
            ),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-primary',
              disabled: writeDisabled,
              onClick: handleAddMappingClick,
            }, '+ 绑定对应'),
          ),
        ),

        // Section 4: Selective Migration Workbench
        h(
          'div',
          { className: 'dss-card' },
          h('div', { className: 'dss-card-title' }, '🚀 按需挑选对话（手动往外传 / 从网盘往里收）'),
          h(
            'div',
            { className: 'dss-tabs' },
            h('button', {
              type: 'button',
              className: 'dss-tab' + (activeTab === 'push' ? ' active' : ''),
              onClick: function () { setActiveTab('push'); },
            }, '📤 从这台电脑上传 / 设常驻同步（本机 ' + ((data && data.localCatalog && data.localCatalog.totalSessions) || 0) + ' 条）'),
            h('button', {
              type: 'button',
              className: 'dss-tab' + (activeTab === 'pull' ? ' active' : ''),
              onClick: function () { setActiveTab('pull'); },
            }, '📥 从另一台电脑下载到本机（网盘 ' + ((data && data.vaultCatalog && data.vaultCatalog.totalSessions) || 0) + ' 条）'),
          ),

          activeTab === 'push'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dss-toolbar' },
                  h('span', null, '💡 这里是「往外发」：勾选这台电脑上的对话可上传到网盘，或设为以后自动同步的常驻名单；点「屏蔽」即不上传；点「从金库撤回」只删网盘备份，100% 不删电脑本地对话和文件。'),
                ),
                localWorkspaces.length === 0
                  ? h('div', { className: 'dss-empty' }, '本机暂无非空有效对话。')
                  : localWorkspaces.map(function (ws) {
                      var key = 'local:' + ws.workspaceKey;
                      var isOpen = expanded[key] !== false;
                      var sessions = ws.sessions || [];
                      var nonExcluded = sessions.filter(function (s) { return !s.excluded; });
                      var pickedCount = sessions.filter(function (s) { return Boolean(pushSess[s.sessionId]); }).length;
                      var nonExcludedPicked = nonExcluded.filter(function (s) { return Boolean(pushSess[s.sessionId]); }).length;
                      var allChecked = sessions.length === 0
                        ? Boolean(pushWs[ws.path])
                        : (pickedCount === sessions.length || (Boolean(pushWs[ws.path]) && nonExcluded.length > 0 && nonExcludedPicked === nonExcluded.length));
                      var isIndeterminate = sessions.length > 0 && pickedCount > 0 && !allChecked;

                      return h(
                        'div',
                        { key: key, className: 'dss-ws-group' },
                        h(
                          'div',
                          { className: 'dss-ws-head' },
                          h(
                            'div',
                            { className: 'dss-ws-left' },
                            h('input', {
                              type: 'checkbox',
                              checked: allChecked,
                              ref: function (el) { if (el) el.indeterminate = isIndeterminate; },
                              onChange: function () { togglePushWorkspace(ws); },
                            }),
                            h('span', { className: 'dss-ws-name' }, ws.title),
                            ws.selected && h('span', { className: 'dss-badge dss-badge-wl' }, '已纳入白名单'),
                            ws.isVaultDir
                              ? h('span', { className: 'dss-badge dss-badge-vault' }, '🏦 当前金库目录（非项目工作区）')
                              : ws.isBroadSystemDir
                                ? h('span', { className: 'dss-badge dss-badge-behind' }, '⚠️ 通用大目录（仅建议单选对话，不可绑全目录）')
                                : ws.mappingId
                                  ? h('span', { className: 'dss-badge dss-badge-new' }, '🔗 已绑定全目录追踪 + Excel 防锁')
                                  : h('span', { className: 'dss-badge dss-badge-behind' }, '📦 未绑定（仅同步 outputs/ ≤30MB）'),
                            h(
                              'span',
                              {
                                className: 'dss-ws-path',
                                style: { maxWidth: ws.mappedPeerPath ? '420px' : '260px' },
                                title: ws.mappedPeerPath ? (ws.path + ' ⇄ ' + peerOsShortLabel + ': ' + ws.mappedPeerPath) : ws.path,
                              },
                              (ws.path || '(无目录)') + (ws.mappedPeerPath ? ('  ⇄  ' + peerOsShortLabel + ': ' + ws.mappedPeerPath) : ''),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'dss-actions' },
                            h('span', { className: 'dss-meta' }, '已选 ' + pickedCount + '/' + sessions.length + ' · ' + ws.deliverableCount + ' 产出'),
                            !ws.mappingId && !ws.isVaultDir && ws.path && !ws.isBroadSystemDir && h('button', {
                              type: 'button',
                              className: 'dss-btn dss-btn-sm',
                              disabled: writeDisabled,
                              onClick: function () { handlePrefillMappingForLocalWs(ws.path); },
                            }, '绑定完整目录对应'),
                            h('button', {
                              type: 'button',
                              className: 'dss-btn dss-btn-sm',
                              onClick: function () { toggleExpanded(key); },
                            }, isOpen ? '收起' : '展开'),
                          ),
                        ),
                        isOpen && sessions.length > 0 && h(
                          'div',
                          { className: 'dss-sess-list' },
                          sessions.map(function (s) {
                            var isConfirmingWithdraw = confirmWithdrawSid === s.sessionId;
                            return h(
                              'div',
                              { key: s.sessionId, className: 'dss-sess-row' },
                              h(
                                'label',
                                { className: 'dss-sess-left', style: { cursor: 'pointer' } },
                                h('input', {
                                  type: 'checkbox',
                                  checked: Boolean(pushSess[s.sessionId]),
                                  onChange: function () { togglePushSession(ws, s.sessionId); },
                                }),
                                h('span', { className: 'dss-sess-title', title: s.title }, s.title),
                                s.isInstallSession && h('span', { className: 'dss-badge dss-badge-behind' }, '🛠️ 安装引导对话（默认不同步）'),
                                (s.selected || ws.selected) && !s.excluded && h('span', { className: 'dss-badge dss-badge-wl' }, '已纳入白名单'),
                                s.excluded && h('span', { className: 'dss-badge dss-badge-diverged' }, '已屏蔽'),
                              ),
                              h(
                                'div',
                                { className: 'dss-actions' },
                                h('span', { className: 'dss-meta' }, s.turnCount + ' 轮 · ' + formatTime(s.lastActiveAt)),
                                h('button', {
                                  type: 'button',
                                  className: 'dss-btn dss-btn-sm',
                                  disabled: writeDisabled,
                                  onClick: function () { handleToggleExcludeSession(s.sessionId, Boolean(s.excluded)); },
                                }, s.excluded ? '取消屏蔽' : '屏蔽'),
                                data && data.hasVault && s.inVault && (
                                  isConfirmingWithdraw
                                    ? h(
                                        'div',
                                        { className: 'dss-actions' },
                                        h('button', {
                                          type: 'button',
                                          className: 'dss-btn dss-btn-sm dss-btn-danger',
                                          disabled: writeDisabled,
                                          onClick: function () { handleUnpublishSession(s.sessionId); },
                                        }, '确认从网盘撤回（不删本机）?'),
                                        h('button', {
                                          type: 'button',
                                          className: 'dss-btn dss-btn-sm',
                                          disabled: writeDisabled,
                                          onClick: function () { setConfirmWithdrawSid(null); },
                                        }, '取消'),
                                      )
                                    : h('button', {
                                        type: 'button',
                                        className: 'dss-btn dss-btn-sm dss-btn-danger',
                                        disabled: writeDisabled,
                                        onClick: function () { setConfirmWithdrawSid(s.sessionId); },
                                      }, '从金库撤回')
                                ),
                              ),
                            );
                          }),
                        ),
                      );
                    }),
                confirmSwitchScopeOpen && h(
                  'div',
                  { className: 'dss-banner dss-banner-warn', style: { marginTop: '8px' } },
                  h('span', { style: { flex: 1 } }, '⚠️ 当前为「自动同步活跃对话」模式。保存为白名单后会切换为「精选白名单模式」，未勾选的其他工作区和对话将不再自动推送。确定切换并保存吗？'),
                  h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: function () { setConfirmSwitchScopeOpen(false); },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm dss-btn-primary',
                      disabled: writeDisabled,
                      onClick: function () { handlePushSelectedClick(true, true); },
                    }, '确认切换并保存白名单'),
                  ),
                ),
                h(
                  'div',
                  { className: 'dss-footer-bar' },
                  h(
                    'div',
                    { className: 'dss-actions' },
                    h(
                      'span',
                      { className: 'dss-meta' },
                      '已自动过滤 ' + ((data && data.localCatalog && data.localCatalog.filteredEmptyCount) || 0) + ' 个空壳/命令窗口',
                    ),
                    data && data.hasVault && h(
                      'label',
                      { className: 'dss-meta', style: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox',
                        checked: withdrawUnselected,
                        onChange: function (e) { setWithdrawUnselected(e.target.checked); },
                      }),
                      '保存白名单时同时从金库撤回未勾选的本机历史会话',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn',
                      disabled: writeDisabled,
                      onClick: function () { handlePushSelectedClick(true, false); },
                    }, '保存为日常持续同步白名单'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-primary',
                      disabled: writeDisabled || !(data && data.hasVault),
                      onClick: function () { handlePushSelectedClick(false, false); },
                    }, isEncrypted ? '立即加密上传选中项' : '立即上传选中项（明文模式）'),
                  ),
                ),
              )
            : h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dss-toolbar' },
                  h('span', { style: { flex: 1, minWidth: '220px' } }, '💡 这里是「往里收」：平时已配对的文件夹会自动同步，不用点这里；只有想手动挑另一台电脑的对话下载到本机（或当场指定存进哪个文件夹）时，在这里勾选即可。'),
                  vaultWorkspaces.length > 0 && h(
                    'div',
                    { className: 'dss-actions' },
                    h(
                      'label',
                      { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox',
                        checked: pullOnlyUpdates,
                        onChange: function (e) { setPullOnlyUpdates(e.target.checked); },
                      }),
                      '只看有更新/新对话',
                    ),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: handleSelectAllUnsyncedPull,
                    }, '✅ 全选未同步项'),
                  ),
                ),
                vaultWorkspaces.length === 0
                  ? h(
                      'div',
                      { className: 'dss-empty' },
                      decryptionFailedCount > 0
                        ? '检测到远端密文但当前口令不匹配，请在顶部重新输入正确口令后刷新。'
                        : '金库中暂无来自其他设备的可拉取工作区或对话。',
                    )
                  : vaultWorkspaces.map(function (ws) {
                      var key = 'vault:' + ws.sourceKey;
                      var isOpen = expanded[key] !== false;
                      var allSessions = ws.sessions || [];
                      var visibleSessions = pullOnlyUpdates
                        ? allSessions.filter(function (s) { return s.localStatus !== 'up-to-date'; })
                        : allSessions;
                      if (pullOnlyUpdates && visibleSessions.length === 0) return null;

                      var pickedCount = allSessions.filter(function (s) { return Boolean(pullSess[s.sessionId]); }).length;
                      var allChecked = allSessions.length > 0 ? pickedCount === allSessions.length : Boolean(pullWs[ws.sourceCwd]);
                      var isIndeterminate = allSessions.length > 0 && pickedCount > 0 && pickedCount < allSessions.length;
                      var currentOverride = pullTargets[ws.sourceCwd] || '';
                      var isMissingCustom = Boolean(pullMissingCustomKeys[ws.sourceCwd]);

                      return h(
                        'div',
                        { key: key, className: 'dss-ws-group' },
                        h(
                          'div',
                          { className: 'dss-ws-head' },
                          h(
                            'div',
                            { className: 'dss-ws-left' },
                            h('input', {
                              type: 'checkbox',
                              checked: allChecked,
                              ref: function (el) { if (el) el.indeterminate = isIndeterminate; },
                              onChange: function () { togglePullWorkspace(ws); },
                            }),
                            h('span', { className: 'dss-ws-name' }, ws.sourceTitle),
                            h('span', { className: 'dss-meta' }, '来自 ' + ws.fromDeviceLabel + ' · 已选 ' + pickedCount + '/' + allSessions.length),
                          ),
                          h(
                            'div',
                            { className: 'dss-actions' },
                            h(
                              'select',
                              {
                                className: 'dss-select',
                                style: { maxWidth: '260px' },
                                value: currentOverride,
                                onChange: function (e) {
                                  var val = e.target.value;
                                  setPullTargets(function (prev) {
                                    var next = Object.assign({}, prev);
                                    if (val) next[ws.sourceCwd] = val; else delete next[ws.sourceCwd];
                                    return next;
                                  });
                                  setPullMissingCustomKeys(function (prev) {
                                    var next = Object.assign({}, prev);
                                    delete next[ws.sourceCwd];
                                    return next;
                                  });
                                },
                              },
                              h(
                                'option',
                                { value: '' },
                                ws.targetPreviewPath
                                  ? ('预计落入：' + ws.targetPreviewPath)
                                  : '⚠️ 未对应（请选择下方落入目录）',
                              ),
                              h('option', { value: AUTO_MIRROR_SENTINEL }, '✨ 自动创建独立同名工作区'),
                              localPathOptions.map(function (lw) {
                                return h('option', { key: 'dst-' + lw.path, value: lw.path }, '改落入：' + lw.title + ' (' + lw.path + ')');
                              }),
                              h('option', { value: CUSTOM_TARGET_SENTINEL }, '➕ 自定义输入本机路径…'),
                            ),
                            h('button', {
                              type: 'button',
                              className: 'dss-btn dss-btn-sm',
                              onClick: function () { toggleExpanded(key); },
                            }, isOpen ? '收起' : '展开'),
                          ),
                        ),
                        currentOverride === CUSTOM_TARGET_SENTINEL && h(
                          'div',
                          { className: 'dss-custom-path-row' },
                          h('span', { className: 'dss-meta' }, '本机目标目录：'),
                          h('input', {
                            className: 'dss-input' + (isMissingCustom ? ' dss-input-err' : ''),
                            type: 'text',
                            placeholder: platform === 'win32' ? '例如 D:\\我的项目\\分析（请勿填桌面或盘符根目录）' : '例如 /Users/me/分析（请勿填桌面或用户主目录）',
                            value: pullCustomPaths[ws.sourceCwd] || '',
                            onChange: function (e) {
                              var val = e.target.value;
                              setPullCustomPaths(function (prev) {
                                var next = Object.assign({}, prev);
                                next[ws.sourceCwd] = val;
                                return next;
                              });
                              if (val && val.trim()) {
                                setPullMissingCustomKeys(function (prev) {
                                  var next = Object.assign({}, prev);
                                  delete next[ws.sourceCwd];
                                  return next;
                                });
                              }
                            },
                          }),
                        ),
                        isOpen && visibleSessions.length > 0 && h(
                          'div',
                          { className: 'dss-sess-list' },
                          visibleSessions.map(function (s) {
                            return h(
                              'label',
                              { key: s.sessionId, className: 'dss-sess-row', style: { cursor: 'pointer' } },
                              h(
                                'span',
                                { className: 'dss-sess-left' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: Boolean(pullSess[s.sessionId]),
                                  onChange: function () { togglePullSession(ws, s.sessionId); },
                                }),
                                h('span', { className: 'dss-sess-title', title: s.title }, s.title),
                                statusBadge(s.localStatus),
                                s.excluded && h('span', { className: 'dss-badge dss-badge-diverged' }, '已屏蔽'),
                              ),
                              h('span', { className: 'dss-meta' }, formatTime(s.lastActiveAt)),
                            );
                          }),
                        ),
                      );
                    }),
                h(
                  'div',
                  { className: 'dss-footer-bar' },
                  h(
                    'label',
                    {
                      className: 'dss-meta',
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        cursor: savePullMapNotApplicable ? 'not-allowed' : 'pointer',
                        opacity: savePullMapNotApplicable ? 0.55 : 1,
                      },
                    },
                    h('input', {
                      type: 'checkbox',
                      disabled: savePullMapNotApplicable,
                      checked: Boolean(savePullMap && !savePullMapNotApplicable),
                      onChange: function (e) { setSavePullMap(e.target.checked); },
                    }),
                    savePullMapNotApplicable
                      ? '将本次指定的本机目录保存为永久对应（选「自动创建独立同名工作区」时不适用）'
                      : '将本次指定的本机目录保存为永久对应（跨系统写入映射表，同系统记住落入路径）',
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-primary',
                    disabled: writeDisabled || !(data && data.hasVault),
                    onClick: handlePullSelectedClick,
                  }, '立即拉取选中项到侧边栏'),
                ),
              ),
        ),

        // Section 5: Collapsible Maintenance, Reset & Uninstall Card (P1-4)
        h(
          'div',
          { className: 'dss-card' },
          h(
            'div',
            { className: 'dss-card-title', style: { marginBottom: maintOpen ? '6px' : '0' } },
            h('span', null, '⚙️ 维护、重置与卸载插件'),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-sm',
              onClick: function () {
                setMaintOpen(!maintOpen);
                setConfirmMaintAction(null);
              },
            }, maintOpen ? '收起' : '展开选项'),
          ),
          maintOpen && h(
            'div',
            null,
            h(
              'p',
              { className: 'dss-hint' },
              '🛡️ 安全承诺：以下 3 项操作均 100% 保留您电脑上原有的全部历史对话、工作区文件与登录账号，绝不会删除任何业务资料或网盘中已备份的数据。',
            ),

            // Action 1: Disconnect vault (pause sync)
            h(
              'div',
              { className: 'dss-maint-row' },
              h(
                'div',
                { style: { flex: 1, minWidth: '200px' } },
                h('strong', null, '⏸️ 暂停同步（断开金库连接）'),
                h('div', { className: 'dss-hint-tight' }, '清空本机金库连接并停止后台同步，保留其他设置、本机对话与文件；随时可重新填写金库路径恢复。'),
              ),
              confirmMaintAction === 'disconnect'
                ? h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: function () { setConfirmMaintAction(null); },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm dss-btn-danger',
                      disabled: writeDisabled,
                      onClick: handleDisconnectVault,
                    }, '确认暂停同步'),
                  )
                : h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-sm',
                    disabled: writeDisabled || !vaultConfigured,
                    onClick: function () { setConfirmMaintAction('disconnect'); },
                  }, '暂停同步'),
            ),

            // Action 2: Reset local sync settings
            h(
              'div',
              { className: 'dss-maint-row' },
              h(
                'div',
                { style: { flex: 1, minWidth: '200px' } },
                h('strong', null, '🔄 重置本机同步设置'),
                h('div', { className: 'dss-hint-tight' }, '仅清空本机 Soul Sync 配置文件与加密密钥并恢复出厂默认（100% 保留本机对话、工作区文件、登录账号与网盘历史）。'),
              ),
              confirmMaintAction === 'reset'
                ? h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: function () { setConfirmMaintAction(null); },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm dss-btn-danger',
                      disabled: writeDisabled,
                      onClick: handleResetLocalConfig,
                    }, '确认重置本机配置'),
                  )
                : h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-sm dss-btn-danger',
                    disabled: writeDisabled,
                    onClick: function () { setConfirmMaintAction('reset'); },
                  }, '重置本机同步设置'),
            ),

            // Action 3: One-click full plugin uninstall
            h(
              'div',
              { className: 'dss-maint-row' },
              h(
                'div',
                { style: { flex: 1, minWidth: '200px' } },
                h('strong', null, '🗑️ 一键彻底卸载插件'),
                h('div', { className: 'dss-hint-tight' }, '移除桌面端/网页端插件挂载、接力技能、跨机规则块与本机同步配置（100% 保留本机对话、工作区文件、登录账号与插件源文件夹）；卸载后重启一次软件即完成。'),
              ),
              confirmMaintAction === 'uninstall'
                ? h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm',
                      disabled: writeDisabled,
                      onClick: function () { setConfirmMaintAction(null); },
                    }, '取消'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-sm dss-btn-danger',
                      disabled: writeDisabled,
                      onClick: handleUninstallPlugin,
                    }, '确认彻底卸载插件'),
                  )
                : h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-sm dss-btn-danger',
                    disabled: writeDisabled,
                    onClick: function () { setConfirmMaintAction('uninstall'); },
                  }, '一键彻底卸载插件'),
            ),
          ),
        ),
      );
    }

    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      ctx.effect(ensureStyles, 'dsh-soul-sync: styles');
      ctx.slots.inject('settings.section.icon', function () {
        return ctx.slots.register(
          {
            name: 'settings.section.icon',
            id: 'soul-sync',
          },
          SoulSyncIcon,
        );
      });
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'soul-sync',
            order: 16,
            label: function () { return 'Soul Sync 跨机迁移'; },
          },
          SoulSyncMigrationPanel,
        );
      });
    };

    return module.exports;
  },
});

/* global window, document, fetch */
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

    var STYLE_ID = 'dsh-soul-sync-settings-style';
    var CSS_TEXT = [
      '.dss-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.5;}',
      '.dss-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));}',
      '.dss-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#1f2329);}',
      '.dss-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin:2px 0 0;}',
      '.dss-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.dss-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s;}',
      '.dss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}',
      '.dss-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.dss-btn-primary{background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.dss-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8);}',
      '.dss-btn-danger{color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.dss-banner{padding:9px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));}',
      '.dss-banner-ok{border-color:var(--dsw-alias-state-success-primary,#16a34a);background:var(--dsw-alias-state-success-tertiary,rgba(22,163,74,.1));}',
      '.dss-banner-err{border-color:var(--dsw-alias-state-error-primary,#dc2626);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.1));}',
      '.dss-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04));}',
      '.dss-card-title{font-size:13px;font-weight:600;margin:0 0 8px;display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.dss-radio-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;}',
      '.dss-radio-card{text-align:left;padding:10px 12px;border-radius:9px;border:1.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-bg-base,transparent);color:inherit;cursor:pointer;transition:border-color .15s,background .15s;}',
      '.dss-radio-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}',
      '.dss-radio-card.active{border-color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-bg-layer-2,rgba(37,99,235,.08));}',
      '.dss-radio-head{font-weight:600;font-size:13px;margin-bottom:4px;}',
      '.dss-radio-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.dss-map-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}',
      '.dss-map-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:12px;}',
      '.dss-map-paths{overflow:hidden;text-overflow:ellipsis;word-break:break-all;}',
      '.dss-form-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;}',
      '@media (max-width:680px){.dss-form-grid{grid-template-columns:1fr;}}',
      '.dss-field{display:flex;flex-direction:column;gap:4px;}',
      '.dss-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.dss-input,.dss-select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12px;}',
      '.dss-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));margin-bottom:10px;}',
      '.dss-tab{padding:7px 12px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;font-weight:500;cursor:pointer;}',
      '.dss-tab.active{color:var(--dsw-alias-brand-primary,#2563eb);border-bottom-color:var(--dsw-alias-brand-primary,#2563eb);}',
      '.dss-ws-group{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:8px;margin-bottom:8px;overflow:hidden;background:var(--dsw-alias-bg-base,transparent);}',
      '.dss-ws-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));}',
      '.dss-ws-left{display:flex;align-items:center;gap:8px;min-width:0;flex:1;}',
      '.dss-ws-name{font-weight:600;font-size:12.5px;}',
      '.dss-ws-path{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;}',
      '.dss-sess-list{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12));}',
      '.dss-sess-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 6px 26px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.08));font-size:12px;}',
      '.dss-sess-row:first-child{border-top:none;}',
      '.dss-sess-left{display:flex;align-items:center;gap:8px;min-width:0;flex:1;}',
      '.dss-sess-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dss-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);white-space:nowrap;}',
      '.dss-badge{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10.5px;font-weight:500;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));}',
      '.dss-badge-new{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a);}',
      '.dss-badge-behind{color:var(--dsw-alias-state-warn-primary,#d97706);border-color:var(--dsw-alias-state-warn-primary,#d97706);}',
      '.dss-badge-diverged{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);}',
      '.dss-footer-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;margin-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));}',
      '.dss-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;}',
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

    function resolveApiBase() {
      var transport = globalThis.__DSH_TRANSPORT__;
      if (transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl) {
        try {
          return new URL(transport.streamBaseUrl).origin;
        } catch (_e) {
          // fallback to same-origin relative path
        }
      }
      return '';
    }

    function apiFetch(path, options) {
      var opts = options || {};
      var headers = Object.assign(
        { 'x-dsh-soul-sync': '1' },
        opts.body ? { 'content-type': 'application/json' } : {},
        opts.headers || {},
      );
      return fetch(resolveApiBase() + '/__soul-sync/api' + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }).then(function (resp) {
        return resp.json().then(function (data) {
          if (!resp.ok || data.ok === false) {
            throw new Error(data.error || ('HTTP ' + resp.status));
          }
          return data;
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

      var _tab = useState('push');
      var activeTab = _tab[0];
      var setActiveTab = _tab[1];

      var _expanded = useState({});
      var expanded = _expanded[0];
      var setExpanded = _expanded[1];

      // New mapping form state
      var _winPath = useState('');
      var winPath = _winPath[0];
      var setWinPath = _winPath[1];

      var _macPath = useState('');
      var macPath = _macPath[0];
      var setMacPath = _macPath[1];

      // Push selection state
      var _pushWs = useState({});
      var pushWs = _pushWs[0];
      var setPushWs = _pushWs[1];

      var _pushSess = useState({});
      var pushSess = _pushSess[0];
      var setPushSess = _pushSess[1];

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

      var _savePullMap = useState(false);
      var savePullMap = _savePullMap[0];
      var setSavePullMap = _savePullMap[1];

      var loadState = useCallback(function (silent) {
        if (!silent) setLoading(true);
        return apiFetch('/state')
          .then(function (res) {
            setData(res);
            setLoading(false);
          })
          .catch(function (err) {
            setLoading(false);
            setNotice({ ok: false, text: '加载 Soul Sync 状态失败：' + (err && err.message ? err.message : String(err)) });
          });
      }, []);

      useEffect(function () {
        loadState(false);
      }, [loadState]);

      var runAction = function (fn, okMsgFn) {
        setBusy(true);
        setNotice(null);
        return Promise.resolve()
          .then(fn)
          .then(function (res) {
            var msg = typeof okMsgFn === 'function' ? okMsgFn(res) : (okMsgFn || '操作完成');
            setNotice({ ok: true, text: msg });
            return loadState(true);
          })
          .catch(function (err) {
            setNotice({ ok: false, text: '操作失败：' + (err && err.message ? err.message : String(err)) });
          })
          .finally(function () {
            setBusy(false);
          });
      };

      var cfg = (data && data.config) || {};
      var platform = (data && data.platform) || 'win32';
      var localWorkspaces = (data && data.localCatalog && data.localCatalog.workspaces) || [];
      var vaultWorkspaces = (data && data.vaultCatalog && data.vaultCatalog.workspaces) || [];
      var mappings = cfg.workspaceMappings || [];

      var toggleExpanded = function (key) {
        setExpanded(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = !prev[key];
          return next;
        });
      };

      var togglePushWorkspace = function (ws) {
        var checked = !pushWs[ws.path];
        setPushWs(function (prev) {
          var next = Object.assign({}, prev);
          if (checked) next[ws.path] = true; else delete next[ws.path];
          return next;
        });
        setPushSess(function (prev) {
          var next = Object.assign({}, prev);
          (ws.sessions || []).forEach(function (s) {
            if (checked) next[s.sessionId] = true; else delete next[s.sessionId];
          });
          return next;
        });
      };

      var togglePushSession = function (sid) {
        setPushSess(function (prev) {
          var next = Object.assign({}, prev);
          if (next[sid]) delete next[sid]; else next[sid] = true;
          return next;
        });
      };

      var togglePullWorkspace = function (ws) {
        var checked = !pullWs[ws.sourceCwd];
        setPullWs(function (prev) {
          var next = Object.assign({}, prev);
          if (checked) next[ws.sourceCwd] = true; else delete next[ws.sourceCwd];
          return next;
        });
        setPullSess(function (prev) {
          var next = Object.assign({}, prev);
          (ws.sessions || []).forEach(function (s) {
            if (checked) next[s.sessionId] = true; else delete next[s.sessionId];
          });
          return next;
        });
      };

      var togglePullSession = function (sid) {
        setPullSess(function (prev) {
          var next = Object.assign({}, prev);
          if (next[sid]) delete next[sid]; else next[sid] = true;
          return next;
        });
      };

      var handleAddMappingClick = function () {
        if (!winPath.trim() || !macPath.trim()) {
          setNotice({ ok: false, text: '请同时填写或选择 Windows 路径与 macOS 路径。' });
          return;
        }
        runAction(
          function () {
            return apiFetch('/mappings', {
              method: 'POST',
              body: { winPath: winPath.trim(), macPath: macPath.trim() },
            });
          },
          function () {
            setWinPath('');
            setMacPath('');
            return '已绑定跨系统文件夹一一对应关系并立即生效。';
          },
        );
      };

      var handlePushSelectedClick = function (rememberSelection) {
        var wsList = Object.keys(pushWs).filter(function (k) { return pushWs[k]; });
        var sidList = Object.keys(pushSess).filter(function (k) { return pushSess[k]; });
        if (wsList.length === 0 && sidList.length === 0) {
          setNotice({ ok: false, text: '请先勾选至少一个本机工作区或对话。' });
          return;
        }
        if (rememberSelection) {
          runAction(
            function () {
              return apiFetch('/settings', {
                method: 'POST',
                body: {
                  syncScope: 'selected',
                  selectedWorkspaces: wsList,
                  selectedSessionIds: sidList,
                },
              });
            },
            function () {
              return '已将选中项设为日常持续同步范围（精选白名单模式已启用）。';
            },
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
            return '加密上传完成：共推送 ' + (res.sessionPushedCount || 0) + ' 条对话闭包。';
          },
        );
      };

      var handlePullSelectedClick = function () {
        var wsList = Object.keys(pullWs).filter(function (k) { return pullWs[k]; });
        var sidList = Object.keys(pullSess).filter(function (k) { return pullSess[k]; });
        if (wsList.length === 0 && sidList.length === 0) {
          setNotice({ ok: false, text: '请先勾选至少一个金库工作区或对话。' });
          return;
        }
        var cleanOverrides = {};
        Object.keys(pullTargets).forEach(function (k) {
          if (pullTargets[k] && pullTargets[k].trim()) {
            cleanOverrides[k] = pullTargets[k].trim();
          }
        });
        runAction(
          function () {
            return apiFetch('/pull-selected', {
              method: 'POST',
              body: {
                workspaceSources: wsList,
                sessionIds: sidList,
                targetOverrides: cleanOverrides,
                saveMappings: savePullMap,
              },
            });
          },
          function (res) {
            var s = (res.sessions && res.sessions.summary) || {};
            return '按需拉取完成：新增 ' + (s.imported || 0) + ' / 快进 ' + (s.fastForwarded || 0) + ' / 分叉 ' + (s.forkedBranches || 0) + '（已置顶至左侧边栏）。';
          },
        );
      };

      var localPathOptions = localWorkspaces.filter(function (w) { return Boolean(w.path); });
      var remotePathOptions = vaultWorkspaces.filter(function (w) { return Boolean(w.sourceCwd); });

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
            null,
            h('h2', { className: 'dss-title' }, 'Soul Sync 跨机迁移与目录对应'),
            h(
              'p',
              { className: 'dss-sub' },
              data && data.hasVault
                ? ('金库：' + cfg.vaultDir + ' · ' + (data.encrypted ? 'AES-256-GCM 端到端加密' : '明文模式') + ' · 本机：' + (cfg.deviceLabel || platform))
                : '尚未配置金库目录，请先在「设置 → 插件 → Soul Sync」填写 vaultDir。',
            ),
          ),
          h(
            'div',
            { className: 'dss-actions' },
            h('button', {
              type: 'button',
              className: 'dss-btn',
              disabled: busy,
              onClick: function () { loadState(false); },
            }, '刷新清单'),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-primary',
              disabled: busy || !(data && data.hasVault),
              onClick: function () {
                runAction(
                  function () { return apiFetch('/sync', { method: 'POST', body: {} }); },
                  function () { return '双向同步已完成，左侧边栏已更新。'; },
                );
              },
            }, '立即双向同步'),
          ),
        ),

        // Feedback notice
        notice && h(
          'div',
          { className: 'dss-banner ' + (notice.ok ? 'dss-banner-ok' : 'dss-banner-err') },
          notice.text,
        ),

        // Section 1: Mode & Scope radio cards
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
                disabled: busy,
                className: 'dss-radio-card' + (cfg.folderMatchMode !== 'mapped-only' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { folderMatchMode: 'auto-mirror' } }); },
                    '已切换为「自动同名生成并对应」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '✨ 自动同名生成并对应（省心推荐）'),
              h('div', { className: 'dss-radio-desc' }, '已配对目录按一一对应走；未配对目录自动匹配同名工作区，或在 ~/Documents/deepseek-harness/workspaces/<项目名> 自动创建独立同名工作区，绝不混入同一个默认目录。'),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                className: 'dss-radio-card' + (cfg.folderMatchMode === 'mapped-only' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { folderMatchMode: 'mapped-only' } }); },
                    '已切换为「严格仅同步手动一一对应文件夹」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🔗 仅同步手动一一对应的文件夹'),
              h('div', { className: 'dss-radio-desc' }, '严格只同步下方映射表里配好对的工作区（或按需拉取时显式指定目标目录的项目），未配对工作区自动跳过、绝不自动新建目录。'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'dss-card' },
          h('div', { className: 'dss-card-title' }, '2. 日常自动同步范围'),
          h(
            'div',
            { className: 'dss-radio-grid' },
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                className: 'dss-radio-card' + (cfg.syncScope !== 'selected' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { syncScope: 'active' } }); },
                    '已切换为「自动同步活跃对话（过滤空窗口）」模式。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🟢 自动同步活跃对话（自动过滤空窗口）'),
              h('div', { className: 'dss-radio-desc' }, '自动剔除 0 轮发言空壳窗口，单工作区默认按最近活跃同步前 ' + ((cfg.quotas && cfg.quotas.maxAutoSessionsPerWorkspace) || 25) + ' 条对话。'),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                className: 'dss-radio-card' + (cfg.syncScope === 'selected' ? ' active' : ''),
                onClick: function () {
                  runAction(
                    function () { return apiFetch('/settings', { method: 'POST', body: { syncScope: 'selected' } }); },
                    '已切换为「仅同步我勾选的工作区与对话（精选模式）」。',
                  );
                },
              },
              h('div', { className: 'dss-radio-head' }, '🎯 仅同步我勾选的工作区与对话（精选模式）'),
              h('div', { className: 'dss-radio-desc' }, '仅同步白名单中的 ' + ((cfg.selectedWorkspaces || []).length) + ' 个工作区与 ' + ((cfg.selectedSessionIds || []).length) + ' 条对话，未勾选项 100% 留在单机本地。'),
            ),
          ),
        ),

        // Section 2: Workspace mappings management
        h(
          'div',
          { className: 'dss-card' },
          h(
            'div',
            { className: 'dss-card-title' },
            h('span', null, '📂 文件夹一一对应管理（Windows ⇄ macOS）'),
            h('span', { className: 'dss-meta' }, '已绑定 ' + mappings.length + ' 组'),
          ),
          mappings.length === 0
            ? h('div', { className: 'dss-empty' }, '尚未手动绑定文件夹一一对应（自动同名模式下可选配；严格一一对应模式下请在此绑定）。')
            : h(
                'div',
                { className: 'dss-map-list' },
                mappings.map(function (m) {
                  return h(
                    'div',
                    { key: m.id, className: 'dss-map-row' },
                    h(
                      'div',
                      { className: 'dss-map-paths' },
                      h('strong', null, '[' + m.id + '] '),
                      'Win: ', m.win32 || '(未设)', '  ⇄  Mac: ', m.darwin || '(未设)',
                    ),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-danger',
                      disabled: busy,
                      onClick: function () {
                        runAction(
                          function () { return apiFetch('/mappings/delete', { method: 'POST', body: { id: m.id } }); },
                          '已解除工作区映射 [' + m.id + ']。',
                        );
                      },
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
                h('option', { value: '' }, '从检测到的工作区快选…'),
                (platform === 'win32' ? localPathOptions : remotePathOptions).map(function (w) {
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
                h('option', { value: '' }, '从检测到的工作区快选…'),
                (platform === 'darwin' ? localPathOptions : remotePathOptions).map(function (w) {
                  var p = platform === 'darwin' ? w.path : w.sourceCwd;
                  var t = platform === 'darwin' ? w.title : w.sourceTitle;
                  return h('option', { key: 'm-' + p, value: p }, t + ' (' + p + ')');
                }),
              ),
            ),
            h('button', {
              type: 'button',
              className: 'dss-btn dss-btn-primary',
              disabled: busy,
              onClick: handleAddMappingClick,
            }, '+ 绑定对应'),
          ),
        ),

        // Section 3: Selective Migration Workbench
        h(
          'div',
          { className: 'dss-card' },
          h('div', { className: 'dss-card-title' }, '🚀 选择性迁移工作台（按需勾选工作区或单条对话）'),
          h(
            'div',
            { className: 'dss-tabs' },
            h('button', {
              type: 'button',
              className: 'dss-tab' + (activeTab === 'push' ? ' active' : ''),
              onClick: function () { setActiveTab('push'); },
            }, '📤 勾选推送到金库（本机 ' + ((data && data.localCatalog && data.localCatalog.totalSessions) || 0) + ' 条）'),
            h('button', {
              type: 'button',
              className: 'dss-tab' + (activeTab === 'pull' ? ' active' : ''),
              onClick: function () { setActiveTab('pull'); },
            }, '📥 从金库勾选拉取到本机（远端 ' + ((data && data.vaultCatalog && data.vaultCatalog.totalSessions) || 0) + ' 条）'),
          ),

          activeTab === 'push'
            ? h(
                'div',
                null,
                localWorkspaces.length === 0
                  ? h('div', { className: 'dss-empty' }, '本机暂无非空有效对话。')
                  : localWorkspaces.map(function (ws) {
                      var key = 'local:' + ws.workspaceKey;
                      var isOpen = expanded[key] !== false;
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
                              checked: Boolean(pushWs[ws.path]),
                              onChange: function () { togglePushWorkspace(ws); },
                            }),
                            h('span', { className: 'dss-ws-name' }, ws.title),
                            h('span', { className: 'dss-ws-path', title: ws.path }, ws.path || '(无目录)'),
                          ),
                          h(
                            'div',
                            { className: 'dss-actions' },
                            h('span', { className: 'dss-meta' }, ws.sessionCount + ' 条对话 · ' + ws.deliverableCount + ' 产出'),
                            h('button', {
                              type: 'button',
                              className: 'dss-btn',
                              onClick: function () { toggleExpanded(key); },
                            }, isOpen ? '收起' : '展开'),
                          ),
                        ),
                        isOpen && (ws.sessions || []).length > 0 && h(
                          'div',
                          { className: 'dss-sess-list' },
                          ws.sessions.map(function (s) {
                            return h(
                              'label',
                              { key: s.sessionId, className: 'dss-sess-row' },
                              h(
                                'span',
                                { className: 'dss-sess-left' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: Boolean(pushSess[s.sessionId]),
                                  onChange: function () { togglePushSession(s.sessionId); },
                                }),
                                h('span', { className: 'dss-sess-title', title: s.title }, s.title),
                              ),
                              h('span', { className: 'dss-meta' }, s.turnCount + ' 轮 · ' + formatTime(s.lastActiveAt)),
                            );
                          }),
                        ),
                      );
                    }),
                h(
                  'div',
                  { className: 'dss-footer-bar' },
                  h(
                    'span',
                    { className: 'dss-meta' },
                    '已自动过滤 ' + ((data && data.localCatalog && data.localCatalog.filteredEmptyCount) || 0) + ' 个 0 轮空壳窗口',
                  ),
                  h(
                    'div',
                    { className: 'dss-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dss-btn',
                      disabled: busy,
                      onClick: function () { handlePushSelectedClick(true); },
                    }, '设为日常持续同步范围'),
                    h('button', {
                      type: 'button',
                      className: 'dss-btn dss-btn-primary',
                      disabled: busy || !(data && data.hasVault),
                      onClick: function () { handlePushSelectedClick(false); },
                    }, '立即加密上传选中项'),
                  ),
                ),
              )
            : h(
                'div',
                null,
                vaultWorkspaces.length === 0
                  ? h('div', { className: 'dss-empty' }, '金库中暂无来自其他设备的可拉取工作区或对话。')
                  : vaultWorkspaces.map(function (ws) {
                      var key = 'vault:' + ws.sourceKey;
                      var isOpen = expanded[key] !== false;
                      var currentOverride = pullTargets[ws.sourceCwd] || '';
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
                              checked: Boolean(pullWs[ws.sourceCwd]),
                              onChange: function () { togglePullWorkspace(ws); },
                            }),
                            h('span', { className: 'dss-ws-name' }, ws.sourceTitle),
                            h('span', { className: 'dss-meta' }, '来自 ' + ws.fromDeviceLabel),
                          ),
                          h(
                            'div',
                            { className: 'dss-actions' },
                            h(
                              'select',
                              {
                                className: 'dss-select',
                                style: { maxWidth: '240px' },
                                value: currentOverride,
                                onChange: function (e) {
                                  var val = e.target.value;
                                  setPullTargets(function (prev) {
                                    var next = Object.assign({}, prev);
                                    if (val) next[ws.sourceCwd] = val; else delete next[ws.sourceCwd];
                                    return next;
                                  });
                                },
                              },
                              h(
                                'option',
                                { value: '' },
                                ws.targetPreviewPath
                                  ? ('预计落入：' + ws.targetPreviewPath)
                                  : '未对应（默认跳过，可在此指定目录）',
                              ),
                              localPathOptions.map(function (lw) {
                                return h('option', { key: 'dst-' + lw.path, value: lw.path }, '改落入：' + lw.title + ' (' + lw.path + ')');
                              }),
                            ),
                            h('button', {
                              type: 'button',
                              className: 'dss-btn',
                              onClick: function () { toggleExpanded(key); },
                            }, isOpen ? '收起' : '展开'),
                          ),
                        ),
                        isOpen && (ws.sessions || []).length > 0 && h(
                          'div',
                          { className: 'dss-sess-list' },
                          ws.sessions.map(function (s) {
                            return h(
                              'label',
                              { key: s.sessionId, className: 'dss-sess-row' },
                              h(
                                'span',
                                { className: 'dss-sess-left' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: Boolean(pullSess[s.sessionId]),
                                  onChange: function () { togglePullSession(s.sessionId); },
                                }),
                                h('span', { className: 'dss-sess-title', title: s.title }, s.title),
                                statusBadge(s.localStatus),
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
                    { className: 'dss-meta', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox',
                      checked: savePullMap,
                      onChange: function (e) { setSavePullMap(e.target.checked); },
                    }),
                    '将本次指定的目标目录保存为永久一一对应',
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dss-btn dss-btn-primary',
                    disabled: busy || !(data && data.hasVault),
                    onClick: handlePullSelectedClick,
                  }, '立即拉取选中项到侧边栏'),
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

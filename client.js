window.__ModuleLoader__.load({
  id: 'dsh-workspace-files-tree',
  factory(require) {
    // The Web GUI's shared module table seeds React; nothing else is imported.
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Client locale namespace registered by this plugin. */
    const NS = 'workspaceTree';
    /** localStorage key remembering whether the panel is open. */
    const OPEN_KEY = 'dsh.workspace-tree.open';
    /** Hard caps that keep an enormous workspace from freezing the page. */
    const MAX_DEPTH = 12;
    const MAX_NODES = 4000;
    /** Parallel directory-listing RPCs per batch. */
    const LIST_BATCH = 6;

    const en = {
      'title': 'Workspace files',
      'button.show': 'Show workspace files',
      'button.hide': 'Hide workspace files',
      'refresh': 'Reload the workspace tree',
      'close': 'Close',
      'loading': 'Reading the workspace…',
      'empty': 'This folder is empty.',
      'partial': 'Some folder listings were truncated by the host entry cap.',
      'capped': 'Showing the first {count} entries only.',
      'retry': 'Retry',
      'error': 'Could not read the workspace',
      'noSession': 'Open a session to browse its workspace files.',
      'noWorkspace': 'This session does not name a workspace folder yet.',
      'folders': 'folders',
      'files': 'files',
      'others': 'other entries',
      'root': 'Workspace root',
      'collapse': 'Collapse folder',
      'expand': 'Expand folder',
      'openFile': 'Double-click to open this file in the viewer.',
      'openFailed': 'The viewer could not be opened for this file.',
      'emptyShort': 'empty'
    };

    const zh = {
      'title': '工作区文件树',
      'button.show': '显示工作区文件树',
      'button.hide': '隐藏工作区文件树',
      'refresh': '重新读取工作区文件树',
      'close': '关闭',
      'loading': '正在读取工作区…',
      'empty': '此文件夹为空。',
      'partial': '部分目录条目过多，宿主已截断。',
      'capped': '仅显示前 {count} 项。',
      'retry': '重试',
      'error': '无法读取工作区',
      'noSession': '打开一个会话后即可浏览它的工作区文件。',
      'noWorkspace': '当前会话还没有指定工作区目录。',
      'folders': '个文件夹',
      'files': '个文件',
      'others': '个其他条目',
      'root': '工作区根目录',
      'collapse': '折叠文件夹',
      'expand': '展开文件夹',
      'openFile': '双击在查看器中打开此文件',
      'openFailed': '无法为该文件打开查看器。',
      'emptyShort': '空'
    };

    /** Join a parent absolute path and one entry name with `/`. */
    function joinPath(parent, name) {
      const base = String(parent).replace(/[/\\]+$/, '');
      return `${base}/${name}`;
    }

    // -- dsh-resource://file address helpers ------------------------------------
    // Copied in miniature from @deepseek-ai/dsh-util-workspace-path (browser-safe
    // pure functions) so this bundle stays self-contained. A viewer tab claims a
    // `dsh-resource://file/session/<sessionId>/<path>` address; paths inside the
    // Session workspace are carried relative to its root.
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

    /** Component-encode one id or path segment, keeping `:` literal for drive letters. */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':');
    }

    /** Encode a `/`-separated path segment by segment. */
    function encodePath(path) {
      return path.split('/').map(encodeSegment).join('/');
    }

    /** Whether a path is absolute in either spelling the Host accepts (POSIX or Windows). */
    function isAbsoluteWorkspacePath(path) {
      return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
    }

    /** The `dsh-resource://file/session/<id>/<path>` address of a file read in one Session. */
    function sessionFileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
    }

    /**
     * The file address for a path as this tree holds it: an absolute path inside
     * the Session workspace becomes relative to its root; any other path stays
     * absolute inside that same Session address. Mirrors `fileAddressFor` from
     * @deepseek-ai/dsh-util-workspace-path.
     */
    function fileAddressFor(sessionId, cwd, path) {
      const normalized = String(path).replace(/\\/g, '/');
      if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
      const root = cwd === undefined ? '' : String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
      if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '');
      if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      return sessionFileAddress(sessionId, normalized);
    }

    /** Directories first, then natural, case-insensitive name order. */
    function compareEntries(left, right) {
      const leftDir = left !== null && typeof left === 'object' && left.type === 'directory';
      const rightDir = right !== null && typeof right === 'object' && right.type === 'directory';
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      const leftName = left !== null && typeof left === 'object' ? String(left.name ?? '') : '';
      const rightName = right !== null && typeof right === 'object' ? String(right.name ?? '') : '';
      return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: 'base' });
    }

    /** Read one session row's cwd out of the Session catalog snapshot. */
    function workspaceRootOf(sessionsSnapshot, sessionId) {
      if (!sessionsSnapshot || typeof sessionsSnapshot !== 'object' || sessionId === undefined) return undefined;
      const byId = sessionsSnapshot.byId;
      if (byId === null || typeof byId !== 'object') return undefined;
      const row = byId[sessionId];
      if (row === null || typeof row !== 'object') return undefined;
      return typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined;
    }

    /** Observable-source subscription that survives stores without bound methods. */
    function useSnapshot(store) {
      const snap = useCallback(() => (store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined), [store]);
      const [value, setValue] = useState(snap);
      useEffect(() => {
        if (!store || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined;
        let alive = true;
        const publish = () => {
          if (alive) setValue(store.getSnapshot());
        };
        publish();
        const dispose = store.subscribe(publish);
        return () => {
          alive = false;
          if (typeof dispose === 'function') dispose();
        };
      }, [store]);
      return value;
    }

    /** One directory listing through the generated workspaceFiles Remote namespace. */
    async function readDirectory(remote, sessionId, path, signal) {
      const result = await remote.workspaceFiles.list(sessionId, path, signal);
      if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
      const rpcError = result !== null && typeof result === 'object' && result.error !== null && typeof result.error === 'object' ? result.error : undefined;
      const failure = new Error(rpcError && typeof rpcError.message === 'string' ? rpcError.message : 'workspace listing failed');
      failure.code = rpcError && typeof rpcError.code === 'string' ? rpcError.code : 'gateway/internal';
      throw failure;
    }

    /** True while the effect owns the read; aborted reads never publish. */
    function aborted(signal) {
      return signal !== null && typeof signal === 'object' && signal.aborted === true;
    }

    /**
     * Walk the whole workspace recursively and return a renderable node tree.
     * Directories are listed in bounded parallel batches; the caps report
     * themselves through `counters` instead of failing the read.
     */
    async function buildTree(remote, sessionId, root, signal, onProgress) {
      const counters = { folders: 0, files: 0, others: 0, truncated: 0, capped: false };
      let budget = MAX_NODES;
      let lastReport = 0;

      const report = () => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        if (now - lastReport < 200) return;
        lastReport = now;
        onProgress({ ...counters });
      };

      const walk = async (path, depth) => {
        if (aborted(signal)) throw Object.assign(new Error('aborted'), { code: 'gateway/cancelled' });
        const listing = await readDirectory(remote, sessionId, path, signal);
        if (listing !== null && typeof listing === 'object' && listing.truncated === true) counters.truncated += 1;
        const rawEntries = listing !== null && typeof listing === 'object' && Array.isArray(listing.entries) ? listing.entries.slice() : [];
        rawEntries.sort(compareEntries);
        const nodes = [];
        const directories = [];
        for (const entry of rawEntries) {
          if (budget <= 0) {
            counters.capped = true;
            break;
          }
          if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.length === 0) continue;
          budget -= 1;
          const type = entry.type === 'directory' || entry.type === 'file' ? entry.type : 'other';
          const node = {
            name: entry.name,
            path: joinPath(path, entry.name),
            type,
            children: type === 'directory' ? [] : undefined,
            deep: false
          };
          nodes.push(node);
          if (type === 'directory') {
            counters.folders += 1;
            if (depth < MAX_DEPTH) directories.push(node);
            else node.deep = true;
          } else if (type === 'file') counters.files += 1;
          else counters.others += 1;
        }
        report();
        for (let index = 0; index < directories.length; index += LIST_BATCH) {
          const batch = directories.slice(index, index + LIST_BATCH);
          await Promise.all(batch.map(async (node) => {
            node.children = await walk(node.path, depth + 1);
          }));
          report();
        }
        return nodes;
      };

      const children = await walk(root, 0);
      return { children, counters };
    }

    /** Chevron that rotates when its folder is open. */
    function Chevron({ expanded }) {
      return h(
        'svg',
        {
          viewBox: '0 0 12 12',
          width: 10,
          height: 10,
          'aria-hidden': true,
          className: 'dsh-wt-chevron',
          style: {
            flex: '0 0 auto',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
            opacity: 0.72
          }
        },
        h('path', { d: 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    /** Small original folder glyph. */
    function FolderIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: '0 0 auto', color: 'var(--dsw-alias-brand-primary, #4d6bfe)' } },
        h('path', {
          d: 'M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.3l1.4 1.5h5.9c.7 0 1.2.6 1.2 1.2v6.1c0 .7-.6 1.2-1.2 1.2H2.7c-.7 0-1.2-.6-1.2-1.2z',
          fill: 'currentColor',
          opacity: 0.9
        })
      );
    }

    /** Small original document glyph. */
    function FileIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, #8a8f99)' } },
        h('path', {
          d: 'M4 1.8h5l3.2 3.2v9.2H4z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        }),
        h('path', { d: 'M9 1.9V5h3.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' })
      );
    }

    /** Small folder glyph for the collapsed launcher button. */
    function FolderButtonIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true },
        h('path', {
          d: 'M3 6.4c0-1 .8-1.8 1.8-1.8h4.6l2.1 2.3h7.7c1 0 1.8.8 1.8 1.8v8.9c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8z',
          fill: 'currentColor',
          opacity: 0.95
        }),
        h('path', { d: 'M3.4 8.7h17.2', stroke: 'var(--dsw-alias-label-primary-inverted, #fff)', strokeWidth: 1.2, opacity: 0.55 })
      );
    }

    /** Reload icon. */
    function RefreshIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
        h('path', { d: 'M13.3 2.6v3.1H10.2' })
      );
    }

    /** Close icon. */
    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' })
      );
    }

    /** One directory level: rows plus their expanded children. */
    function TreeLevel({ nodes, depth, collapsed, onToggle, onOpenFile, t }) {
      return h(
        'ul',
        { role: 'group', style: { listStyle: 'none', margin: 0, padding: 0 } },
        nodes.map((node) => {
          const directory = node.type === 'directory';
          const file = node.type === 'file';
          const expanded = directory && !collapsed.has(node.path);
          const emptyExpanded = expanded && (!Array.isArray(node.children) || node.children.length === 0);
          const rowClass = `dsh-wt-row${directory ? ' dsh-wt-row--dir' : ''}${file ? ' dsh-wt-row--file' : ''}`;
          return h(
            'li',
            { key: node.path, role: 'none' },
            h(
              'div',
              {
                role: 'treeitem',
                'aria-level': depth + 1,
                'aria-expanded': directory ? expanded : undefined,
                title: file ? `${node.path} · ${t('openFile')}` : node.path,
                className: rowClass,
                tabIndex: directory || file ? 0 : undefined,
                onClick: directory ? () => onToggle(node.path) : undefined,
                onDoubleClick: file ? () => onOpenFile(node.path) : undefined,
                onKeyDown: directory || file
                  ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (directory) onToggle(node.path);
                      else onOpenFile(node.path);
                    }
                  : undefined,
                style: { paddingLeft: `${8 + depth * 14}px` }
              },
              directory ? h(Chevron, { expanded }) : h('span', { style: { flex: '0 0 auto', width: 10 } }),
              directory ? h(FolderIcon) : file ? h(FileIcon) : h('span', { 'aria-hidden': true, style: { width: 14 } }),
              h('span', { className: 'dsh-wt-name' }, node.name),
              node.type === 'other' ? h('span', { className: 'dsh-wt-badge' }, '·') : null,
              node.deep ? h('span', { className: 'dsh-wt-badge', title: t('capped', { count: MAX_DEPTH }) }, '…') : null
            ),
            expanded && Array.isArray(node.children) && node.children.length > 0
              ? h(TreeLevel, { nodes: node.children, depth: depth + 1, collapsed, onToggle, onOpenFile, t })
              : null,
            emptyExpanded ? h('div', { className: 'dsh-wt-empty', style: { paddingLeft: `${30 + depth * 14}px` } }, t('empty')) : null
          );
        })
      );
    }

    /** Coarse statistics line content. */
    function statsText(t, counters) {
      if (counters === null || typeof counters !== 'object') return '';
      const parts = [];
      if (counters.folders > 0) parts.push(`${counters.folders} ${t('folders')}`);
      if (counters.files > 0) parts.push(`${counters.files} ${t('files')}`);
      if (counters.others > 0) parts.push(`${counters.others} ${t('others')}`);
      return parts.join(' · ');
    }

    /** Panel body for one load state. */
    function TreeBody({ state, collapsed, onToggle, onOpenFile, onRetry, t }) {
      if (state.status === 'loading' && !Array.isArray(state.nodes)) {
        return h(
          'div',
          { className: 'dsh-wt-state' },
          h('span', { className: 'dsh-wt-spinner', 'aria-hidden': true }),
          h('span', null, t('loading')),
          state.counters && (state.counters.folders > 0 || state.counters.files > 0)
            ? h('span', { className: 'dsh-wt-dim' }, ` (${statsText(t, state.counters)})`)
            : null
        );
      }
      if (state.status === 'error') {
        return h(
          'div',
          { className: 'dsh-wt-state dsh-wt-state--error' },
          h('div', { className: 'dsh-wt-error-title' }, t('error')),
          h('div', { className: 'dsh-wt-dim' }, `${state.error.code}: ${state.error.message}`),
          h('button', { type: 'button', className: 'dsh-wt-button dsh-wt-button--retry', onClick: onRetry }, t('retry'))
        );
      }
      if (state.status === 'unavailable') {
        return h('div', { className: 'dsh-wt-state' }, t(state.reason === 'noWorkspace' ? 'noWorkspace' : 'noSession'));
      }
      if (state.status === 'ready' && Array.isArray(state.nodes)) {
        if (state.nodes.length === 0) return h('div', { className: 'dsh-wt-state' }, t('empty'));
        return h(TreeLevel, { nodes: state.nodes, depth: 0, collapsed, onToggle, onOpenFile, t });
      }
      return h('div', { className: 'dsh-wt-state' }, t('loading'));
    }

    /** Styles rendered as a React element, so unmounting the panel removes them. */
    const STYLE_ID = 'dsh-workspace-files-tree-style';
    function Styles() {
      return h(
        'style',
        { 'data-dsh-workspace-files-tree': STYLE_ID },
        `
.dsh-wt-launcher{position:fixed;right:16px;bottom:16px;z-index:60;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.14));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 6px 20px var(--dsw-alias-bg-mask-drop,rgba(15,23,42,.16));cursor:pointer;padding:0;-webkit-app-region:no-drag}
.dsh-wt-launcher:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-wt-panel{position:fixed;right:16px;bottom:16px;z-index:60;display:flex;flex-direction:column;width:340px;max-width:calc(100vw - 32px);max-height:min(70vh,640px);border-radius:14px;border:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.14));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 14px 40px var(--dsw-alias-bg-mask-drop,rgba(15,23,42,.22));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px;line-height:20px;overflow:hidden;-webkit-app-region:no-drag}
.dsh-wt-head{display:flex;align-items:center;gap:6px;padding:9px 10px 7px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.1));flex:0 0 auto}
.dsh-wt-title{font-weight:600;font-size:12.5px;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-wt-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
.dsh-wt-iconbutton{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b626e);cursor:pointer;padding:0}
.dsh-wt-iconbutton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2329)}
.dsh-wt-root{display:flex;align-items:center;height:30px;padding:0 12px;color:var(--dsw-alias-label-tertiary,#8a8f99);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.07));white-space:nowrap;overflow:hidden;direction:rtl;text-align:left;flex:0 0 auto;min-width:0}
.dsh-wt-root bdi{direction:ltr;unicode-bidi:isolate;display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wt-scroll{flex:1 1 auto;overflow:auto;padding:5px 4px 8px;min-height:48px;overscroll-behavior:contain}
.dsh-wt-row{display:flex;align-items:center;gap:4px;min-height:22px;margin:0 2px;padding:1px 6px;border-radius:7px;white-space:nowrap;overflow:hidden;color:var(--dsw-alias-label-primary,#1f2329);cursor:default;outline:none}
.dsh-wt-row--dir{cursor:pointer}
.dsh-wt-row--file{cursor:pointer}
.dsh-wt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-wt-row:focus-visible{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-wt-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-wt-badge{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8a8f99);padding-left:2px}
.dsh-wt-empty{color:var(--dsw-alias-label-tertiary,#8a8f99);font-style:italic;padding-top:1px;padding-bottom:3px}
.dsh-wt-foot{display:flex;align-items:center;gap:8px;padding:6px 11px 8px;border-top:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.1));color:var(--dsw-alias-label-tertiary,#8a8f99);font-size:11px;flex:0 0 auto}
.dsh-wt-hint{padding:5px 11px 6px;color:var(--dsw-alias-label-secondary,#5b626e);background:var(--dsw-alias-bg-mask-1,rgba(127,127,127,.08));border-top:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.08));font-size:11px;flex:0 0 auto}
.dsh-wt-foot-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-wt-state{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 12px;color:var(--dsw-alias-label-secondary,#5b626e)}
.dsh-wt-state--error{flex-direction:column;align-items:flex-start}
.dsh-wt-error-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dsh-wt-dim{color:var(--dsw-alias-label-tertiary,#8a8f99);word-break:break-all}
.dsh-wt-button{border:1px solid var(--dsw-alias-border-l3,rgba(15,23,42,.16));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;cursor:pointer;padding:2px 10px;margin-top:2px}
.dsh-wt-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-wt-spinner{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dsh-wt-spin .8s linear infinite;flex:0 0 auto}
@keyframes dsh-wt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-wt-spinner{animation:none}.dsh-wt-chevron{transition:none}}
`
      );
    }

    /**
     * The root-scope shell.overlay entry: a floating launcher button that opens
     * a panel with the current session's entire workspace tree.
     */
    function WorkspaceTreeOverlay(props) {
      const { t, remote, sessions, uiWorkspace, sidebarRight } = props;
      const sessionSelection = useSnapshot(uiWorkspace ? uiWorkspace.selection : undefined);
      const sessionsSnapshot = useSnapshot(sessions ? sessions.list : undefined);
      const [openState, setOpenState] = useState(() => {
        try {
          const saved = window.localStorage.getItem(OPEN_KEY);
          return saved === null ? true : saved === '1';
        } catch (_error) {
          return true;
        }
      });
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [reloadToken, setReloadToken] = useState(0);
      const [state, setState] = useState({ status: 'idle' });
      const [openHint, setOpenHint] = useState('');

      const sessionId = sessionSelection && typeof sessionSelection === 'object' && typeof sessionSelection.sessionId === 'string'
        ? sessionSelection.sessionId
        : undefined;
      const root = workspaceRootOf(sessionsSnapshot, sessionId);

      const persistOpen = useCallback((next) => {
        setOpenState(next);
        try {
          window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
        } catch (_error) {
          // A disabled storage backend only loses the preference.
        }
      }, []);

      useEffect(() => {
        if (!openState) return undefined;
        if (sessionId === undefined) {
          setState({ status: 'unavailable', reason: 'noSession' });
          return undefined;
        }
        if (root === undefined) {
          setState({ status: 'unavailable', reason: 'noWorkspace' });
          return undefined;
        }
        const controller = new AbortController();
        let disposed = false;
        setState({ status: 'loading', root });
        buildTree(remote, sessionId, root, controller.signal, (counters) => {
          if (disposed || controller.signal.aborted) return;
          setState({ status: 'loading', root, counters });
        })
          .then((result) => {
            if (disposed || controller.signal.aborted) return;
            setState({ status: 'ready', root, nodes: result.children, counters: result.counters });
          })
          .catch((error) => {
            if (disposed || controller.signal.aborted) return;
            setState({
              status: 'error',
              root,
              error: {
                code: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'gateway/internal',
                message: error instanceof Error ? error.message : String(error)
              }
            });
          });
        return () => {
          disposed = true;
          controller.abort();
        };
      }, [openState, sessionId, root, reloadToken, remote]);

      const toggleFolder = useCallback((path) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }, []);

      const refresh = useCallback(() => {
        setReloadToken((token) => token + 1);
      }, []);

      /**
       * Open one file in the right Sidebar's viewer. `sidebarRight.openResource`
       * claims the `dsh-resource://file/session/...` address through the tab-type
       * registry (the document preview claims every Session file), places the tab
       * in the active docked pane, and expands the column - the same navigation a
       * click in the built-in Files tree performs.
       */
      const openFile = useCallback((path) => {
        setOpenHint('');
        try {
          if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.openResource !== 'function') {
            throw new Error('sidebarRight service is unavailable');
          }
          if (sessionId === undefined || root === undefined) {
            throw new Error('no session workspace is open');
          }
          sidebarRight.openResource(fileAddressFor(sessionId, root, path));
        } catch (error) {
          console.warn('workspace-files-tree: could not open file in the viewer', error);
          setOpenHint(t('openFailed'));
        }
      }, [sidebarRight, sessionId, root, t]);

      useEffect(() => {
        if (openHint === '') return undefined;
        const timer = setTimeout(() => setOpenHint(''), 4000);
        return () => clearTimeout(timer);
      }, [openHint]);

      const counters = state.counters;
      const footNote = state.status === 'ready' && counters
        ? counters.capped
          ? t('capped', { count: MAX_NODES })
          : counters.truncated > 0
            ? t('partial')
            : ''
        : '';

      const content = !openState
        ? h(
            'button',
            {
              type: 'button',
              className: 'dsh-wt-launcher',
              title: t('button.show'),
              'aria-label': t('button.show'),
              'aria-expanded': false,
              onClick: () => persistOpen(true)
            },
            h(FolderButtonIcon)
          )
        : h(
            'section',
            {
              className: 'dsh-wt-panel',
              'aria-label': t('title'),
              role: 'region'
            },
            h(
              'div',
              { className: 'dsh-wt-head' },
              h(FolderIcon),
              h('div', { className: 'dsh-wt-title', title: t('title') }, t('title')),
              h(
                'div',
                { className: 'dsh-wt-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-wt-iconbutton', title: t('refresh'), 'aria-label': t('refresh'), onClick: refresh },
                  h(RefreshIcon)
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-wt-iconbutton',
                    title: t('button.hide'),
                    'aria-label': t('button.hide'),
                    'aria-expanded': true,
                    onClick: () => persistOpen(false)
                  },
                  h(CloseIcon)
                )
              )
            ),
            root
              ? h('div', { className: 'dsh-wt-root', title: `${t('root')}: ${root}` }, h('bdi', null, root))
              : null,
            h(
              'div',
              { className: 'dsh-wt-scroll', role: state.status === 'ready' ? 'tree' : undefined, 'aria-label': state.status === 'ready' ? t('title') : undefined },
              h(TreeBody, { state, collapsed, onToggle: toggleFolder, onOpenFile: openFile, onRetry: refresh, t })
            ),
            openHint ? h('div', { className: 'dsh-wt-hint', role: 'status' }, openHint) : null,
            h(
              'div',
              { className: 'dsh-wt-foot' },
              h('span', { className: 'dsh-wt-foot-text' }, state.status === 'loading' ? t('loading') : statsText(t, counters)),
              footNote ? h('span', { className: 'dsh-wt-foot-text', title: footNote }, footNote) : null
            )
          );

      return h(React.Fragment, null, h(Styles), content);
    }

    /** Required browser services: slots, copy, the Remote face, Session state, and the Sidebar navigation face. */
    const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'sessions', 'uiWorkspace', 'sidebarRight'];

    /** Browser plugin body: dictionaries and the root-scope overlay seat. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-files-tree: dictionaries');
      const overlayProps = () => ({
        remote: ctx.remote,
        sessions: ctx.sessions,
        uiWorkspace: ctx.uiWorkspace,
        sidebarRight: ctx.sidebarRight
      });
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workspace-files-tree',
        order: 40,
        locale: NS,
        inject: overlayProps
      }, WorkspaceTreeOverlay)), 'workspace-files-tree: overlay seat');
    }

    return { inject, apply };
  }
});

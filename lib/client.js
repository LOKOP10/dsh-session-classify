/**
 * dsh-session-classify 的浏览器半侧 —— 侧边栏「会话分类」面板。
 *
 * ## 形态
 *
 * 左栏是文件夹（自建、可重命名/删除/调序）与「回收站」，右栏是会话列表：
 * 勾选或拖拽即可把会话放进文件夹；每行的「⋯」展开后可以重命名、打开、
 * 归档/取消归档、删除（进回收站）或彻底删除。会话列表默认包含**已归档**的
 * 对话，并标出徽章，因此归档后再也找不到的会话在这里仍然可见。
 *
 * ## 数据从哪来
 *
 * 宿主半侧把分类数据、会话列表、归档状态与回收站挂在
 * `/plugins/dsh-session-classify/data`，动作走 `.../action`（POST）。
 * 走同源 HTTP 而不是 Remote：Remote 需要构建期生成的 codec，本插件刻意
 * 不带构建步骤。唯一例外是**会话重命名**：它必须走 DSH 自己的
 * `sessions.retain(...).binding.session.rename()`，才能与打开着的对话保持同步。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-classify',
  factory(require) {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    /** 面板 id：`sidebar.panellist` 的 id 与 `main` 的 key 必须一致。 */
    const PANEL_ID = 'session-classify'

    /** 这些动作会改变会话是否存在，做完要让 DSH 重读会话列表。 */
    const REFRESH_ACTIONS = new Set(['trash', 'purge', 'empty', 'restore', 'prune-ghosts'])

    const DATA_PATH = '/plugins/dsh-session-classify/data'
    const ACTION_PATH = '/plugins/dsh-session-classify/action'

    /** 内置中文文案；locale 服务可用时以它的字典为准。 */
    const ZH = {
      title: '会话分类',
      summary: '共 {total} 个会话 · {archived} 个已归档',
      refresh: '刷新',
      search: '搜索标题 / 工作区 / id',
      allSessions: '全部会话',
      unfiled: '未分类',
      ungrouped: '未归组',
      pruneGhosts: '清理残留 {n}',
      pruneHint: '清理「磁盘上已不存在」的会话在工作区、归档与缓存里的痕迹',
      live: '使用中',
      liveHint: '这个会话仍在 DSH 内存里（打开着 / 刚用过），删除后要切到别的会话或重启 DSH 才会从侧栏消失',
      staleLive: '有 {n} 个已删除的会话仍留在 DSH 内存里（侧栏「未分组」中可见），重启 DSH 后会消失',
      trash: '回收站',
      newFolder: '新建文件夹',
      newFolderHint: '文件夹名，回车创建',
      renameFolder: '重命名文件夹',
      deleteFolder: '删除文件夹',
      deleteFolderConfirm: '确认删文件夹？',
      filterAll: '全部',
      filterActive: '未归档',
      filterArchived: '已归档',
      more: '更多操作',
      moveTo: '移入',
      moveOut: '移出文件夹',
      rename: '重命名',
      renameHint: '新标题，回车保存',
      open: '打开',
      openArchived: '归档会话需先取消归档',
      archive: '归档',
      unarchive: '取消归档',
      forceArchive: '停止并归档',
      delete: '删除',
      deleteConfirm: '确认删除？',
      purge: '彻底删除',
      purgeConfirm: '确认彻底删除？',
      restore: '恢复',
      emptyTrash: '彻底清除',
      emptyTrashConfirm: '确认清除？',
      selected: '已选 {n} 个',
      clearSelection: '取消选择',
      empty: '这里还没有会话',
      emptyTrashList: '回收站是空的',
      loading: '正在读取…',
      loadError: '读取失败：',
      foot: '会话库：{home}',
      damaged: '分类数据有损坏条目，已跳过；原文件备份在同目录 .bak',
      movedTo: '已移动到「{name}」',
      originalPath: '原位置',
      trashed: '已移入回收站',
      renameDone: '已重命名',
      selectAll: '全选',
      deselectAll: '取消全选',
      selectHint: '勾选左侧方框即可批量操作',
      bulkDeleteConfirm: '确认删除这 {n} 个会话？',
      deleteConfirmShort: '确认删除',
      cancel: '取消',
      makeWorkspace: '归入工作区',
      newSubfolder: '新建子文件夹',
      newSubfolderHint: '子文件夹名，回车创建',
      subfolders: '子文件夹',
    }

    const EN = {
      title: 'Session folders',
      summary: '{total} sessions · {archived} archived',
      refresh: 'Refresh',
      search: 'Search title / workspace / id',
      allSessions: 'All sessions',
      unfiled: 'Unfiled',
      ungrouped: 'Ungrouped',
      pruneGhosts: 'Clean up {n} ghosts',
      pruneHint: 'Remove references to sessions that no longer exist on disk',
      live: 'In use',
      liveHint: 'This session is still live in DSH; switch away or restart DSH for it to leave the sidebar',
      staleLive: '{n} deleted sessions are still held in DSH memory (visible under "Ungrouped"); they disappear after a DSH restart',
      trash: 'Trash',
      newFolder: 'New folder',
      newFolderHint: 'Folder name, Enter to create',
      renameFolder: 'Rename folder',
      deleteFolder: 'Delete folder',
      deleteFolderConfirm: 'Delete folder?',
      filterAll: 'All',
      filterActive: 'Active',
      filterArchived: 'Archived',
      more: 'More actions',
      moveTo: 'Move to',
      moveOut: 'Remove from folder',
      rename: 'Rename',
      renameHint: 'New title, Enter to save',
      open: 'Open',
      openArchived: 'Unarchive it before opening',
      archive: 'Archive',
      unarchive: 'Unarchive',
      forceArchive: 'Stop and archive',
      delete: 'Delete',
      deleteConfirm: 'Confirm delete?',
      purge: 'Delete forever',
      purgeConfirm: 'Confirm permanent delete?',
      restore: 'Restore',
      emptyTrash: 'Empty entry',
      emptyTrashConfirm: 'Confirm empty?',
      selected: '{n} selected',
      clearSelection: 'Clear selection',
      empty: 'No sessions here',
      emptyTrashList: 'Trash is empty',
      loading: 'Loading…',
      loadError: 'Failed to load: ',
      foot: 'Session library: {home}',
      damaged: 'Some folder entries were invalid and skipped; a .bak file sits next to the data file',
      movedTo: 'Moved to "{name}"',
      originalPath: 'Was at',
      trashed: 'Moved to trash',
      renameDone: 'Renamed',
      selectAll: 'Select all',
      deselectAll: 'Clear selection',
      selectHint: 'Tick boxes to act in bulk',
      bulkDeleteConfirm: 'Delete these {n} sessions?',
      deleteConfirmShort: 'Confirm delete',
      cancel: 'Cancel',
      makeWorkspace: 'Group into workspace',
      newSubfolder: 'New subfolder',
      newSubfolderHint: 'Subfolder name, Enter to create',
      subfolders: 'Subfolders',
    }

    /** 侧边栏图标：一个带标签的文件夹。 */
    function ClassifyIcon() {
      return jsxs('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        children: [
          jsx('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5V17a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17z', key: 'a' }),
          jsx('path', { d: 'M8 13h8', key: 'b' }),
        ],
      })
    }

    /** 请求宿主数据路由。 */
    async function fetchData() {
      const response = await fetch(DATA_PATH, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
      return payload
    }

    /** 请求宿主动作路由。 */
    async function postAction(body) {
      const response = await fetch(ACTION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok === false) throw new Error(payload.error || payload.text || ('HTTP ' + response.status))
      return payload
    }

    /** 千分位与友好字节。 */
    function humanBytes(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n < 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    /** `YYYY-MM-DD HH:mm`。 */
    function fmtTime(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const d = new Date(n)
      const pad = v => String(v).padStart(2, '0')
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /** 会话短 id（丢掉 `session-` 与后半段）。 */
    function shortId(id) {
      return String(id).replace(/^session-/u, '').slice(0, 8)
    }

    /** 规范化路径用于比较：小写、统一反斜杠、去掉尾部分隔符。 */
    function normalizePath(value) {
      return String(value || '').trim().replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
    }

    /**
     * 会话分类面板。
     *
     * @param props - `{ api }`：宿主上下文里取出的能力。
     * @returns 面板元素。
     */
    function ClassifyPanel(props) {
      const api = props.api || {}
      const t = api.t || (key => ZH[key] || key)
      const openSession = api.openSession
      const renameSession = api.renameSession
      const refreshSessions = api.refreshSessions || (async () => {})

      const [data, setData] = React.useState({
        loading: true,
        error: '',
        folders: [],
        workspaces: [],
        sessions: [],
        trash: [],
        workspacePaths: [],
        unclassified: 0,
        ungrouped: 0,
        staleLive: 0,
        ghosts: { total: 0 },
        archivedCount: 0,
        total: 0,
        home: '',
        damaged: false,
      })
      const [scope, setScope] = React.useState({ kind: 'all', id: '' })
      const [query, setQuery] = React.useState('')
      const [archiveFilter, setArchiveFilter] = React.useState('all')
      const [selected, setSelected] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [forceId, setForceId] = React.useState('')
      const [creating, setCreating] = React.useState('')
      const [creatingOpen, setCreatingOpen] = React.useState(false)
      const [renamingFolder, setRenamingFolder] = React.useState({ id: '', value: '' })
      const [renamingSession, setRenamingSession] = React.useState({ id: '', value: '' })
      const [confirmFolderRemove, setConfirmFolderRemove] = React.useState('')
      const [confirmTrash, setConfirmTrash] = React.useState('')
      const [confirmPurge, setConfirmPurge] = React.useState('')
      const [confirmEmpty, setConfirmEmpty] = React.useState('')
      const [confirmBulk, setConfirmBulk] = React.useState(false)
      const [menu, setMenu] = React.useState('')
      const [dragOver, setDragOver] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})
      const [creatingParent, setCreatingParent] = React.useState(null)

      const reload = React.useCallback(async () => {
        setData(prev => ({ ...prev, loading: true, error: '' }))
        try {
          const next = await fetchData()
          setData({
            loading: false,
            error: '',
            folders: next.folders || [],
            workspaces: next.workspaces || [],
            sessions: next.sessions || [],
            trash: next.trash || [],
            workspacePaths: next.workspacePaths || [],
            unclassified: next.unclassified || 0,
            ungrouped: next.ungrouped || 0,
            staleLive: next.staleLive || 0,
            ghosts: next.ghosts || { total: 0 },
            archivedCount: next.archivedCount || 0,
            total: next.total || 0,
            home: next.home || '',
            damaged: next.damaged === true,
          })
        } catch (error) {
          setData(prev => ({ ...prev, loading: false, error: String(error && error.message ? error.message : error) }))
        }
      }, [])

      React.useEffect(() => { void reload() }, [reload])

      // 切换范围 / 筛选 / 搜索词时清空勾选，避免批量操作作用到看不见的会话
      React.useEffect(() => {
        setSelected({})
        setConfirmBulk(false)
      }, [scope, archiveFilter, query])

      const act = React.useCallback(async (body, label) => {
        setBusy(label)
        setNotice('')
        setForceId('')
        try {
          const result = await postAction(body)
          setNotice(result.text || 'OK')
          setConfirmTrash('')
          setConfirmPurge('')
          setConfirmEmpty('')
          setConfirmFolderRemove('')
          setConfirmBulk(false)
          setMenu('')
          // 删除/恢复之后让 DSH 重读会话列表：不然它内存里还留着刚删的会话，
          // 取消归档的一瞬间就会把那具"空壳"显示到「进行中 / 未分组」里。
          if (REFRESH_ACTIONS.has(body.action) === true) await refreshSessions()
          await reload()
          return true
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          setNotice(message)
          if (/active|运行中|WorkspaceActiveSession/iu.test(message) && typeof body.session === 'string') {
            setForceId(body.session)
          }
          return false
        } finally {
          setBusy('')
        }
      }, [reload])

      const filteredSessions = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return data.sessions.filter(item => {
          if (scope.kind === 'workspace' && item.workspaceId !== scope.id) return false
          if (scope.kind === 'ungrouped' && item.workspaceId !== null) return false
          if (archiveFilter === 'active' && item.archived) return false
          if (archiveFilter === 'archived' && item.archived === false) return false
          if (needle === '') return true
          return (item.title || '').toLowerCase().includes(needle)
            || (item.cwd || '').toLowerCase().includes(needle)
            || String(item.id).toLowerCase().includes(needle)
        })
      }, [data.sessions, scope, archiveFilter, query])

      const filteredTrash = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return data.trash
        return data.trash.filter(entry =>
          (entry.sessionId || '').toLowerCase().includes(needle)
          || (entry.originalPath || '').toLowerCase().includes(needle)
          || String(entry.name).toLowerCase().includes(needle))
      }, [data.trash, query])

      const selectedIds = React.useMemo(
        () => Object.keys(selected).filter(id => selected[id]),
        [selected],
      )

      const folderOptions = data.folders

      /** 选中会话里尚未归入工作区的那些（侧栏仍显示「未分组」）。 */
      const selectedNeedsGroup = React.useMemo(() => {
        const ids = []
        const paths = new Set()
        for (const item of data.sessions) {
          if (selected[item.id] !== true) continue
          if (item.workspace !== null && item.workspace !== undefined) continue
          ids.push(item.id)
          if (typeof item.cwd === 'string' && item.cwd !== '') paths.add(item.cwd)
        }
        return { ids, paths: [...paths] }
      }, [data.sessions, selected])

      /** 按 id 取文件夹。 */
      const folderById = React.useMemo(
        () => new Map(data.folders.map(folder => [folder.id, folder])),
        [data.folders],
      )

      /** 某一层下的子文件夹（保持数据顺序）。 */
      const childrenOf = (parentId) => data.folders.filter(folder => (folder.parentId ?? null) === parentId)

      /** 当前列表（受范围 / 筛选 / 搜索影响）里的全部会话 id。 */
      const visibleIds = React.useMemo(
        () => filteredSessions.map(item => item.id),
        [filteredSessions],
      )

      /** 当前列表是否已经全选。 */
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected[id] === true)

      /** 全选 / 取消全选当前列表。 */
      const toggleSelectAll = () => {
        if (allSelected) {
          setSelected({})
          return
        }
        const next = {}
        for (const id of visibleIds) next[id] = true
        setSelected(next)
      }

      /** 勾选 / 取消一行。 */
      const toggleSelect = (id) => {
        setSelected(prev => ({ ...prev, [id]: prev[id] !== true }))
      }

      /** 批量把选中的会话移入回收站（二次确认后才调用）。 */
      const removeSelected = async () => {
        const ids = selectedIds.slice()
        if (ids.length === 0) return
        const ok = await act({ action: 'trash', sessions: ids }, 'trash-many')
        setConfirmBulk(false)
        if (ok) setSelected({})
      }

      /** 移动一个或多个会话到某个文件夹。 */
      const moveSessions = async (ids, folderId) => {
        if (ids.length === 0) return
        const body = ids.length === 1
          ? { action: 'assign', session: ids[0], folder: folderId || null }
          : { action: 'assign', sessions: ids, folder: folderId || null }
        const ok = await act(body, 'move')
        if (ok) {
          setSelected({})
          setNotice(t('movedTo').replace('{name}', folderId
            ? (folderOptions.find(folder => folder.id === folderId)?.name || folderId)
            : t('unfiled')))
        }
      }

      /** 同级内上移 / 下移文件夹。 */
      const moveFolder = (id, delta) => {
        const folder = folderById.get(id)
        if (folder === undefined) return
        const siblings = childrenOf(folder.parentId ?? null)
        const index = siblings.findIndex(item => item.id === id)
        const target = siblings[index + delta]
        if (target === undefined) return
        const order = data.folders.map(item => item.id)
        const from = order.indexOf(id)
        const to = order.indexOf(target.id)
        const [moved] = order.splice(from, 1)
        order.splice(to, 0, moved)
        void act({ action: 'reorder-folders', order }, 'reorder-folders')
      }

      /** 折叠 / 展开一个文件夹。 */
      const toggleCollapse = (id) => {
        setCollapsed(prev => ({ ...prev, [id]: prev[id] !== true }))
      }

      /** 提交会话重命名（走 Client 的 sessions 服务）。 */
      const submitSessionRename = async (id) => {
        const title = renamingSession.value.trim()
        setRenamingSession({ id: '', value: '' })
        if (title === '' || typeof renameSession !== 'function') return
        setBusy('rename-session')
        setNotice('')
        try {
          await renameSession(id, title)
          setNotice(t('renameDone'))
          await reload()
        } catch (error) {
          setNotice(String(error && error.message ? error.message : error))
        } finally {
          setBusy('')
        }
      }

      /** 拖拽放下：会话 → 归入该文件夹；文件夹 → 挂到该文件夹下面。 */
      const onDropIntoFolder = (folderId) => (event) => {
        event.preventDefault()
        setDragOver('')
        const draggedFolder = event.dataTransfer.getData('application/x-classify-folder')
        if (draggedFolder !== '' && draggedFolder !== folderId) {
          void act({ action: 'move-folder', folder: draggedFolder, parent: folderId }, 'move-folder')
          return
        }
        const raw = event.dataTransfer.getData('text/plain')
        const ids = raw.split(',').filter(value => value.length > 0)
        if (ids.length > 0) void moveSessions(ids, folderId)
      }

      /** 拖到「全部会话」：文件夹回到顶层（会话不动）。 */
      const onDropToRoot = (event) => {
        event.preventDefault()
        setDragOver('')
        const draggedFolder = event.dataTransfer.getData('application/x-classify-folder')
        if (draggedFolder !== '') {
          void act({ action: 'move-folder', folder: draggedFolder, parent: null }, 'move-folder')
        }
      }

      const summary = t('summary')
        .replace('{total}', String(data.total))
        .replace('{archived}', String(data.archivedCount))

      const header = jsxs('div', { className: 'scs_header', children: [
        jsx('div', { className: 'scs_heading', children: [
          jsx('div', { className: 'scs_title', children: t('title') }),
          jsx('div', { className: 'scs_meta', children: summary }),
        ] }),
        jsxs('div', { className: 'scs_tools', children: [
          (data.ghosts?.total ?? 0) > 0
            ? jsx('button', {
                className: 'scs_btn scs_btnDanger',
                disabled: busy !== '',
                title: t('pruneHint'),
                onClick: () => { void act({ action: 'prune-ghosts' }, 'prune-ghosts') },
                children: t('pruneGhosts').replace('{n}', String(data.ghosts.total)),
              }, 'prune')
            : null,
          jsx('input', {
            className: 'scs_search',
            placeholder: t('search'),
            value: query,
            onChange: event => { setQuery(event.target.value) },
          }),
          jsx('button', {
            className: 'scs_btn',
            onClick: () => { void reload() },
            disabled: data.loading,
            children: t('refresh'),
          }, 'refresh'),
        ] }),
      ] })

      const filters = scope.kind === 'trash'
        ? null
        : jsxs('div', { className: 'scs_filters', children: [
            jsx('button', {
              className: 'scs_chip' + (archiveFilter === 'all' ? ' scs_chipActive' : ''),
              onClick: () => { setArchiveFilter('all') },
              children: t('filterAll'),
            }, 'f-all'),
            jsx('button', {
              className: 'scs_chip' + (archiveFilter === 'active' ? ' scs_chipActive' : ''),
              onClick: () => { setArchiveFilter('active') },
              children: t('filterActive'),
            }, 'f-active'),
            jsx('button', {
              className: 'scs_chip' + (archiveFilter === 'archived' ? ' scs_chipActive' : ''),
              onClick: () => { setArchiveFilter('archived') },
              children: t('filterArchived'),
            }, 'f-archived'),
          ] })

      /** 一行「范围」：全部 / 未分类 / 回收站 这类固定项。 */
      const scopeRow = (key, label, count, active, extra) => {
        const opts = extra || {}
        return jsxs('div', {
          className: 'scs_scope' + (active ? ' scs_scopeActive' : '')
            + (dragOver === key ? ' scs_scopeDrop' : ''),
          onClick: opts.onClick,
          onDragOver: opts.droppable === true
            ? (event) => { event.preventDefault(); setDragOver(key) }
            : undefined,
          onDragLeave: opts.droppable === true ? () => { setDragOver('') } : undefined,
          onDrop: opts.droppable === true ? opts.onDrop : undefined,
          children: [
            jsx('span', { className: 'scs_caret scs_caretEmpty', children: '·' }),
            jsx('span', { className: 'scs_scopeName', children: label }),
            jsx('span', { className: 'scs_scopeCount', children: String(count) }),
            opts.node ? opts.node : null,
          ],
        }, key)
      }

      /** 递归渲染文件夹树：点一级看子文件夹，点二级看会话。 */
      const renderFolderNode = (folder, depth) => {
        const children = childrenOf(folder.id)
        const isCollapsed = collapsed[folder.id] === true
        const editing = renamingFolder.id === folder.id
        const removing = confirmFolderRemove === folder.id
        const active = scope.kind === 'folder' && scope.id === folder.id
        const key = 'folder:' + folder.id
        const siblings = childrenOf(folder.parentId ?? null)
        const index = siblings.findIndex(item => item.id === folder.id)
        const hasChildNode = children.length > 0

        const ops = removing
          ? jsxs('span', { className: 'scs_scopeOps', children: [
              jsx('button', {
                className: 'scs_iconBtn scs_iconBtnDanger',
                title: t('deleteFolderConfirm'),
                onClick: event => {
                  event.stopPropagation()
                  void act({ action: 'delete-folder', folder: folder.id }, 'delete-folder')
                  setConfirmFolderRemove('')
                  if (scope.kind === 'folder' && scope.id === folder.id) setScope({ kind: 'all', id: '' })
                },
                children: '确认',
              }, 'confirm'),
              jsx('button', {
                className: 'scs_iconBtn',
                onClick: event => { event.stopPropagation(); setConfirmFolderRemove('') },
                children: '取消',
              }, 'cancel'),
            ] })
          : jsxs('span', { className: 'scs_scopeOps', children: [
              jsx('button', {
                className: 'scs_iconBtn',
                title: '↑',
                disabled: index === 0,
                onClick: event => { event.stopPropagation(); moveFolder(folder.id, -1) },
                children: '↑',
              }, 'up'),
              jsx('button', {
                className: 'scs_iconBtn',
                title: '↓',
                disabled: index === siblings.length - 1,
                onClick: event => { event.stopPropagation(); moveFolder(folder.id, 1) },
                children: '↓',
              }, 'down'),
              jsx('button', {
                className: 'scs_iconBtn',
                title: t('newSubfolder'),
                onClick: event => {
                  event.stopPropagation()
                  setCreating('')
                  setCreatingParent(folder.id)
                  setCreatingOpen(true)
                  setCollapsed(prev => ({ ...prev, [folder.id]: false }))
                },
                children: '＋',
              }, 'sub'),
              jsx('button', {
                className: 'scs_iconBtn',
                title: t('renameFolder'),
                onClick: event => {
                  event.stopPropagation()
                  setRenamingFolder({ id: folder.id, value: folder.name })
                },
                children: '✎',
              }, 'r'),
              jsx('button', {
                className: 'scs_iconBtn',
                title: t('deleteFolder'),
                onClick: event => { event.stopPropagation(); setConfirmFolderRemove(folder.id) },
                children: '✕',
              }, 'd'),
            ] })

        return jsxs('div', { className: 'scs_treeWrap', children: [
          jsxs('div', {
            className: 'scs_scope scs_scopeTree' + (active ? ' scs_scopeActive' : '')
              + (dragOver === key ? ' scs_scopeDrop' : ''),
            style: { paddingLeft: (6 + depth * 14) + 'px' },
            draggable: editing === false,
            onClick: () => { setConfirmFolderRemove(''); setScope({ kind: 'folder', id: folder.id }) },
            onDragStart: event => {
              event.dataTransfer.setData('application/x-classify-folder', folder.id)
              event.dataTransfer.effectAllowed = 'move'
            },
            onDragOver: event => { event.preventDefault(); setDragOver(key) },
            onDragLeave: () => { setDragOver('') },
            onDrop: onDropIntoFolder(folder.id),
            children: [
              jsx('button', {
                className: 'scs_caret' + (hasChildNode ? '' : ' scs_caretEmpty'),
                onClick: event => {
                  event.stopPropagation()
                  if (hasChildNode) toggleCollapse(folder.id)
                },
                children: hasChildNode ? (isCollapsed ? '▸' : '▾') : '·',
              }, 'caret'),
              editing
                ? jsx('input', {
                    className: 'scs_inlineInput',
                    autoFocus: true,
                    value: renamingFolder.value,
                    onClick: event => { event.stopPropagation() },
                    onChange: event => { setRenamingFolder({ id: folder.id, value: event.target.value }) },
                    onKeyDown: event => {
                      if (event.key === 'Enter') {
                        void act({ action: 'rename-folder', folder: folder.id, name: renamingFolder.value }, 'rename-folder')
                          .then(() => { setRenamingFolder({ id: '', value: '' }) })
                      }
                      if (event.key === 'Escape') setRenamingFolder({ id: '', value: '' })
                    },
                    onBlur: () => { setRenamingFolder({ id: '', value: '' }) },
                  })
                : jsx('span', { className: 'scs_scopeName', children: folder.name }),
              jsx('span', {
                className: 'scs_scopeCount',
                children: folder.children > 0
                  ? `${folder.count} · ${folder.children} 夹`
                  : String(folder.count),
              }),
              editing ? null : ops,
            ],
          }),
          ...(children.length > 0 && isCollapsed === false
            ? children.map(child => renderFolderNode(child, depth + 1))
            : []),
        ] }, key)
      }

      /** 工作区按路径层级建树：`plugin` 下挂 `plugin/xxx`。 */
      const workspaceTree = React.useMemo(() => {
        const list = data.workspaces || []
        const byPath = new Map()
        for (const item of list) {
          const key = normalizePath(item.path)
          if (key !== '') byPath.set(key, item)
        }
        const children = new Map()
        const roots = []
        for (const workspace of list) {
          let parent = null
          let current = normalizePath(workspace.path)
          for (let guard = 0; guard < 24; guard += 1) {
            const cut = current.lastIndexOf('\\')
            if (cut <= 1) break
            current = current.slice(0, cut)
            const hit = byPath.get(current)
            if (hit !== undefined && hit.id !== workspace.id) { parent = hit; break }
          }
          if (parent === null) {
            roots.push(workspace)
          } else {
            const bucket = children.get(parent.id)
            if (bucket === undefined) children.set(parent.id, [workspace])
            else bucket.push(workspace)
          }
        }
        return { roots, children }
      }, [data.workspaces])

      /** 渲染工作区树节点。 */
      const renderWorkspaceNode = (workspace, depth) => {
        const kids = workspaceTree.children.get(workspace.id) || []
        const key = 'ws:' + workspace.id
        const isCollapsed = collapsed[key] === true
        const active = scope.kind === 'workspace' && scope.id === workspace.id
        return jsxs('div', { className: 'scs_treeWrap', children: [
          jsxs('div', {
            className: 'scs_scope scs_scopeTree' + (active ? ' scs_scopeActive' : ''),
            style: { paddingLeft: (6 + depth * 14) + 'px' },
            title: workspace.path,
            onClick: () => { setConfirmFolderRemove(''); setScope({ kind: 'workspace', id: workspace.id }) },
            children: [
              jsx('button', {
                className: 'scs_caret' + (kids.length === 0 ? ' scs_caretEmpty' : ''),
                onClick: event => {
                  event.stopPropagation()
                  if (kids.length > 0) toggleCollapse(key)
                },
                children: kids.length === 0 ? '·' : (isCollapsed ? '▸' : '▾'),
              }, 'caret'),
              jsx('span', { className: 'scs_scopeName', children: workspace.title }),
              jsx('span', { className: 'scs_scopeCount', children: String(workspace.count) }),
            ],
          }),
          ...(kids.length > 0 && isCollapsed === false
            ? kids.map(child => renderWorkspaceNode(child, depth + 1))
            : []),
        ] }, key)
      }

      const sidebar = jsxs('div', { className: 'scs_side', children: [
        scopeRow('all', t('allSessions'), data.total, scope.kind === 'all', {
          onClick: () => { setConfirmFolderRemove(''); setScope({ kind: 'all', id: '' }) },
        }),
        scopeRow('ungrouped', t('ungrouped'), data.ungrouped ?? 0, scope.kind === 'ungrouped', {
          onClick: () => { setConfirmFolderRemove(''); setScope({ kind: 'ungrouped', id: '' }) },
        }),
        ...workspaceTree.roots.map(workspace => renderWorkspaceNode(workspace, 0)),
        scopeRow('trash', t('trash'), data.trash.length, scope.kind === 'trash', {
          onClick: () => { setConfirmFolderRemove(''); setScope({ kind: 'trash', id: '' }) },
        }),
      ] })

      /** 菜单里的一枚操作按钮。 */
      const menuChip = (key, label, onClick, options) => {
        const opts = options || {}
        return jsx('button', {
          className: 'scs_chip scs_chipBtn'
            + (opts.active ? ' scs_chipActive' : '')
            + (opts.danger ? ' scs_chipDanger' : '')
            + (opts.primary ? ' scs_chipPrimary' : ''),
          disabled: busy !== '' || opts.disabled === true,
          title: opts.title || undefined,
          onClick,
          children: label,
        }, key)
      }

      /** 渲染一行会话。 */
      const renderRow = (item) => {
        const id = String(item.id)
        const checked = selected[id] === true
        const renaming = renamingSession.id === id
        const opened = menu === id

        /** 该会话还没归入任何工作区 → 侧边栏会把它列在「未分组」。 */
        const needsWorkspace = item.workspace === null || item.workspace === undefined

        const actionChips = renaming
          ? [
              jsx('input', {
                className: 'scs_inlineInput scs_renameInput',
                autoFocus: true,
                value: renamingSession.value,
                placeholder: t('renameHint'),
                onClick: event => { event.stopPropagation() },
                onChange: event => { setRenamingSession({ id, value: event.target.value }) },
                onKeyDown: event => {
                  if (event.key === 'Enter') { void submitSessionRename(id) }
                  if (event.key === 'Escape') setRenamingSession({ id: '', value: '' })
                },
              }, 'rename-input'),
            ]
          : [
              menuChip('rename', t('rename'), () => {
                setRenamingSession({ id, value: item.title || '' })
              }),
              menuChip('open', t('open'), () => {
                if (typeof openSession === 'function') openSession(id)
              }, { disabled: item.archived, title: item.archived ? t('openArchived') : undefined }),
              item.archived
                ? menuChip('unarchive', t('unarchive'), () => { void act({ action: 'unarchive', session: id }, 'unarchive') }, { primary: true })
                : menuChip('archive', t('archive'), () => { void act({ action: 'archive', session: id }, 'archive') }),
              confirmTrash === id
                ? menuChip('trash-confirm', t('deleteConfirm'), () => { void act({ action: 'trash', session: id }, 'trash') }, { danger: true })
                : menuChip('trash', t('delete'), () => { setConfirmTrash(id); setConfirmPurge('') }),
              confirmPurge === id
                ? menuChip('purge-confirm', t('purgeConfirm'), () => {
                    void act({ action: 'purge', session: id, confirm: true }, 'purge')
                  }, { danger: true })
                : menuChip('purge', t('purge'), () => { setConfirmPurge(id); setConfirmTrash('') }, { danger: true }),
              forceId === id
                ? menuChip('force', t('forceArchive'), () => {
                    void act({ action: 'archive', session: id, stopActivity: true }, 'force-archive')
                  }, { danger: true })
                : null,
              needsWorkspace
                ? menuChip('mkws', t('makeWorkspace'), () => {
                    void act({ action: 'create-workspace', path: item.cwd, sessions: [id] }, 'create-workspace')
                  }, { title: item.cwd })
                : null,
            ]

        return jsxs('div', {
          className: 'scs_item' + (checked ? ' scs_itemChecked' : ''),
          children: [
            jsxs('div', {
              className: 'scs_row',
              draggable: true,
              onDragStart: event => {
                event.dataTransfer.setData('text/plain', checked && selectedIds.length > 1 ? selectedIds.join(',') : id)
                event.dataTransfer.effectAllowed = 'move'
              },
              children: [
                jsx('input', {
                  type: 'checkbox',
                  className: 'scs_check',
                  checked,
                  onChange: () => { toggleSelect(id) },
                }),
                jsxs('div', { className: 'scs_rowMain', children: [
                  jsxs('div', { className: 'scs_rowTitle', children: [
                    jsx('span', { className: 'scs_rowTitleText', children: item.title || '（无标题）' }),
                    item.archived ? jsx('span', { className: 'scs_badge', children: t('filterArchived') }) : null,
                    item.live === true
                      ? jsx('span', { className: 'scs_badge scs_badgeLive', title: t('liveHint'), children: t('live') })
                      : null,
                    item.workspace !== null && item.workspace !== undefined
                      ? jsx('span', { className: 'scs_badge scs_badgeFolder', children: item.workspace })
                      : jsx('span', { className: 'scs_badge scs_badgeFolder', children: t('ungrouped') }),
                  ] }),
                  jsx('div', {
                    className: 'scs_rowMeta',
                    children: shortId(id) + ' · ' + (item.cwd || '—') + ' · ' + fmtTime(item.mtimeMs) + ' · ' + humanBytes(item.bytes),
                  }),
                ] }),
                jsx('button', {
                  className: 'scs_more' + (opened ? ' scs_moreActive' : ''),
                  title: t('more'),
                  onClick: () => { setMenu(opened ? '' : id) },
                  children: opened ? '▴' : '⋯',
                }),
              ],
            }),
            opened
              ? jsxs('div', { className: 'scs_menu', children: [
                  ...actionChips,
                ] })
              : null,
          ],
        }, id)
      }

      /** 渲染一行回收站条目。 */
      const renderTrashRow = (entry) => {
        const naming = String(entry.name)
        return jsxs('div', { className: 'scs_item', children: [
          jsxs('div', { className: 'scs_row', children: [
            jsxs('div', { className: 'scs_rowMain', children: [
              jsxs('div', { className: 'scs_rowTitle', children: [
                jsx('span', { className: 'scs_rowTitleText', children: shortId(entry.sessionId) }),
                jsx('span', { className: 'scs_badge', children: humanBytes(entry.bytes) }),
                entry.trashedAt > 0 ? jsx('span', { className: 'scs_badge', children: fmtTime(entry.trashedAt) }) : null,
              ] }),
              jsx('div', {
                className: 'scs_rowMeta',
                children: t('originalPath') + '：' + (entry.originalPath || '—'),
              }),
            ] }),
            jsxs('div', { className: 'scs_rowOps', children: [
              jsx('button', {
                className: 'scs_btn scs_btnPrimary',
                disabled: busy !== '',
                onClick: () => { void act({ action: 'restore', name: naming }, 'restore') },
                children: t('restore'),
              }, 'restore'),
              confirmEmpty === naming
                ? jsx('button', {
                    className: 'scs_btn scs_btnDanger',
                    disabled: busy !== '',
                    onClick: () => { void act({ action: 'empty', name: naming, confirm: true }, 'empty') },
                    children: t('emptyTrashConfirm'),
                  }, 'empty-confirm')
                : jsx('button', {
                    className: 'scs_btn scs_btnDanger',
                    disabled: busy !== '',
                    onClick: () => { setConfirmEmpty(naming) },
                    children: t('emptyTrash'),
                  }, 'empty'),
            ] }),
          ] }),
        ] }, naming)
      }

      const bulkBar = scope.kind === 'trash'
        ? null
        : jsxs('div', { className: 'scs_bulk', children: [
            jsx('button', {
              className: 'scs_chip scs_chipBtn',
              disabled: filteredSessions.length === 0,
              onClick: () => { toggleSelectAll() },
              children: allSelected ? t('deselectAll') : t('selectAll'),
            }, 'select-all'),
            selectedIds.length > 0
              ? jsx('span', { className: 'scs_bulkLabel', children: t('selected').replace('{n}', String(selectedIds.length)) })
              : jsx('span', { className: 'scs_bulkLabel', children: t('selectHint') }),
            selectedNeedsGroup.ids.length > 0
              ? menuChip('bulk-mkws', t('makeWorkspace'), () => {
                  void act({
                    action: 'create-workspace',
                    paths: selectedNeedsGroup.paths,
                    sessions: selectedNeedsGroup.ids,
                  }, 'create-workspace')
                }, { title: selectedNeedsGroup.paths.join('\n') })
              : null,
            selectedIds.length > 0
              ? (confirmBulk
                  ? jsxs('span', { className: 'scs_bulkConfirm', children: [
                      jsx('span', { children: t('bulkDeleteConfirm').replace('{n}', String(selectedIds.length)) }),
                      jsx('button', {
                        className: 'scs_btn scs_btnDanger',
                        disabled: busy !== '',
                        onClick: () => { void removeSelected() },
                        children: t('deleteConfirmShort'),
                      }, 'bulk-trash-yes'),
                      jsx('button', {
                        className: 'scs_btn',
                        onClick: () => { setConfirmBulk(false) },
                        children: t('cancel'),
                      }, 'bulk-trash-no'),
                    ] })
                  : jsx('button', {
                      className: 'scs_btn scs_btnDanger',
                      disabled: busy !== '',
                      onClick: () => { setConfirmBulk(true) },
                      children: t('delete'),
                    }, 'bulk-trash'))
              : null,
            selectedIds.length > 0
              ? jsx('button', {
                  className: 'scs_btn',
                  onClick: () => { setSelected({}) },
                  children: t('clearSelection'),
                }, 'clear')
              : null,
          ] })

      let body = null
      if (data.loading) {
        body = jsx('div', { className: 'scs_empty', children: t('loading') })
      } else if (data.error !== '') {
        body = jsx('div', { className: 'scs_empty scs_error', children: t('loadError') + data.error })
      } else if (scope.kind === 'trash') {
        body = filteredTrash.length === 0
          ? jsx('div', { className: 'scs_empty', children: t('emptyTrashList') })
          : jsx('div', { className: 'scs_list', children: filteredTrash.map(renderTrashRow) })
      } else {
        const currentWorkspace = scope.kind === 'workspace'
          ? (data.workspaces || []).find(item => item.id === scope.id)
          : undefined
        const childWorkspaces = currentWorkspace === undefined
          ? []
          : (workspaceTree.children.get(currentWorkspace.id) || [])
        const listNode = filteredSessions.length === 0
          ? jsx('div', { className: 'scs_empty', children: t('empty') })
          : jsx('div', { className: 'scs_list', children: filteredSessions.map(renderRow) })
        body = jsxs('div', { className: 'scs_bodyWrap', children: [
          childWorkspaces.length === 0
            ? null
            : jsxs('div', { className: 'scs_subfolderRow', children: [
                jsx('span', { className: 'scs_menuLabel', children: t('subfolders') }),
                ...childWorkspaces.map(child => jsxs('button', {
                  className: 'scs_chip scs_chipBtn scs_subfolderChip',
                  title: child.path,
                  onClick: () => { setScope({ kind: 'workspace', id: child.id }) },
                  children: [
                    jsx('span', { children: child.title }, 'name'),
                    jsx('span', { className: 'scs_subCount', children: `${child.count} 会话` }, 'count'),
                  ],
                }, 'sub-' + child.id)),
              ] }),
          listNode,
        ] })
      }

      return jsxs('div', { className: 'scs_root', children: [
        header,
        filters,
        notice !== '' ? jsx('div', { className: 'scs_notice', children: notice }) : null,
        data.damaged ? jsx('div', { className: 'scs_warn', children: t('damaged') }) : null,
        (data.staleLive ?? 0) > 0
          ? jsx('div', { className: 'scs_warn', children: t('staleLive').replace('{n}', String(data.staleLive)) })
          : null,
        jsxs('div', { className: 'scs_main', children: [sidebar, jsxs('div', { className: 'scs_content', children: [bulkBar, body] })] }),
        jsx('div', { className: 'scs_foot', children: t('foot').replace('{home}', data.home || '—') }),
      ] })
    }

    const CSS = [
      '.scs_root{display:flex;flex-direction:column;gap:10px;height:100%;padding:14px 16px;box-sizing:border-box;min-height:0;color:var(--dsw-alias-label-primary)}',
      '.scs_header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.scs_heading{display:flex;flex-direction:column;gap:2px}',
      '.scs_title{font-size:15px;font-weight:600}',
      '.scs_meta{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.scs_tools{margin-left:auto;display:flex;gap:6px;align-items:center}',
      '.scs_search{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:13px;padding:6px 10px;border-radius:8px;outline:none;min-width:220px}',
      '.scs_filters{display:flex;gap:6px}',
      '.scs_chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}',
      '.scs_chipActive{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.scs_chipBtn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.scs_chipDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.scs_chipPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.scs_chip:disabled{opacity:.45;cursor:default}',
      '.scs_btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.scs_btn:disabled{opacity:.45;cursor:default}',
      '.scs_btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.scs_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.scs_main{flex:1;min-height:0;display:flex;gap:12px}',
      '.scs_side{width:210px;flex:none;display:flex;flex-direction:column;gap:2px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding-right:8px}',
      '.scs_scope{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:13px;border:1px dashed transparent}',
      '.scs_scope:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.scs_scopeActive{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.scs_scopeDrop{border-color:var(--dsw-alias-brand-primary)}',
      '.scs_scopeName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.scs_scopeCount{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.scs_scopeTree{cursor:pointer}',
      '.scs_treeWrap{display:flex;flex-direction:column;gap:2px}',
      '.scs_caret{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:10px;line-height:1;padding:0;width:12px;flex:none}',
      '.scs_caretEmpty{cursor:default;opacity:.35}',
      '.scs_scopeOps{display:none;gap:4px}',
      '.scs_scope:hover .scs_scopeOps{display:flex}',
      '.scs_iconBtn{border:none;background:transparent;color:inherit;cursor:pointer;font-size:11px;opacity:.7;padding:0 2px}',
      '.scs_iconBtn:hover{opacity:1}',
      '.scs_iconBtn:disabled{opacity:.3;cursor:default}',
      '.scs_iconBtnDanger{color:var(--dsw-alias-state-error-primary);opacity:1}',
      '.scs_bodyWrap{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1}',
      '.scs_subfolderRow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:2px 0 4px}',
      '.scs_subfolderChip{display:inline-flex;gap:6px;align-items:center}',
      '.scs_subCount{font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.scs_inlineInput{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:12px;padding:3px 6px;border-radius:6px;outline:none;width:100%;box-sizing:border-box}',
      '.scs_renameInput{min-width:240px}',
      '.scs_newFolder{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer}',
      '.scs_newFolder:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.scs_content{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;min-height:0}',
      '.scs_bulk{display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}',
      '.scs_bulkLabel{margin-right:4px;color:var(--dsw-alias-label-secondary)}',
      '.scs_bulkConfirm{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.scs_list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px}',
      '.scs_item{display:flex;flex-direction:column;gap:4px;border-radius:8px}',
      '.scs_itemChecked{background:var(--dsw-alias-bg-layer-2)}',
      '.scs_row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px}',
      '.scs_row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.scs_check{accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.scs_rowMain{min-width:0;flex:1}',
      '.scs_rowTitle{display:flex;align-items:center;gap:6px;font-size:13px}',
      '.scs_rowTitleText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.scs_badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);flex:none}',
      '.scs_badgeLive{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.scs_badgeFolder{border-style:dashed}',
      '.scs_rowMeta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.scs_rowOps{display:flex;gap:6px;align-items:center;flex:none}',
      '.scs_more{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;padding:2px 8px;border-radius:6px;cursor:pointer;flex:none}',
      '.scs_more:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.scs_moreActive{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.scs_menu{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px 8px 10px;margin-left:26px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:0 8px 8px 0}',
      '.scs_menuLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.scs_menuSep{width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 2px}',
      '.scs_empty{padding:24px 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.scs_error{color:var(--dsw-alias-state-error-primary)}',
      '.scs_notice{font-size:12px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.scs_warn{font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.scs_foot{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('\n')

    return {
      name: 'session-classify-panel',
      /** 只依赖 slot 注册表；`uiWorkspace` / `sessions` / `locale` 按可用性取用。 */
      inject: ['slots'],
      /**
       * 注册侧边栏入口与主列页面。
       *
       * 两者必须成对：`sidebar.panellist` 的 id 就是主列派发用的 key。
       *
       * @param ctx - 客户端根上下文。
       */
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-session-classify'
          tag.dataset.pluginCss = 'dsh-session-classify/panel.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'dsh-session-classify: 面板样式')

        /** 文案：优先用 locale 服务的字典，缺失时退回内置中文。 */
        let dictionary = ZH
        ctx.effect(() => {
          try {
            if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
              const disposeZh = ctx.locale.register('session-classify', 'zh', ZH)
              const disposeEn = ctx.locale.register('session-classify', 'en', EN)
              const bound = ctx.locale.bind('session-classify')
              dictionary = key => {
                const value = typeof bound === 'function' ? bound(key) : undefined
                return typeof value === 'string' && value.length > 0 ? value : (ZH[key] || key)
              }
              return () => {
                if (typeof disposeZh === 'function') disposeZh()
                if (typeof disposeEn === 'function') disposeEn()
              }
            }
          } catch {
            // locale 服务形态变化时不该让面板打不开
          }
          return () => {}
        }, 'dsh-session-classify: 文案字典')
        const t = key => (typeof dictionary === 'function' ? dictionary(key) : (dictionary[key] || key))

        /** 服务查找：Cordis Context 的 get 在 Client 侧同样可用。 */
        const serviceOf = (name) => {
          try {
            return ctx.get !== undefined ? ctx.get(name) : undefined
          } catch {
            return undefined
          }
        }

        /** 让 DSH 重读会话列表：删除后它内存里的空壳才会消失。 */
        const refreshSessions = async () => {
          try {
            const sessions = serviceOf('sessions')
            if (sessions !== undefined && sessions !== null && typeof sessions.refresh === 'function') {
              await sessions.refresh()
            }
          } catch {
            // 刷新失败不影响面板自身的数据
          }
        }

        /** 打开一个会话；`uiWorkspace` 缺席时按钮会被禁用。 */
        const openSession = (sessionId) => {
          try {
            const uiWorkspace = serviceOf('uiWorkspace')
            if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function') {
              uiWorkspace.openSession(sessionId)
            }
          } catch {
            // 打开失败不该影响分类操作
          }
        }

        /**
         * 重命名会话：走 DSH 自己的 sessions 服务，标题写入会话日志并广播。
         *
         * @param sessionId - 会话 id。
         * @param title - 新标题。
         * @returns 完成时 resolve。
         */
        const renameSession = async (sessionId, title) => {
          const trimmed = String(title || '').trim()
          if (trimmed === '') throw new Error('标题不能为空')
          const sessions = serviceOf('sessions')
          if (sessions === undefined || sessions === null || typeof sessions.retain !== 'function') {
            throw new Error('缺少 sessions 服务，无法重命名')
          }
          const reference = sessions.retain(sessionId, { source: 'controllerOperation' })
          try {
            const binding = reference.binding !== undefined ? reference.binding : await reference.ready
            if (binding === undefined || binding === null || typeof binding.session.rename !== 'function') {
              throw new Error('该会话暂不可重命名')
            }
            const result = await binding.session.rename(trimmed)
            if (result !== undefined && result !== null && result.ok === false) {
              throw new Error((result.error && result.error.message) || '重命名失败')
            }
          } finally {
            if (typeof reference.release === 'function') reference.release()
          }
        }

        const Panel = props => jsx(ClassifyPanel, { ...props, api: { t, openSession, renameSession, refreshSessions } })

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 7,
          label: t('title'),
        }, ClassifyIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel))
      },
    }
  },
})

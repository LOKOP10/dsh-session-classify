/**
 * dsh-session-manage —— 把 DSH 会话按「文件夹」自行分类，并管理它们的去留。
 *
 * ## 为什么需要它
 *
 * DSH 侧边栏只按工作目录分组，归档过的对话在侧边栏里直接消失，也没有删除会话
 * 的入口。本插件把两件事放到一个面板里：
 *
 * - **分类**：自建文件夹、拖拽归入、随时查看全部（含已归档）会话；
 * - **会话管理**（原 dsh-session-manager 的能力）：移入回收站、彻底删除、
 *   查看与恢复回收站，并清理 DSH 的两份索引缓存。
 *
 * ## 职责划分
 *
 * - **分类数据**由本插件自己保管（`<DSH_HOME>/storages/dsh-session-manage.json`），
 *   不碰 DSH 的会话库与 `workspace.json`；
 * - **归档 / 取消归档**一律调用 `workspaceRegistry` 服务，保证侧边栏、
 *   Agent 的 pre-step 门与磁盘状态一致；
 * - **删除**默认进 `<DSH_HOME>/.session-trash/`，可恢复；彻底删除要显式确认；
 * - **浏览器界面**走同源 HTTP（`/plugins/dsh-session-manage/*`），
 *   不引入 Remote codec，因此不需要任何构建步骤。
 *
 * @module dsh-session-manage
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  assignSession,
  addFolder,
  countByFolder,
  loadStore,
  removeFolder,
  renameFolder,
  reorderFolders,
  saveStore,
  setFolderParent,
} from './store.js'
import {
  archivedIdsOf,
  listSessions,
  normalizePath,
  normalizeSessionId,
  resolveDshHome,
  sessionsRootOf,
  workspacePathsOf,
  workspacesOf,
} from './sessions.js'
import {
  listTrash,
  matchByPrefix,
  purgeSession,
  purgeTrash,
  removeFromArchiveSet,
  restoreTrash,
  trashSession,
} from './trash.js'

/** Cordis 插件名。 */
export const name = 'session-manage'

/** 可选依赖：命令、工具与网页服务缺席时插件仍要能激活。 */
export const inject = []

/** 浏览器界面数据路由。 */
export const DATA_PATH = '/plugins/dsh-session-manage/data'

/** 浏览器界面动作路由。 */
export const ACTION_PATH = '/plugins/dsh-session-manage/action'

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'sessions'

/** 工具名。 */
export const TOOL_NAME = 'session_manage'

/** 允许访问路由的主机名（仅回环）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 会话 id 白名单：只允许字母数字与 `._-`。 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u

/** 一次列出的默认条数。 */
const DEFAULT_LIMIT = 30

/** 命令帮助文本。 */
const USAGE = [
  '用法：',
  '  /sessions                      列出最近会话（按工作区显示）',
  '  /sessions all                  列出全部会话',
  '  /sessions trash <id前缀>       移入回收站（可恢复）',
  '  /sessions purge <id前缀> --yes 彻底删除（不可恢复）',
  '  /sessions trash-list           查看回收站',
  '  /sessions restore <条目名>     从回收站恢复',
  '  /sessions empty <条目名> --yes 彻底清空回收站条目',
].join('\n')

/**
 * 从 Host 头取主机名。
 *
 * @param host - `Host` 请求头。
 * @returns 小写主机名。
 */
function hostnameOf(host) {
  if (typeof host !== 'string') return ''
  const value = host.trim().toLowerCase()
  if (value.length === 0) return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/**
 * 判断请求是否来自回环地址。
 *
 * @param req - HTTP 请求。
 * @returns 允许时为 true。
 */
export function isLoopbackRequest(req) {
  if (LOOPBACK_HOSTS.has(hostnameOf(req?.headers?.host)) === false) return false
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.trim().length === 0) return true
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 写 JSON 响应。
 *
 * @param res - HTTP 响应。
 * @param status - 状态码。
 * @param value - 载荷。
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读请求体并解析 JSON。
 *
 * @param req - HTTP 请求。
 * @param limit - 最大字节数。
 * @returns 解析结果；超限或非法时为 `{ error }`。
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return { error: '请求体过大' }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return { value: {} }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { error: '请求体不是合法 JSON' }
  }
}

/**
 * 校验会话 id。
 *
 * @param sessionId - 待校验的值。
 * @returns 合法的会话 id。
 */
function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || SAFE_SESSION_ID.test(sessionId) === false) {
    throw new Error(`非法的会话 id：${String(sessionId)}`)
  }
  return sessionId
}

/**
 * 取 workspace 注册表服务。
 *
 * @param ctx - Host 上下文。
 * @returns `workspaceRegistry`。
 */
function requireRegistry(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || registry === null) {
    throw new Error('当前 profile 没有加载 workspaceRegistry 服务，无法归档会话')
  }
  return registry
}

/**
 * 当前仍在内存里的会话 id 集合（DSH 打开着 / 最近用过的）。
 *
 * 这些会话即使磁盘目录被删，DSH 的侧栏仍会把它列在「进行中 / 未分组」里——
 * 因为侧栏读的是内存会话表，不是磁盘。面板据此标出「使用中」，让「删了还看得见」
 * 有据可查；批量删除也据此跳过它们。
 *
 * @param ctx - Host 上下文。
 * @returns 会话 id 集合；相关服务缺席时为空集。
 */
function liveSessionIds(ctx) {
  const ids = new Set()
  if (typeof ctx.get !== 'function') return ids
  try {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        const id = session?.id ?? session?.header?.id
        if (typeof id === 'string') ids.add(id)
      }
    }
  } catch {
    // 忽略：下面还有 agents 兜底
  }
  try {
    const agents = ctx.get('agents')
    if (agents !== undefined && agents !== null && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        if (typeof agent?.id === 'string') ids.add(agent.id)
      }
    }
  } catch {
    // 忽略
  }
  return ids
}

/**
 * 判断某个会话是否在「内存活跃」集合里（兼容带 / 不带 `session-` 前缀）。
 *
 * @param live - `liveSessionIds` 返回的集合。
 * @param sessionId - 会话 id。
 * @returns 活跃时为 true。
 */
function isLiveId(live, sessionId) {
  if (typeof sessionId !== 'string' || live instanceof Set === false) return false
  return live.has(sessionId) || live.has(normalizeSessionId(sessionId))
}

/**
 * 把会话从「归档集合」里清掉。
 *
 * 删除会话不会自动清 `archivedSessionIds`，残留的 id 会让侧边栏「归档」栏继续
 * 显示已经不在磁盘上的对话。优先走 `workspaceRegistry.unarchiveSession`
 * （服务内存与持久化一起更新，对不存在的会话也是合法的空操作），服务缺席时
 * 直接改文件兜底。
 *
 * @param ctx - Host 上下文（同步路径可为 undefined）。
 * @param home - DSH 主目录。
 * @param sessionId - 会话 id。
 * @returns 完成时 resolve。
 */
async function releaseArchive(ctx, home, sessionId) {
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry !== undefined && registry !== null && typeof registry.unarchiveSession === 'function') {
      await registry.unarchiveSession(sessionId)
      return
    }
  } catch {
    // 落到文件兜底
  }
  removeFromArchiveSet(home, sessionId)
}

/**
 * 把会话从它所属工作区的 `sessionIds` 里摘掉。
 *
 * 必须在会话目录还存在时调用：服务的工作区列表按 cwd 头索引过滤，会话一旦
 * 被删就查不到它，残留引用就再也摘不掉（侧栏会留下点开报 not-found 的条目）。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 会话 id。
 * @returns 完成时 resolve。
 */
async function detachFromWorkspaces(ctx, sessionId) {
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return
    const target = normalizeSessionId(sessionId)
    for (const workspace of registry.list()) {
      const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      if (ids.some(id => normalizeSessionId(id) === target) === false) continue
      try {
        await workspace.detachSession(sessionId)
      } catch {
        // 单个工作区 detachment 失败不影响其余
      }
    }
  } catch {
    // 服务缺席时跳过：prune-ghosts 仍可事后清理
  }
}

/**
 * 删除会话前，把它在所有"引用表"里的痕迹清掉（归档集合 + 工作区列表）。
 *
 * @param ctx - Host 上下文。
 * @param home - DSH 主目录。
 * @param sessionId - 会话 id。
 * @returns 完成时 resolve。
 */
async function releaseReferences(ctx, home, sessionId) {
  await releaseArchive(ctx, home, sessionId)
  await detachFromWorkspaces(ctx, sessionId)
}

/**
 * 人类可读的字节数。
 *
 * @param bytes - 字节数。
 * @returns 例如 `12.3 KB`。
 */
export function humanBytes(bytes) {
  const n = Number(bytes)
  if (Number.isFinite(n) === false || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 时间戳格式化为本地时间 `YYYY-MM-DD HH:mm`。
 *
 * @param ms - 毫秒时间戳。
 * @returns 格式化文本；非法输入为 `—`。
 */
export function formatTime(ms) {
  const n = Number(ms)
  if (Number.isFinite(n) === false || n <= 0) return '—'
  const d = new Date(n)
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把活跃会话的写句柄刷一次盘。
 *
 * 会话日志的 `append` 是 best-effort，`flush` 才是耐久屏障。面板标题读的是
 * 磁盘日志，所以刷新数据前先请求一次 flush，避免刚写入的标题还停在内存里。
 *
 * @param ctx - Host 上下文。
 * @returns 完成时 resolve；服务缺席或失败时静默返回。
 */
export async function flushSessions(ctx) {
  try {
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
    if (persistence !== undefined && persistence !== null && typeof persistence.flush === 'function') {
      await persistence.flush()
    }
  } catch {
    // 刷盘失败不该阻塞读取：磁盘上的旧数据仍然可读
  }
}

/**
 * 组装面板需要的全部数据。
 *
 * @param options - `{ home }`。
 * @returns 快照对象。
 */
export function buildSnapshot(options) {
  const home = options.home ?? resolveDshHome()
  const { store, damaged, path } = loadStore(home)
  const sessions = listSessions({ home })
  const known = new Set(sessions.map(item => item.id))
  const { counts, unclassified } = countByFolder(store, known)

  // 侧边栏分组来自工作区自己的 sessionIds，据此标记每个会话属于哪个工作区
  const knownBare = new Set(sessions.map(item => normalizeSessionId(item.id)))
  const workspaceOf = new Map()
  const workspaces = workspacesOf(home).map(workspace => {
    const live = []
    for (const sessionId of workspace.sessionIds) {
      const bare = normalizeSessionId(sessionId)
      if (knownBare.has(bare) === false) continue
      live.push(bare)
      workspaceOf.set(bare, { id: workspace.id, title: workspace.title || workspace.id })
    }
    return {
      id: workspace.id,
      title: workspace.title || workspace.path || workspace.id,
      path: workspace.path,
      count: live.length,
    }
  })

  const liveIds = options.live ?? new Set()
  const rows = sessions.map(item => ({
    id: item.id,
    title: item.title,
    cwd: item.cwd,
    cwdSlug: item.cwdSlug,
    bytes: item.bytes,
    mtimeMs: item.mtimeMs,
    createdAt: item.createdAt,
    archived: item.archived,
    live: liveIds.has(item.id) || liveIds.has(normalizeSessionId(item.id)),
    folder: typeof store.assignments[item.id] === 'string' ? store.assignments[item.id] : null,
    workspace: workspaceOf.get(normalizeSessionId(item.id))?.title ?? null,
    workspaceId: workspaceOf.get(normalizeSessionId(item.id))?.id ?? null,
  }))

  // 幽灵引用统计：磁盘上已不存在、却还留在引用表/缓存里的会话
  const ghostArchived = [...archivedIdsOf(home)]
    .filter(id => knownBare.has(normalizeSessionId(id)) === false).length
  let ghostWorkspaces = 0
  for (const workspace of workspacesOf(home)) {
    for (const sessionId of workspace.sessionIds) {
      if (knownBare.has(normalizeSessionId(sessionId)) === false) ghostWorkspaces += 1
    }
  }
  let ghostProjcache = 0
  try {
    const projDir = join(home, 'storages', 'session_projcache', 'sessions')
    for (const file of readdirSync(projDir)) {
      if (file.endsWith('.json') === false) continue
      if (knownBare.has(normalizeSessionId(file.replace(/\.json$/u, ''))) === false) ghostProjcache += 1
    }
  } catch {
    // 目录不存在时忽略
  }

  // 内存里还活着、磁盘上已经没了的会话：DSH 侧栏会把它列在「未分组」，
  // 只能靠切走或重启 DSH 释放，插件侧无法移除。
  let staleLive = 0
  for (const id of liveIds) {
    if (knownBare.has(normalizeSessionId(id)) === false) staleLive += 1
  }

  return {
    home,
    path,
    damaged,
    staleLive,
    folders: store.folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId ?? null,
      count: counts.get(folder.id) ?? 0,
      children: store.folders.filter(item => (item.parentId ?? null) === folder.id).length,
    })),
    workspaces,
    sessions: rows,
    trash: listTrash({ home }),
    workspacePaths: [...workspacePathsOf(home)],
    ghosts: {
      archived: ghostArchived,
      workspaces: ghostWorkspaces,
      projcache: ghostProjcache,
      total: ghostArchived + ghostWorkspaces + ghostProjcache,
    },
    unclassified,
    ungrouped: rows.filter(row => row.workspaceId === null).length,
    archivedCount: rows.filter(row => row.archived).length,
    total: rows.length,
  }
}

/**
 * 把会话列表渲染成文本（命令与工具用）。
 *
 * @param sessions - `listSessions` 的结果。
 * @param limit - 最多渲染多少条。
 * @returns 文本。
 */
export function renderList(sessions, limit = DEFAULT_LIMIT) {
  if (sessions.length === 0) return '没有找到任何会话。'
  const shown = sessions.slice(0, limit)
  const groups = new Map()
  for (const session of shown) {
    const key = session.cwd || session.cwdSlug
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [session])
    else bucket.push(session)
  }
  const lines = []
  for (const [cwd, items] of groups) {
    lines.push(`${cwd}`)
    for (const item of items) {
      const id = item.id.replace(/^session-/u, '').slice(0, 8)
      const title = item.title.length > 0 ? item.title : '（无标题）'
      const archived = item.archived ? ' [归档]' : ''
      lines.push(`  ${id}  ${formatTime(item.mtimeMs)}  ${humanBytes(item.bytes).padStart(9)}${archived}  ${title}`)
    }
    lines.push('')
  }
  if (sessions.length > shown.length) {
    lines.push(`还有 ${sessions.length - shown.length} 个会话未显示，用 /sessions all 看全部。`)
  }
  lines.push('删除：/sessions trash <id前缀>（可恢复）｜彻底删除：/sessions purge <id前缀> --yes')
  return lines.join('\n').trimEnd()
}

/**
 * 把回收站渲染成文本。
 *
 * @param entries - `listTrash` 的结果。
 * @returns 文本。
 */
export function renderTrash(entries) {
  if (entries.length === 0) return '回收站是空的。'
  const lines = ['回收站：']
  for (const entry of entries) {
    lines.push(`  ${entry.name}`)
    lines.push(`    原位置 ${entry.originalPath || '（未知）'} · ${humanBytes(entry.bytes)}`)
  }
  lines.push('恢复：/sessions restore <条目名>｜彻底清空：/sessions empty <条目名> --yes')
  return lines.join('\n')
}

/**
 * 删掉某个会话在分类里的归属（会话被删除 / 移入回收站后调用）。
 *
 * @param home - DSH 主目录。
 * @param sessionId - 会话 id。
 */
function forgetAssignment(home, sessionId) {
  const { store } = loadStore(home)
  if (Object.hasOwn(store.assignments, sessionId) === false) return
  delete store.assignments[sessionId]
  saveStore(home, store)
}

/**
 * 执行一次动作；HTTP 路由、命令与工具共用。
 *
 * @param ctx - Host 上下文（归档动作需要 `workspaceRegistry`）。
 * @param options - 见各分支。
 * @returns `{ ok, text }`。
 */
export async function runAction(ctx, options) {
  const home = options.home ?? resolveDshHome()
  const action = options.action
  const root = sessionsRootOf(home)

  try {
    if (action === 'create-folder') {
      const { store } = loadStore(home)
      const folder = addFolder(store, options.name, options.parent ?? null)
      saveStore(home, store)
      return { ok: true, text: `已新建文件夹「${folder.name}」`, folder }
    }

    if (action === 'rename-folder') {
      const { store } = loadStore(home)
      const folder = renameFolder(store, options.folder, options.name)
      saveStore(home, store)
      return { ok: true, text: `已重命名为「${folder.name}」`, folder }
    }

    if (action === 'move-folder') {
      const { store } = loadStore(home)
      const folder = setFolderParent(store, options.folder, options.parent ?? null)
      saveStore(home, store)
      const place = folder.parentId === null
        ? '顶层'
        : `「${store.folders.find(item => item.id === folder.parentId)?.name ?? folder.parentId}」里`
      return { ok: true, text: `已把「${folder.name}」移到${place}`, folder }
    }

    if (action === 'rename-workspace') {
      // 侧栏工作区没有父子字段，只能靠名字与顺序把「一族」排在一起
      const registry = requireRegistry(ctx)
      const target = typeof options.path === 'string' ? options.path.trim() : ''
      const title = typeof options.name === 'string' ? options.name.trim() : ''
      if (target === '' || title === '') throw new Error('需要给出目录路径与新名称')
      const workspace = await registry.resolveByPath(target)
      if (workspace === undefined || workspace === null) throw new Error(`该目录还不是工作区：${target}`)
      await workspace.setTitle(title)
      return { ok: true, text: `已把工作区改名为「${title}」` }
    }

    if (action === 'move-workspace') {
      const registry = requireRegistry(ctx)
      const target = typeof options.path === 'string' ? options.path.trim() : ''
      const before = typeof options.before === 'string' ? options.before.trim() : ''
      if (target === '') throw new Error('需要给出目录路径')
      const workspace = await registry.resolveByPath(target)
      if (workspace === undefined || workspace === null) throw new Error(`该目录还不是工作区：${target}`)
      let beforeId
      if (before !== '') {
        const anchor = await registry.resolveByPath(before)
        if (anchor === undefined || anchor === null) throw new Error(`参照目录还不是工作区：${before}`)
        beforeId = anchor.id
      }
      const order = await registry.insertBefore(workspace.id, beforeId)
      return { ok: true, text: `已调整工作区顺序（共 ${order.length} 个）`, order }
    }

    if (action === 'delete-folder') {
      const { store } = loadStore(home)
      const { detached, promoted } = removeFolder(store, options.folder)
      saveStore(home, store)
      const promotedText = promoted > 0 ? `，${promoted} 个子文件夹已上移一级` : ''
      return {
        ok: true,
        text: `已删除文件夹，${detached} 个会话回到「未分类」${promotedText}`,
        detached,
        promoted,
      }
    }

    if (action === 'reorder-folders') {
      const { store } = loadStore(home)
      const order = reorderFolders(store, options.order)
      saveStore(home, store)
      return { ok: true, text: '已调整顺序', order }
    }

    if (action === 'assign') {
      const { store } = loadStore(home)
      const ids = Array.isArray(options.sessions) && options.sessions.length > 0
        ? options.sessions
        : [options.session]
      let moved = 0
      for (const raw of ids) {
        const sessionId = requireSessionId(raw)
        assignSession(store, sessionId, options.folder === undefined ? null : options.folder)
        moved += 1
      }
      saveStore(home, store)
      const target = options.folder === null || options.folder === undefined || options.folder === ''
        ? '未分类'
        : `「${store.folders.find(item => item.id === options.folder)?.name ?? options.folder}」`
      return { ok: true, text: `已把 ${moved} 个会话移动到${target}`, moved }
    }

    if (action === 'archive' || action === 'unarchive') {
      const sessionId = requireSessionId(options.session)
      const registry = requireRegistry(ctx)
      if (action === 'archive') {
        await registry.archiveSession(sessionId, options.stopActivity === true ? { stopActivity: true } : {})
        return { ok: true, text: '已归档该会话（侧边栏隐藏，可在此面板找回）' }
      }
      await registry.unarchiveSession(sessionId)
      return { ok: true, text: '已取消归档，会话回到原工作区' }
    }

    if (action === 'prune-ghosts') {
      // 清理「磁盘上已不存在」的会话引用：工作区列表、归档集合、投影缓存。
      // 这些残留会让侧栏列出点开就报 session/not-found 的对话。
      const registry = requireRegistry(ctx)
      const sessions = listSessions({ home })
      const known = new Set(sessions.map(item => item.id))
      const knownBare = new Set(sessions.map(item => normalizeSessionId(item.id)))
      const isGhost = (raw) => {
        const text = String(raw ?? '')
        if (text === '') return false
        const withPrefix = text.startsWith('session-') ? text : `session-${text}`
        return known.has(withPrefix) === false && knownBare.has(normalizeSessionId(text)) === false
      }

      const detached = []
      const failed = []
      for (const workspace of registry.list()) {
        const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        for (const raw of ids) {
          if (isGhost(raw) === false) continue
          try {
            await workspace.detachSession(raw)
            detached.push(raw)
          } catch (error) {
            failed.push(`${raw}（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
      }

      let unarchived = 0
      for (const id of archivedIdsOf(home)) {
        if (isGhost(id) === false) continue
        try {
          await registry.unarchiveSession(id)
          unarchived += 1
        } catch {
          // 单个失败不影响其余
        }
      }

      let removedFiles = 0
      const projDir = join(home, 'storages', 'session_projcache', 'sessions')
      try {
        for (const file of readdirSync(projDir)) {
          if (file.endsWith('.json') === false) continue
          if (isGhost(file.replace(/\.json$/u, '')) === false) continue
          rmSync(join(projDir, file), { force: true })
          removedFiles += 1
        }
      } catch {
        // 目录不存在或不可读时跳过
      }

      const parts = [`已清理工作区引用 ${detached.length} 条`]
      if (unarchived > 0) parts.push(`归档标记 ${unarchived} 条`)
      if (removedFiles > 0) parts.push(`投影缓存 ${removedFiles} 个`)
      if (failed.length > 0) parts.push(`${failed.length} 条失败：${failed.slice(0, 3).join('、')}`)
      return {
        ok: failed.length === 0,
        text: parts.join('；'),
        detached: detached.length,
        unarchived,
        removedFiles,
        failed: failed.length,
      }
    }

    if (action === 'create-workspace') {
      // 侧边栏分组来自工作区自己的 sessionIds：目录要注册成工作区，会话还要
      // attach 进去，才会出现在那个分组里。这里两件事一起做，可重复执行。
      const registry = requireRegistry(ctx)
      const wanted = Array.isArray(options.paths) && options.paths.length > 0
        ? options.paths
        : [options.path]
      const sessions = listSessions({ home })
      const created = []
      const attached = []
      const skipped = []
      const failed = []
      const seen = new Set()

      for (const raw of wanted) {
        const path = typeof raw === 'string' ? raw.trim() : ''
        if (path === '') continue
        const key = normalizePath(path)
        if (seen.has(key)) continue
        seen.add(key)

        let workspace
        try {
          workspace = await registry.resolveByPath(path).catch(() => undefined)
          if (workspace === undefined || workspace === null) {
            workspace = await registry.create(path)
            created.push(workspace.title || path)
          }
        } catch (error) {
          failed.push(`${path}（${error instanceof Error ? error.message : String(error)}）`)
          continue
        }

        // 显式点名的会话直接交给服务判断（跨目录时 DSH 会明确拒绝并说明 cwd），
        // 未点名时才按 cwd 自动收集该目录下的会话
        const explicit = Array.isArray(options.sessions) && options.sessions.length > 0
        const wantedIds = explicit
          ? options.sessions
          : sessions.filter(item => normalizePath(item.cwd) === key).map(item => item.id)

        for (const rawId of wantedIds) {
          let sessionId
          try {
            sessionId = requireSessionId(rawId)
          } catch {
            continue
          }
          const row = sessions.find(item => item.id === sessionId)
          if (explicit === false && row !== undefined && normalizePath(row.cwd) !== key) continue
          try {
            await workspace.attachSession(sessionId)
            attached.push(sessionId)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/already|exist|duplicate/iu.test(message)) skipped.push(sessionId)
            else failed.push(`${sessionId}（${message}）`)
          }
        }
      }

      const parts = []
      parts.push(created.length > 0 ? `已新建 ${created.length} 个工作区：${created.join('、')}` : '目录已在工作区中')
      parts.push(`已归入 ${attached.length} 个会话`)
      if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个已在分组里的会话`)
      if (failed.length > 0) parts.push(`${failed.length} 个失败：${failed.slice(0, 3).join('、')}`)
      return {
        ok: failed.length === 0,
        text: parts.join('；'),
        created: created.length,
        attached: attached.length,
        skipped: skipped.length,
        failed: failed.length,
      }
    }

    if (action === 'trash') {
      const ids = Array.isArray(options.sessions) && options.sessions.length > 0
        ? options.sessions
        : [options.session]
      if (ids.length > 1) {
        // 批量删除：逐个进回收站，个别失败不影响其余会话。
        // 「使用中」的会话与单个删除一致——照删，但在结果里点明它们要等 DSH 释放，
        // 不再像以前那样静默跳过（那会让人以为删除没生效）。
        const sessions = listSessions({ home })
        const live = liveSessionIds(ctx)
        const done = []
        const failed = []
        let liveCount = 0
        for (const raw of ids) {
          try {
            const target = matchByPrefix(sessions, raw)
            if (isLiveId(live, target.id)) liveCount += 1
            await releaseReferences(ctx, home, target.id)
            trashSession({ home, root, sessionId: target.id, tuiHome: options.tuiHome })
            forgetAssignment(home, target.id)
            done.push(target.id)
          } catch (error) {
            failed.push(`${String(raw)}（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
        const liveText = liveCount === 0
          ? ''
          : `；其中 ${liveCount} 个仍在使用中，切走或重启 DSH 后才会从侧栏消失`
        const failedText = failed.length === 0
          ? ''
          : `；${failed.length} 个失败：${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}`
        return {
          ok: done.length > 0,
          text: `已移入回收站 ${done.length} 个会话${liveText}${failedText}`,
          trashed: done.length,
          live: liveCount,
          failed: failed.length,
        }
      }
      const sessions = listSessions({ home })
      const target = matchByPrefix(sessions, options.session)
      const live = liveSessionIds(ctx)
      const liveNote = isLiveId(live, target.id)
        ? '\n提示：该会话仍在 DSH 里打开着，侧栏要等你切到别的会话或重启 DSH 后才会彻底消失。'
        : ''
      await releaseReferences(ctx, home, target.id)
      const result = trashSession({ home, root, sessionId: target.id, tuiHome: options.tuiHome })
      forgetAssignment(home, target.id)
      const cleaned = result.cleaned.length > 0 ? `，清理缓存 ${result.cleaned.length} 处` : ''
      return { ok: true, text: `已移入回收站：${target.title || target.id}${cleaned}${liveNote}`, name: result.name }
    }

    if (action === 'purge') {
      if (options.confirm !== true) throw new Error('彻底删除不可恢复，需要确认')
      const sessions = listSessions({ home })
      const target = matchByPrefix(sessions, options.session)
      const liveNote = isLiveId(liveSessionIds(ctx), target.id)
        ? '\n提示：该会话仍在 DSH 里打开着，侧栏要等你切到别的会话或重启 DSH 后才会彻底消失。'
        : ''
      await releaseReferences(ctx, home, target.id)
      const result = purgeSession({ home, root, sessionId: target.id, tuiHome: options.tuiHome })
      forgetAssignment(home, target.id)
      const cleaned = result.cleaned.length > 0 ? `，清理缓存 ${result.cleaned.length} 处` : ''
      return { ok: true, text: `已彻底删除：${target.title || target.id}${cleaned}${liveNote}` }
    }

    if (action === 'trash-list') {
      return { ok: true, text: renderTrash(listTrash({ home })) }
    }

    if (action === 'restore') {
      const result = restoreTrash({ home, name: options.name })
      return { ok: true, text: `已恢复：${result.restoredTo}` }
    }

    if (action === 'empty') {
      if (options.confirm !== true) throw new Error('清空回收站条目不可恢复，需要确认')
      const result = purgeTrash({ home, name: options.name })
      return { ok: true, text: `已清空：${result.path}` }
    }

    if (action === 'list') {
      const sessions = listSessions({ home })
      const limit = options.all === true ? Number.MAX_SAFE_INTEGER : (options.limit ?? DEFAULT_LIMIT)
      const snapshot = buildSnapshot({ home })
      const head = `${root}（${snapshot.total} 个会话，${snapshot.archivedCount} 个已归档）`
      const folders = snapshot.folders.length === 0
        ? '还没有文件夹。'
        : snapshot.folders.map(folder => `  [${folder.name}] ${folder.count} 个`).join('\n')
      return {
        ok: true,
        text: `会话库：${head}\n${folders}\n  [未分类] ${snapshot.unclassified} 个\n\n${renderList(sessions, limit)}`,
      }
    }

    return { ok: false, text: `未知动作：${String(action)}` }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 同步动作（命令用）：只处理不需要等服务的动作。
 *
 * @param options - 同 `runAction`。
 * @returns `{ ok, text }`。
 */
export function runSyncAction(options) {
  const home = options.home ?? resolveDshHome()
  const root = sessionsRootOf(home)
  try {
    if (options.action === 'list') {
      const sessions = listSessions({ home })
      const limit = options.all === true ? Number.MAX_SAFE_INTEGER : (options.limit ?? DEFAULT_LIMIT)
      return { ok: true, text: renderList(sessions, limit) }
    }
    if (options.action === 'trash') {
      const sessions = listSessions({ home })
      const target = matchByPrefix(sessions, options.session)
      removeFromArchiveSet(home, target.id)
      const result = trashSession({ home, root, sessionId: target.id, tuiHome: options.tuiHome })
      forgetAssignment(home, target.id)
      const cleaned = result.cleaned.length > 0 ? `，清理缓存 ${result.cleaned.length} 处` : ''
      return { ok: true, text: `已移入回收站：${target.title || target.id}${cleaned}\n条目名：${result.name}` }
    }
    if (options.action === 'purge') {
      const sessions = listSessions({ home })
      const target = matchByPrefix(sessions, options.session)
      removeFromArchiveSet(home, target.id)
      const result = purgeSession({ home, root, sessionId: target.id, tuiHome: options.tuiHome })
      forgetAssignment(home, target.id)
      const cleaned = result.cleaned.length > 0 ? `，清理缓存 ${result.cleaned.length} 处` : ''
      return { ok: true, text: `已彻底删除：${target.title || target.id}${cleaned}` }
    }
    if (options.action === 'trash-list') {
      return { ok: true, text: renderTrash(listTrash({ home })) }
    }
    if (options.action === 'restore') {
      const result = restoreTrash({ home, name: options.name })
      return { ok: true, text: `已恢复：${result.restoredTo}` }
    }
    if (options.action === 'empty') {
      const result = purgeTrash({ home, name: options.name })
      return { ok: true, text: `已清空：${result.path}` }
    }
    return { ok: false, text: `未知动作：${String(options.action)}` }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解析命令输入。
 *
 * @param raw - 斜杠后的原文。
 * @returns `{ action, sessionId, name, all, error }`。
 */
export function parseCommand(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return { action: 'list', all: false }
  const parts = text.split(/\s+/u)
  const head = parts[0]
  const yes = parts.includes('--yes')
  const rest = parts.slice(1).filter(part => part.startsWith('--') === false)

  if (head === 'all') return { action: 'list', all: true }
  if (head === 'list') return { action: 'list', all: rest.includes('all') }
  if (head === 'trash' || head === 'delete') {
    if (rest.length === 0) return { action: 'list', error: '需要给出会话 id 前缀' }
    return { action: 'trash', sessionId: rest[0] }
  }
  if (head === 'purge' || head === 'rm') {
    if (rest.length === 0) return { action: 'list', error: '需要给出会话 id 前缀' }
    if (yes === false) return { action: 'list', error: '彻底删除不可恢复，请追加 --yes 确认' }
    return { action: 'purge', sessionId: rest[0] }
  }
  if (head === 'trash-list' || head === 'trashls') return { action: 'trash-list' }
  if (head === 'restore') {
    if (rest.length === 0) return { action: 'list', error: '需要给出回收站条目名' }
    return { action: 'restore', name: rest[0] }
  }
  if (head === 'empty') {
    if (rest.length === 0) return { action: 'list', error: '需要给出回收站条目名' }
    if (yes === false) return { action: 'list', error: '清空回收站条目不可恢复，请追加 --yes 确认' }
    return { action: 'empty', name: rest[0] }
  }
  if (/^[A-Za-z0-9-]+$/u.test(head)) return { action: 'trash', sessionId: head }
  return { action: 'list', error: `无法识别的子命令：${head}` }
}

/**
 * 把插件挂到 Host。
 *
 * @param ctx - 挂载上下文。
 * @param rawConfig - Loader 配置。
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  if (config.enabled === false) {
    ctx.logger?.info?.('dsh-session-manage: 已在配置中关闭')
    return
  }
  const home = resolveDshHome(config.dshHome)
  const limit = Number.isFinite(config.limit) ? Math.max(1, Math.min(500, Math.floor(config.limit))) : DEFAULT_LIMIT

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-session-manage',
      name: COMMAND_NAME,
      description: '管理会话：列出、移入回收站、彻底删除、查看与恢复回收站',
      input: { hint: '[all|trash <id>|purge <id> --yes|trash-list|restore <名>|empty <名> --yes]' },
      handler: (invocation) => {
        const parsed = parseCommand(invocation.rawInput)
        if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n\n${USAGE}` }
        const result = runSyncAction({
          home,
          limit,
          action: parsed.action,
          session: parsed.sessionId,
          name: parsed.name,
          all: parsed.all === true,
          confirm: true,
        })
        return { kind: result.ok ? 'success' : 'error', text: result.text }
      },
    })
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: TOOL_NAME,
      description:
        '管理 DSH 会话：列出会话（含标题、工作目录、时间、大小、归档标记），把会话移入回收站，'
        + '或彻底删除、查看回收站、恢复、清空回收站条目。删除前先用 list 让用户确认目标，'
        + '彻底删除必须由用户明确要求。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'trash', 'purge', 'trash-list', 'restore', 'empty'],
            description: 'list 列出｜trash 移入回收站（可恢复）｜purge 彻底删除｜trash-list 看回收站｜restore 恢复｜empty 清空回收站条目',
          },
          session: {
            type: 'string',
            description: '会话 id 或其前缀（session- 前缀可省略），trash/purge 必填',
          },
          name: {
            type: 'string',
            description: '回收站条目名，restore/empty 必填',
          },
          all: {
            type: 'boolean',
            description: 'list 时列出全部会话（默认只列最近的）',
          },
        },
        required: ['action'],
      },
      handler: async (input) => {
        const result = await runAction(ctx, {
          home,
          limit,
          action: input.action,
          session: input.session,
          name: input.name,
          all: input.all === true,
          confirm: true,
        })
        return { content: [{ type: 'text', text: result.text }] }
      },
    })
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: DATA_PATH,
      handler: async (req, res) => {
        if (isLoopbackRequest(req) === false) {
          sendJson(res, 403, { error: '只允许本机访问' })
          return
        }
        // 活跃会话的标题 / append 是 best-effort 落盘，刷新前先把写句柄刷一次，
        // 否则刚改过的标题可能还停在内存里，面板读到的仍是旧值。
        await flushSessions(ctx)
        try {
          sendJson(res, 200, buildSnapshot({ home, live: liveSessionIds(ctx) }))
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'dsh-session-manage: 数据路由')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (isLoopbackRequest(req) === false) {
          sendJson(res, 403, { error: '只允许本机访问' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '请用 POST' })
          return
        }
        const body = await readJsonBody(req)
        if (body.error !== undefined) {
          sendJson(res, 400, { error: body.error })
          return
        }
        const payload = body.value ?? {}
        if ((payload.action === 'purge' || payload.action === 'empty') && payload.confirm !== true) {
          sendJson(res, 400, { error: '彻底删除需要 confirm: true' })
          return
        }
        const result = await runAction(ctx, {
          home,
          limit,
          action: payload.action,
          folder: payload.folder,
          name: payload.name,
          session: payload.session,
          sessions: payload.sessions,
          order: payload.order,
          parent: payload.parent,
          path: payload.path,
          paths: payload.paths,
          before: payload.before,
          stopActivity: payload.stopActivity === true,
          confirm: payload.confirm === true,
        })
        sendJson(res, result.ok ? 200 : 400, result)
      },
    }), 'dsh-session-manage: 动作路由')
  })

  ctx.logger?.info?.(`dsh-session-manage: 已启用（会话目录 ${sessionsRootOf(home)}）`)
}

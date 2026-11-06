/**
 * dsh-session-classify —— 会话回收站：删除、恢复、彻底清除。
 *
 * 这部分能力源自 dsh-session-manager，合并进本插件后仍保持同样的安全约定：
 *
 * - 默认动作是**移入回收站** `<DSH_HOME>/.session-trash/`，随时可恢复；
 * - 彻底删除必须显式动作（HTTP 要 `confirm: true`，命令要 `--yes`）；
 * - 会话 id 与回收站条目名都过白名单正则，路径必须落在会话库 / 回收站之内；
 * - 清理索引前先备份 `.bak-<时间戳>`，写回走临时文件 + rename。
 *
 * @module dsh-session-classify/trash
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** 会话目录名 / 会话 id 的白名单：只允许字母数字与 `._-`。 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** 回收站目录名。 */
export const TRASH_DIR_NAME = '.session-trash'

/** 回收站条目里的清单元数据文件名。 */
const MANIFEST_NAME = '.session-classify.json'

/**
 * 回收站目录。
 *
 * @param home - DSH 主目录。
 * @returns `<home>/.session-trash`。
 */
export function trashRootOf(home) {
  return join(home, TRASH_DIR_NAME)
}

/**
 * 校验会话 id 并解析它的目录。
 *
 * @param root - 会话根目录。
 * @param sessionId - 会话目录名，例如 `session-3f2a…`。
 * @returns `{ dir, cwdSlug }`；非法或不存在时抛错。
 */
export function locateSession(root, sessionId) {
  if (typeof sessionId !== 'string' || SAFE_NAME.test(sessionId) === false) {
    throw new Error(`非法的会话 id：${String(sessionId)}`)
  }
  const base = resolve(root)
  let cwdDirs
  try {
    cwdDirs = readdirSync(base, { withFileTypes: true })
  } catch {
    throw new Error(`会话根目录不存在：${base}`)
  }
  for (const cwdEntry of cwdDirs) {
    if (cwdEntry.isDirectory() === false) continue
    const candidate = join(base, cwdEntry.name, sessionId)
    if (existsSync(candidate) === false) continue
    if (statSync(candidate).isDirectory() === false) continue
    const absolute = resolve(candidate)
    if (absolute.startsWith(base + sep) === false) throw new Error(`会话路径越界：${absolute}`)
    return { dir: absolute, cwdSlug: cwdEntry.name }
  }
  throw new Error(`找不到会话：${sessionId}`)
}

/**
 * 备份并改写一个 JSON 文件。
 *
 * @param path - 目标文件。
 * @param mutate - 接收解析后的对象，返回 true 表示需要写回。
 * @param stamp - 备份后缀。
 * @returns 是否发生写入。
 */
function rewriteJson(path, mutate, stamp) {
  if (existsSync(path) === false) return false
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (mutate(parsed) !== true) return false
  try {
    copyFileSync(path, `${path}.bak-${stamp}`)
  } catch {
    // 备份失败就不写：宁可留条目，也不能弄坏索引
    return false
  }
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(parsed, null, 2), 'utf8')
  renameSync(temp, path)
  return true
}

/**
 * 把会话从「归档集合」里摘掉（`<home>/storages/workspace.json` 的
 * `global.archivedSessionIds`）。
 *
 * 只删除会话目录、不动这份集合的话，侧边栏「归档」栏会继续列出这些
 * 已经不在磁盘上的对话。正常路径优先调用 `workspaceRegistry.unarchiveSession`
 * （服务内存与磁盘一起更新），本函数是同步路径与服务缺席时的兜底。
 *
 * @param home - DSH 主目录。
 * @param sessionId - 会话 id。
 * @returns 是否发生了写入。
 */
export function removeFromArchiveSet(home, sessionId) {
  const file = join(home, 'storages', 'workspace.json')
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = String(sessionId).replace(/^session-/u, '')
  return rewriteJson(file, (value) => {
    const list = value?.global?.archivedSessionIds
    if (Array.isArray(list) === false) return false
    const next = list.filter(id => String(id).replace(/^session-/u, '') !== target)
    if (next.length === list.length) return false
    value.global.archivedSessionIds = next
    return true
  }, stamp)
}

/**
 * 从会话索引里摘掉一个会话。
 *
 * 覆盖两处缓存：TUI 的 `~/.dsh-tui/session-index.json` 与 DSH 的
 * `<home>/storages/session_projcache.json`（外加它的 `sessions/` 子目录）。
 * 这些文件都只是缓存/统计，删条目不影响会话本身。
 *
 * @param options - `{ home, sessionId, tuiHome }`。
 * @returns 清理过的路径列表。
 */
export function cleanIndexes(options) {
  const home = options.home
  const tuiHome = options.tuiHome ?? join(homedir(), '.dsh-tui')
  const sessionId = options.sessionId
  const uuid = String(sessionId).replace(/^session-/u, '')
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const touched = []

  const tuiIndex = join(tuiHome, 'session-index.json')
  if (rewriteJson(tuiIndex, (value) => {
    if (value === null || typeof value !== 'object') return false
    if (value.entries === null || typeof value.entries !== 'object') return false
    if (Object.hasOwn(value.entries, uuid) === false) return false
    delete value.entries[uuid]
    return true
  }, stamp)) touched.push(tuiIndex)

  const projcache = join(home, 'storages', 'session_projcache.json')
  if (rewriteJson(projcache, (value) => {
    const table = value?.tables?.sessions
    if (table === null || typeof table !== 'object') return false
    if (Object.hasOwn(table, sessionId) === false) return false
    delete table[sessionId]
    return true
  }, stamp)) touched.push(projcache)

  const projDir = join(home, 'storages', 'session_projcache', 'sessions', sessionId)
  if (existsSync(projDir)) {
    try {
      rmSync(projDir, { recursive: true, force: true })
      touched.push(projDir)
    } catch {
      // 统计缓存删不掉不影响主流程
    }
  }

  const resumeMarker = join(tuiHome, 'resume.txt')
  if (existsSync(resumeMarker)) {
    try {
      const current = readFileSync(resumeMarker, 'utf8').trim()
      if (current === sessionId || current === uuid) {
        writeFileSync(resumeMarker, '', 'utf8')
        touched.push(resumeMarker)
      }
    } catch {
      // 忽略
    }
  }

  return touched
}

/**
 * 把会话移进回收站。
 *
 * @param options - `{ home, root, sessionId, tuiHome }`。
 * @returns `{ name, path, originalPath, cleaned }`。
 */
export function trashSession(options) {
  const home = options.home
  const located = locateSession(options.root, options.sessionId)
  const trashRoot = trashRootOf(home)
  mkdirSync(trashRoot, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const name = `${stamp}__${options.sessionId}`
  const target = join(trashRoot, name)
  renameSync(located.dir, target)
  writeFileSync(join(target, MANIFEST_NAME), JSON.stringify({
    sessionId: options.sessionId,
    cwdSlug: located.cwdSlug,
    originalPath: located.dir,
    trashedAt: Date.now(),
  }, null, 2), 'utf8')

  const cleaned = cleanIndexes({ home, tuiHome: options.tuiHome, sessionId: options.sessionId })
  return { name, path: target, originalPath: located.dir, cleaned }
}

/**
 * 彻底删除会话（不进回收站）。
 *
 * @param options - `{ home, root, sessionId, tuiHome }`。
 * @returns `{ path, cleaned }`。
 */
export function purgeSession(options) {
  const located = locateSession(options.root, options.sessionId)
  rmSync(located.dir, { recursive: true, force: true })
  const cleaned = cleanIndexes({ home: options.home, tuiHome: options.tuiHome, sessionId: options.sessionId })
  return { path: located.dir, cleaned }
}

/**
 * 列出回收站条目。
 *
 * @param options - `{ home }`。
 * @returns 条目数组，按条目名倒序。
 */
export function listTrash(options) {
  const trashRoot = trashRootOf(options.home)
  let entries
  try {
    entries = readdirSync(trashRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    const dir = join(trashRoot, entry.name)
    let manifest = {}
    try {
      manifest = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
    } catch {
      // 手工塞进来的目录没有 manifest，退化为目录名
    }
    let bytes = 0
    try {
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (file.isFile()) bytes += statSync(join(dir, file.name)).size
      }
    } catch {
      // 忽略
    }
    out.push({
      name: entry.name,
      sessionId: typeof manifest.sessionId === 'string' ? manifest.sessionId : entry.name,
      originalPath: typeof manifest.originalPath === 'string' ? manifest.originalPath : '',
      trashedAt: typeof manifest.trashedAt === 'number' ? manifest.trashedAt : 0,
      bytes,
    })
  }
  out.sort((a, b) => b.name.localeCompare(a.name))
  return out
}

/**
 * 从回收站恢复一个会话。
 *
 * @param options - `{ home, name }`。
 * @returns `{ restoredTo }`。
 */
export function restoreTrash(options) {
  const home = options.home
  const name = options.name
  if (typeof name !== 'string' || SAFE_NAME.test(name) === false) {
    throw new Error(`非法的回收站条目：${String(name)}`)
  }
  const dir = join(trashRootOf(home), name)
  if (existsSync(dir) === false) throw new Error(`回收站里没有：${name}`)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
  } catch {
    throw new Error(`条目缺少 manifest，无法确定原位置：${name}`)
  }
  const originalPath = manifest.originalPath
  if (typeof originalPath !== 'string' || originalPath.length === 0) {
    throw new Error(`条目缺少 originalPath：${name}`)
  }
  const sessionsRoot = resolve(join(home, 'sessions'))
  if (resolve(originalPath).startsWith(sessionsRoot + sep) === false) {
    throw new Error(`恢复目标越界：${originalPath}`)
  }
  if (existsSync(originalPath)) throw new Error(`原位置已被占用：${originalPath}`)

  mkdirSync(dirname(originalPath), { recursive: true })
  rmSync(join(dir, MANIFEST_NAME), { force: true })
  renameSync(dir, originalPath)
  return { restoredTo: originalPath }
}

/**
 * 彻底清空回收站里的一个条目。
 *
 * @param options - `{ home, name }`。
 * @returns `{ path }`。
 */
export function purgeTrash(options) {
  const name = options.name
  if (typeof name !== 'string' || SAFE_NAME.test(name) === false) {
    throw new Error(`非法的回收站条目：${String(name)}`)
  }
  const dir = join(trashRootOf(options.home), name)
  if (existsSync(dir) === false) throw new Error(`回收站里没有：${name}`)
  rmSync(dir, { recursive: true, force: true })
  return { path: dir }
}

/**
 * 按 id 前缀匹配会话，供命令行输入用。
 *
 * @param sessions - `listSessions` 的结果。
 * @param prefix - id 或 id 前缀。
 * @returns 唯一匹配的会话；没有或多于一个时抛错并列出候选。
 */
export function matchByPrefix(sessions, prefix) {
  const needle = String(prefix ?? '').trim()
  if (needle.length === 0) throw new Error('请给出会话 id（或其前缀）')
  const hits = sessions.filter(session =>
    session.id === needle
    || session.id.startsWith(needle)
    || session.id.replace(/^session-/u, '').startsWith(needle))
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) throw new Error(`没有匹配的会话：${needle}`)
  const list = hits.slice(0, 6).map(hit => `${hit.id} — ${hit.title || '（无标题）'}`).join('\n')
  throw new Error(`前缀「${needle}」匹配到 ${hits.length} 个会话，请写长一点：\n${list}`)
}

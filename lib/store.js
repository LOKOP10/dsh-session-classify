/**
 * dsh-session-classify —— 分类（文件夹）数据的持久化。
 *
 * ## 存放位置
 *
 * `<DSH_HOME>/storages/dsh-classify.json`，与 DSH 自己的 storages 同级：
 *
 * ```json
 * {
 *   "version": 1,
 *   "folders": [{ "id": "f-1a2b3c4d", "name": "抖音下载器", "createdAt": "..." }],
 *   "assignments": { "session-xxxx": "f-1a2b3c4d" }
 * }
 * ```
 *
 * ## 安全约定
 *
 * - 只写自己这个文件，绝不改 DSH 的会话库与 workspace.json；
 * - 写回走「备份 → 临时文件 → rename」，任何一步失败都保持原文件；
 * - 读到坏数据时按空表处理并在结果里标记，不抛异常把面板打空。
 *
 * 本模块零外部依赖，只用 `node:` 内置模块。
 *
 * @module dsh-session-classify/store
 */

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** 数据格式版本：字段或语义变化时递增。 */
export const STORE_VERSION = 1

/** 文件夹名最大长度。 */
export const FOLDER_NAME_LIMIT = 40

/** 文件夹 id 白名单。 */
const SAFE_FOLDER_ID = /^f-[0-9a-f]{8}$/u

/**
 * 分类数据文件路径。
 *
 * @param home - DSH 主目录。
 * @returns `<home>/storages/dsh-classify.json`。
 */
export function storePathOf(home) {
  return join(home, 'storages', 'dsh-classify.json')
}

/**
 * 空表。
 *
 * @returns 空的分类数据。
 */
export function emptyStore() {
  return { version: STORE_VERSION, folders: [], assignments: {} }
}

/**
 * 规整文件夹名：去首尾空白、压空白、去控制字符。
 *
 * @param raw - 用户输入。
 * @returns 规整后的名字；不合法时抛错。
 */
export function normalizeFolderName(raw) {
  if (typeof raw !== 'string') throw new Error('文件夹名必须是字符串')
  const name = raw.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (name.length === 0) throw new Error('文件夹名不能为空')
  if (name.length > FOLDER_NAME_LIMIT) throw new Error(`文件夹名最长 ${FOLDER_NAME_LIMIT} 个字符`)
  return name
}

/**
 * 校验并收敛读到的数据。
 *
 * @param raw - 解析后的 JSON。
 * @returns `{ store, damaged }`：`damaged` 表示丢弃过非法条目。
 */
export function sanitizeStore(raw) {
  const store = emptyStore()
  let damaged = false
  if (raw === null || typeof raw !== 'object') return { store, damaged: true }

  const seen = new Set()
  if (Array.isArray(raw.folders)) {
    for (const folder of raw.folders) {
      if (folder === null || typeof folder !== 'object') { damaged = true; continue }
      const id = typeof folder.id === 'string' ? folder.id.trim() : ''
      if (SAFE_FOLDER_ID.test(id) === false || seen.has(id)) { damaged = true; continue }
      let name
      try {
        name = normalizeFolderName(folder.name)
      } catch {
        damaged = true
        continue
      }
      seen.add(id)
      store.folders.push({
        id,
        name,
        parentId: typeof folder.parentId === 'string' && folder.parentId.length > 0 ? folder.parentId : null,
        createdAt: typeof folder.createdAt === 'string' ? folder.createdAt : new Date().toISOString(),
      })
    }
  } else if (raw.folders !== undefined) {
    damaged = true
  }

  // 修正父级：必须指向存在且不等于自己的文件夹，并断开任何环
  const byId = new Map(store.folders.map(folder => [folder.id, folder]))
  for (const folder of store.folders) {
    if (folder.parentId === null) continue
    if (byId.has(folder.parentId) === false || folder.parentId === folder.id) {
      folder.parentId = null
      damaged = true
    }
  }
  for (const folder of store.folders) {
    const visited = new Set([folder.id])
    let cursor = folder.parentId
    while (cursor !== null) {
      if (visited.has(cursor)) {
        folder.parentId = null
        damaged = true
        break
      }
      visited.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }

  if (raw.assignments !== null && typeof raw.assignments === 'object' && Array.isArray(raw.assignments) === false) {
    for (const [sessionId, folderId] of Object.entries(raw.assignments)) {
      if (typeof folderId !== 'string' || seen.has(folderId) === false) { damaged = true; continue }
      if (typeof sessionId !== 'string' || sessionId.length === 0) { damaged = true; continue }
      store.assignments[sessionId] = folderId
    }
  } else if (raw.assignments !== undefined) {
    damaged = true
  }

  return { store, damaged }
}

/**
 * 读取分类数据。
 *
 * @param home - DSH 主目录。
 * @returns `{ store, damaged, path }`；文件不存在时是空表。
 */
export function loadStore(home) {
  const path = storePathOf(home)
  if (existsSync(path) === false) return { store: emptyStore(), damaged: false, path }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { store: emptyStore(), damaged: true, path }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { store: emptyStore(), damaged: true, path }
  }
  const { store, damaged } = sanitizeStore(parsed)
  return { store, damaged, path }
}

/**
 * 写回分类数据：先备份，再临时文件 + rename。
 *
 * @param home - DSH 主目录。
 * @param store - 要写入的数据。
 * @returns 写入的文件路径。
 */
export function saveStore(home, store) {
  const path = storePathOf(home)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`)
    } catch {
      // 备份失败不阻断保存：单份 .bak 只是回退手段
    }
  }
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(temp, path)
  return path
}

/**
 * 生成一个新的文件夹 id。
 *
 * @returns `f-` 加 8 位十六进制。
 */
export function newFolderId() {
  return `f-${randomBytes(4).toString('hex')}`
}

/**
 * 新建文件夹（可指定父文件夹，形成「工作区 → 子文件夹」的树）。
 *
 * @param store - 当前数据（原地修改）。
 * @param rawName - 用户输入的名字。
 * @param parentId - 父文件夹 id，null 表示顶层。
 * @returns 新建的文件夹。
 */
export function addFolder(store, rawName, parentId = null) {
  const name = normalizeFolderName(rawName)
  const parent = parentId === null || parentId === undefined || parentId === ''
    ? null
    : String(parentId)
  if (parent !== null && store.folders.some(folder => folder.id === parent) === false) {
    throw new Error(`找不到父文件夹：${parent}`)
  }
  const clash = store.folders.some(folder => folder.name === name && (folder.parentId ?? null) === parent)
  if (clash) throw new Error(`同一层已经有叫「${name}」的文件夹`)
  const folder = { id: newFolderId(), name, parentId: parent, createdAt: new Date().toISOString() }
  store.folders.push(folder)
  return folder
}

/**
 * 重命名文件夹。
 *
 * @param store - 当前数据（原地修改）。
 * @param id - 文件夹 id。
 * @param rawName - 新名字。
 * @returns 修改后的文件夹。
 */
export function renameFolder(store, id, rawName) {
  const folder = store.folders.find(item => item.id === id)
  if (folder === undefined) throw new Error(`找不到文件夹：${String(id)}`)
  const name = normalizeFolderName(rawName)
  const clash = store.folders.some(item =>
    item.id !== id && item.name === name && (item.parentId ?? null) === (folder.parentId ?? null))
  if (clash) throw new Error(`同一层已经有叫「${name}」的文件夹`)
  folder.name = name
  return folder
}

/**
 * 把文件夹挂到另一个文件夹下（`parentId` 为 null 表示移到顶层）。
 *
 * @param store - 当前数据（原地修改）。
 * @param id - 要移动的文件夹。
 * @param parentId - 目标父文件夹 id 或 null。
 * @returns 移动后的文件夹。
 */
export function setFolderParent(store, id, parentId) {
  const folder = store.folders.find(item => item.id === id)
  if (folder === undefined) throw new Error(`找不到文件夹：${String(id)}`)
  const parent = parentId === null || parentId === undefined || parentId === ''
    ? null
    : String(parentId)
  if (parent === id) throw new Error('不能把文件夹移动到它自己下面')
  if (parent !== null) {
    const target = store.folders.find(item => item.id === parent)
    if (target === undefined) throw new Error(`找不到目标文件夹：${parent}`)
    // 防环：目标不能是自己的子孙
    let cursor = target
    const guard = new Set()
    while (cursor !== undefined && cursor.parentId !== null) {
      if (guard.has(cursor.id)) break
      guard.add(cursor.id)
      if (cursor.parentId === id) throw new Error('不能把文件夹移动到它自己的子文件夹里')
      cursor = store.folders.find(item => item.id === cursor.parentId)
    }
    const clash = store.folders.some(item =>
      item.id !== id && item.name === folder.name && (item.parentId ?? null) === parent)
    if (clash) throw new Error(`目标位置已经有叫「${folder.name}」的文件夹`)
  }
  folder.parentId = parent
  return folder
}

/**
 * 删除文件夹；其中的会话回到「未分类」，子文件夹上移到原父级，会话本身不动。
 *
 * @param store - 当前数据（原地修改）。
 * @param id - 文件夹 id。
 * @returns `{ detached, promoted }`：被移出的会话数、被上提的子文件夹数。
 */
export function removeFolder(store, id) {
  const index = store.folders.findIndex(folder => folder.id === id)
  if (index === -1) throw new Error(`找不到文件夹：${String(id)}`)
  const parentId = store.folders[index].parentId ?? null
  store.folders.splice(index, 1)
  let promoted = 0
  for (const folder of store.folders) {
    if (folder.parentId === id) {
      folder.parentId = parentId
      promoted += 1
    }
  }
  let detached = 0
  for (const [sessionId, folderId] of Object.entries(store.assignments)) {
    if (folderId === id) {
      delete store.assignments[sessionId]
      detached += 1
    }
  }
  return { detached, promoted }
}

/**
 * 调整文件夹顺序。
 *
 * @param store - 当前数据（原地修改）。
 * @param order - 文件夹 id 顺序；缺失的按原顺序补齐。
 * @returns 最终顺序。
 */
export function reorderFolders(store, order) {
  if (Array.isArray(order) === false) throw new Error('order 必须是 id 数组')
  const byId = new Map(store.folders.map(folder => [folder.id, folder]))
  const next = []
  for (const id of order) {
    const folder = byId.get(id)
    if (folder === undefined) continue
    next.push(folder)
    byId.delete(id)
  }
  for (const folder of store.folders) {
    if (byId.has(folder.id)) next.push(folder)
  }
  store.folders = next
  return next.map(folder => folder.id)
}

/**
 * 把会话放进文件夹（`folderId` 为 null 表示移出）。
 *
 * @param store - 当前数据（原地修改）。
 * @param sessionId - 会话 id（目录名）。
 * @param folderId - 目标文件夹 id 或 null。
 * @returns 实际写入的文件夹 id 或 null。
 */
export function assignSession(store, sessionId, folderId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('会话 id 不能为空')
  if (folderId === null || folderId === undefined || folderId === '') {
    delete store.assignments[sessionId]
    return null
  }
  if (store.folders.some(folder => folder.id === folderId) === false) {
    throw new Error(`找不到文件夹：${String(folderId)}`)
  }
  store.assignments[sessionId] = folderId
  return folderId
}

/**
 * 统计每个文件夹的会话数与未分类数。
 *
 * @param store - 分类数据。
 * @param knownSessionIds - 仍然存在的会话 id 集合。
 * @returns `{ counts, unclassified }`。
 */
export function countByFolder(store, knownSessionIds) {
  const counts = new Map(store.folders.map(folder => [folder.id, 0]))
  let unclassified = 0
  for (const sessionId of knownSessionIds) {
    const folderId = store.assignments[sessionId]
    if (folderId !== undefined && counts.has(folderId)) counts.set(folderId, counts.get(folderId) + 1)
    else unclassified += 1
  }
  return { counts, unclassified }
}

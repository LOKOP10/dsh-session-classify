/**
 * dsh-session-classify —— 会话枚举、标题提取与归档状态读取。
 *
 * ## 会话库结构
 *
 * DSH 把每个会话写在
 * `<DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.vN.jsonl.zstd`。
 * 文件是**多帧** zstd 流（每帧一次刷盘），Node 的 `zstdDecompressSync` 只认
 * 第一帧，因此这里按魔数逐帧切分后再解压。
 *
 * ## 归档状态
 *
 * 归档集合在 `<DSH_HOME>/storages/workspace.json` 的
 * `global.archivedSessionIds`（元素形如 `session-<uuid>`）。这里只读不写：
 * 改归档状态一律走 `workspaceRegistry` 服务，免得绕开服务内存态。
 *
 * ## 缓存
 *
 * 标题解析要解压整个会话日志，102 个会话全量解析约需数百毫秒。解析结果按
 * 「日志路径 + mtime + size」缓存，文件没变就不再解压。
 *
 * 本模块零外部依赖，只用 `node:` 内置模块。
 *
 * @module dsh-session-classify/sessions
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名，例如 `session.v4.jsonl.zstd`。 */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u

/** 标题最大长度。 */
const TITLE_LIMIT = 60

/** 标题缓存条数上限。 */
const CACHE_LIMIT = 4096

/** 标题缓存：日志路径 → `{ key, title, cwd, createdAt }`。 */
const titleCache = new Map()

/**
 * 解析 DSH 主目录。
 *
 * @param override - 配置中显式指定的目录。
 * @returns 绝对路径：显式配置 > `DSH_HOME` > `~/.dsh`。
 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim().length > 0) return resolve(override.trim())
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * 会话根目录。
 *
 * @param home - DSH 主目录。
 * @returns `<home>/sessions`。
 */
export function sessionsRootOf(home) {
  return join(home, 'sessions')
}

/**
 * 解压多帧 zstd 缓冲区。
 *
 * 魔数可能偶然出现在压缩数据内部，因此某段解压失败时向后找下一个魔数再试；
 * 活跃会话最后一帧写一半也能兜住。
 *
 * @param buffer - 文件内容。
 * @returns 解压后的 UTF-8 文本。
 */
export function decompressFrames(buffer) {
  const offsets = []
  let index = buffer.indexOf(ZSTD_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length)
  }
  if (offsets.length === 0) return ''

  const parts = []
  let start = offsets[0]
  let cursor = 1

  while (start < buffer.length) {
    let end = cursor < offsets.length ? offsets[cursor] : buffer.length
    let text = null
    for (;;) {
      try {
        text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
        break
      } catch {
        if (cursor >= offsets.length) break
        end = cursor + 1 < offsets.length ? offsets[cursor + 1] : buffer.length
        cursor += 1
      }
    }
    if (text === null) break
    parts.push(text)
    start = end
    cursor += 1
    if (cursor > offsets.length) break
  }

  return parts.join('')
}

/**
 * 解析 JSONL 文本，坏行跳过。
 *
 * @param text - JSONL 文本。
 * @returns 事件对象数组。
 */
export function parseJsonl(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 跳过截断行
    }
  }
  return events
}

/**
 * 读取一个会话日志的事件。
 *
 * @param path - 日志文件路径。
 * @returns 事件数组；读取失败时为空数组。
 */
export function readEvents(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return []
  }
  return parseJsonl(decompressFrames(buffer))
}

/**
 * 把消息内容折成一行纯文本。
 *
 * @param content - 字符串或内容块数组。
 * @returns 纯文本；无法识别时为空串。
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ')
  }
  return ''
}

/**
 * 从事件里取会话标题。
 *
 * 会话日志里可能有**多条** `session/title`：标题插件先写一条 fallback，用户
 * 重命名再追加一条，所以这里取**最后一条**（后写覆盖先写）；没有标题事件时
 * 才退回第一条 `user/message`。
 *
 * @param events - 会话事件数组。
 * @returns 单行标题；都取不到时为空串。
 */
export function titleOf(events) {
  let titled = ''
  let fallback = ''
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'session/title') {
      const value = event.data?.title ?? event.data?.text
      if (typeof value === 'string' && value.trim().length > 0) {
        titled = value.trim().replace(/\s+/gu, ' ').slice(0, TITLE_LIMIT)
      }
      continue
    }
    if (fallback === '' && event.type === 'user/message') {
      const text = textOf(event.data?.content ?? event.data?.text ?? event.data?.message?.content)
      if (text.trim().length > 0) fallback = text.trim().replace(/\s+/gu, ' ')
    }
  }
  return titled !== '' ? titled : fallback.slice(0, TITLE_LIMIT)
}

/**
 * 从会话头部事件里取工作目录与创建时间。
 *
 * @param events - 会话事件数组。
 * @returns `{ cwd, createdAt }`。
 */
export function headOf(events) {
  const head = events.find(event => event?.type === 'session')
  return {
    cwd: typeof head?.cwd === 'string' ? head.cwd : '',
    createdAt: typeof head?.createdAt === 'number' ? head.createdAt : 0,
  }
}

/**
 * 把工作目录 slug 还原成路径，仅作显示兜底。
 *
 * `--F-18752-Documents-work--` → `F:\18752\Documents\work`。
 * 盘符之外的还原是近似的（编码不可逆），因此只用于没有 `session` 事件时。
 *
 * @param slug - 目录名。
 * @returns 近似路径。
 */
export function slugToPath(slug) {
  const inner = slug.replace(/^--/u, '').replace(/--$/u, '')
  if (inner.length === 0) return ''
  const restored = inner
    .replace(/~0020/gu, ' ')
    .replace(/-([A-Za-z0-9])/gu, '\\$1')
  const drive = /^([A-Za-z])\\(.*)$/u.exec(restored)
  if (drive !== null) return `${drive[1].toUpperCase()}:\\${drive[2]}`
  return restored
}

/**
 * 读取已归档会话 id 集合。
 *
 * @param home - DSH 主目录。
 * @returns `session-<uuid>` 集合；文件缺失或损坏时为空集。
 */
export function archivedIdsOf(home) {
  const path = join(home, 'storages', 'workspace.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Set()
  }
  const list = parsed?.global?.archivedSessionIds
  if (Array.isArray(list) === false) return new Set()
  return new Set(list.filter(id => typeof id === 'string'))
}

/**
 * 读取已注册为工作区的目录路径集合。
 *
 * 侧边栏是按「会话的 cwd」+ 工作区注册表分组的：目录没注册成工作区，会话就落进
 * 「未分组」。面板要提示 / 补建工作区，就需要这份清单。
 *
 * @param home - DSH 主目录。
 * @returns 规范化的路径集合（小写、去掉尾部分隔符）；文件缺失时为空集。
 */
export function workspacePathsOf(home) {
  const path = join(home, 'storages', 'workspace.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Set()
  }
  const table = parsed?.tables?.workspaces
  if (table === null || typeof table !== 'object') return new Set()
  const out = new Set()
  for (const workspace of Object.values(table)) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (typeof workspace.path !== 'string' || workspace.path.length === 0) continue
    out.add(normalizePath(workspace.path))
  }
  return out
}

/**
 * 读取工作区注册表（含各自的会话列表）。
 *
 * 侧边栏的分组来自工作区自己的 `sessionIds`——**不是**按 cwd 自动归纳的：
 * 目录注册成工作区后，还要把会话 `attachSession` 进去，它才会出现在该分组里。
 * 面板据此判断某个会话是否已经归组。
 *
 * @param home - DSH 主目录。
 * @returns `[{ id, title, path, sessionIds }]`；文件缺失时为空数组。
 */
export function workspacesOf(home) {
  const path = join(home, 'storages', 'workspace.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const table = parsed?.tables?.workspaces
  if (table === null || typeof table !== 'object') return []

  const toRecord = (id, workspace) => {
    if (workspace === null || typeof workspace !== 'object') return undefined
    return {
      id,
      title: typeof workspace.title === 'string' ? workspace.title : '',
      path: typeof workspace.path === 'string' ? workspace.path : '',
      sessionIds: Array.isArray(workspace.sessionIds)
        ? workspace.sessionIds.filter(value => typeof value === 'string')
        : [],
    }
  }

  // 顺序以 global.workspaceIds 为准，和侧边栏显示顺序一致
  const order = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : []
  const out = []
  const seen = new Set()
  for (const id of order) {
    if (typeof id !== 'string' || seen.has(id)) continue
    const record = toRecord(id, table[id])
    if (record === undefined) continue
    seen.add(id)
    out.push(record)
  }
  for (const [id, workspace] of Object.entries(table)) {
    if (seen.has(id)) continue
    const record = toRecord(id, workspace)
    if (record !== undefined) out.push(record)
  }
  return out
}

/**
 * 规范化会话 id：去掉 `session-` 前缀，便于跨来源比较。
 *
 * @param value - 会话 id。
 * @returns 去掉前缀的 id；非法输入为空串。
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^session-/u, '')
}

/**
 * 规范化路径用于比较：小写、`/` 统一成 `\`、去掉尾部分隔符。
 *
 * @param value - 原始路径。
 * @returns 规范化后的字符串。
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/**
 * 取一段会话日志的标题与头部信息（带缓存）。
 *
 * @param logPath - 日志文件路径。
 * @param stat - 该文件的 stat 结果。
 * @returns `{ title, cwd, createdAt }`。
 */
function describeLog(logPath, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`
  const cached = titleCache.get(logPath)
  if (cached !== undefined && cached.key === key) return cached

  const events = readEvents(logPath)
  const head = headOf(events)
  const value = { key, title: titleOf(events), cwd: head.cwd, createdAt: head.createdAt }

  if (titleCache.size >= CACHE_LIMIT && titleCache.has(logPath) === false) {
    const oldest = titleCache.keys().next()
    if (oldest.done !== true) titleCache.delete(oldest.value)
  }
  titleCache.set(logPath, value)
  return value
}

/**
 * 枚举会话。
 *
 * 目录是两层结构：`<cwd-slug>/<session-id>`；同一会话目录里可能同时留着旧版
 * 与新版的日志文件，只保留版本最高的一个。
 *
 * @param options - `{ home, root }`。
 * @returns 会话条目数组，按修改时间倒序，含 `archived` 标记。
 */
export function listSessions(options = {}) {
  const home = options.home ?? resolveDshHome()
  const root = options.root ?? sessionsRootOf(home)
  const archived = archivedIdsOf(home)

  let cwdDirs
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  for (const cwdEntry of cwdDirs) {
    if (cwdEntry.isDirectory() === false) continue
    const cwdPath = join(root, cwdEntry.name)

    let sessionDirs
    try {
      sessionDirs = readdirSync(cwdPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionDirs) {
      if (sessionEntry.isDirectory() === false) continue
      const sessionPath = join(cwdPath, sessionEntry.name)

      let files
      try {
        files = readdirSync(sessionPath, { withFileTypes: true })
      } catch {
        continue
      }

      let best = null
      let bestVersion = -1
      let totalBytes = 0
      for (const file of files) {
        if (file.isFile() === false) continue
        const version = LOG_NAME.exec(file.name)
        if (version === null) continue
        const v = version[1] === undefined ? 0 : Number(version[1])
        try {
          totalBytes += statSync(join(sessionPath, file.name)).size
        } catch {
          // 统计失败不影响枚举
        }
        if (v > bestVersion) {
          bestVersion = v
          best = file.name
        }
      }
      if (best === null) continue

      const logPath = join(sessionPath, best)
      let stat
      try {
        stat = statSync(logPath)
      } catch {
        continue
      }

      const described = describeLog(logPath, stat)
      out.push({
        id: sessionEntry.name,
        cwdSlug: cwdEntry.name,
        cwd: described.cwd !== '' ? described.cwd : slugToPath(cwdEntry.name),
        title: described.title,
        bytes: totalBytes,
        mtimeMs: stat.mtimeMs,
        createdAt: described.createdAt,
        archived: archived.has(sessionEntry.name),
      })
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * dsh-session-manage 自测：不碰真实的 `~/.dsh`。
 *
 * 覆盖：
 * - 分类数据的新建 / 重名 / 重命名 / 删除 / 分配 / 顺序 / 损坏规整；
 * - 会话枚举（多帧 zstd 日志、标题、归档标记）；
 * - 动作层（建文件夹 → 归入 → 删文件夹 → 归档 / 取消归档）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  addFolder,
  assignSession,
  countByFolder,
  emptyStore,
  loadStore,
  normalizeFolderName,
  removeFolder,
  renameFolder,
  reorderFolders,
  sanitizeStore,
  saveStore,
  setFolderParent,
  storePathOf,
} from '../lib/store.js'
import { archivedIdsOf, decompressFrames, listSessions, titleOf } from '../lib/sessions.js'
import { buildSnapshot, parseCommand, runAction, runSyncAction } from '../lib/index.js'

let passed = 0

/**
 * 跑一个测试块。
 *
 * @param label - 用例名。
 * @param fn - 用例体。
 */
async function test(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 造一个临时 DSH 主目录。
 *
 * @returns `{ home, cleanup }`。
 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-manage-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/**
 * 造一个会话（多帧 zstd 日志）。
 *
 * @param home - DSH 主目录。
 * @param cwdSlug - 工作目录 slug。
 * @param sessionId - 会话 id。
 * @param events - 事件数组，逐帧写入。
 * @returns 日志文件路径。
 */
function writeSession(home, cwdSlug, sessionId, events) {
  const dir = join(home, 'sessions', cwdSlug, sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  const frames = events.map(event => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  writeFileSync(path, Buffer.concat(frames))
  return path
}

console.log('dsh-session-manage 自测')

await test('文件夹名规整与校验', () => {
  assert.equal(normalizeFolderName('  抖音   下载器 '), '抖音 下载器')
  assert.throws(() => normalizeFolderName('   '), /不能为空/u)
  assert.throws(() => normalizeFolderName('x'.repeat(41)), /最长/u)
})

await test('新建 / 重名 / 重命名 / 删除文件夹', () => {
  const store = emptyStore()
  const folder = addFolder(store, '项目 A')
  assert.match(folder.id, /^f-[0-9a-f]{8}$/u)
  assert.throws(() => addFolder(store, '项目 A'), /同一层已经有叫/u)

  const renamed = renameFolder(store, folder.id, '项目 B')
  assert.equal(renamed.name, '项目 B')

  assignSession(store, 'session-1', folder.id)
  assignSession(store, 'session-2', folder.id)
  const removed = removeFolder(store, folder.id)
  assert.equal(removed.detached, 2)
  assert.deepEqual(store.assignments, {})
})

await test('层级文件夹：建子文件夹 / 移动 / 防环 / 删父级提子级', () => {
  const store = emptyStore()
  const plugin = addFolder(store, 'plugin')
  const classify = addFolder(store, 'classify', plugin.id)
  const token = addFolder(store, 'token', plugin.id)
  assert.equal(classify.parentId, plugin.id)
  assert.equal(token.parentId, plugin.id)
  // 不同层可以同名
  addFolder(store, 'src', plugin.id)
  addFolder(store, 'src', classify.id)

  // 防环：不能移到自己或自己的子文件夹下
  assert.throws(() => setFolderParent(store, plugin.id, plugin.id), /自己下面/u)
  assert.throws(() => setFolderParent(store, plugin.id, classify.id), /子文件夹/u)

  // 移到顶层 / 换父级
  setFolderParent(store, token.id, null)
  assert.equal(store.folders.find(item => item.id === token.id).parentId, null)
  setFolderParent(store, token.id, plugin.id)

  // 删父级：子文件夹上提，会话回未分类
  assignSession(store, 'session-x', classify.id)
  const removed = removeFolder(store, plugin.id)
  assert.equal(removed.promoted, 3)
  assert.equal(removed.detached, 0)
  assert.equal(store.folders.find(item => item.id === classify.id).parentId, null)
  assert.ok(store.assignments['session-x'])
})

await test('分配会话并统计', () => {
  const store = emptyStore()
  const a = addFolder(store, 'A')
  const b = addFolder(store, 'B')
  assignSession(store, 'session-1', a.id)
  assignSession(store, 'session-2', b.id)
  assignSession(store, 'session-3', null)
  const { counts, unclassified } = countByFolder(store, new Set(['session-1', 'session-2', 'session-3']))
  assert.equal(counts.get(a.id), 1)
  assert.equal(counts.get(b.id), 1)
  assert.equal(unclassified, 1)
  assert.throws(() => assignSession(store, 'session-4', 'f-deadbeef'), /找不到文件夹/u)
})

await test('文件夹顺序可调', () => {
  const store = emptyStore()
  const a = addFolder(store, 'A')
  const b = addFolder(store, 'B')
  const c = addFolder(store, 'C')
  const order = reorderFolders(store, [c.id, a.id])
  assert.deepEqual(order, [c.id, a.id, b.id])
})

await test('损坏数据被规整而不是崩溃', () => {
  const { store, damaged } = sanitizeStore({
    version: 1,
    folders: [{ id: 'bad-id', name: 'x' }, { id: 'f-1234abcd', name: '好' }],
    assignments: { 'session-1': 'f-1234abcd', 'session-2': 'missing' },
  })
  assert.equal(damaged, true)
  assert.equal(store.folders.length, 1)
  assert.deepEqual(store.assignments, { 'session-1': 'f-1234abcd' })
})

await test('保存与读取往返', () => {
  const { home, cleanup } = makeHome()
  try {
    const store = emptyStore()
    const folder = addFolder(store, '往返')
    assignSession(store, 'session-abc', folder.id)
    saveStore(home, store)
    const loaded = loadStore(home)
    assert.equal(loaded.damaged, false)
    assert.equal(loaded.store.folders[0].name, '往返')
    assert.equal(loaded.store.assignments['session-abc'], folder.id)
    assert.equal(loaded.path, storePathOf(home))
  } finally {
    cleanup()
  }
})

await test('多帧 zstd 解压与标题提取', () => {
  const { home, cleanup } = makeHome()
  try {
    const path = writeSession(home, '--tmp--', 'session-abc', [
      { type: 'session', cwd: 'T:\\tmp', createdAt: 1000 },
      { type: 'user/message', data: { content: '帮我把这个项目分类' } },
      { type: 'session/title', data: { title: 'Session Manage插件' } },
    ])
    const text = decompressFrames(readFileSync(path))
    assert.match(text, /Session Manage插件/u)
    const events = text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(titleOf(events), 'Session Manage插件')
  } finally {
    cleanup()
  }
})

await test('重命名后标题取最后一条 title 事件', () => {
  const events = [
    { type: 'session/title', data: { title: '写一个插件，可以对工作区会', source: { kind: 'fallback' } } },
    { type: 'user/message', data: { content: '帮我改个名字' } },
    { type: 'session/title', data: { title: '会话管理插件', source: { kind: 'user' } } },
  ]
  assert.equal(titleOf(events), '会话管理插件')
})

await test('会话枚举带归档标记', () => {
  const { home, cleanup } = makeHome()
  try {
    writeSession(home, '--F-18752-Documents-a--', 'session-aaa', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 1 },
      { type: 'user/message', data: { content: '第一句' } },
    ])
    writeSession(home, '--F-18752-Documents-b--', 'session-bbb', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\b', createdAt: 2 },
      { type: 'session/title', data: { title: '第二个' } },
    ])
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: ['session-bbb'] },
    }))

    assert.deepEqual([...archivedIdsOf(home)], ['session-bbb'])
    const sessions = listSessions({ home })
    assert.equal(sessions.length, 2)
    const byId = new Map(sessions.map(item => [item.id, item]))
    assert.equal(byId.get('session-aaa').title, '第一句')
    assert.equal(byId.get('session-aaa').cwd, 'F:\\18752\\Documents\\a')
    assert.equal(byId.get('session-aaa').archived, false)
    assert.equal(byId.get('session-bbb').archived, true)
  } finally {
    cleanup()
  }
})

await test('动作层：建文件夹 → 归入 → 删文件夹', async () => {
  const { home, cleanup } = makeHome()
  try {
    writeSession(home, '--F-18752-Documents-a--', 'session-aaa', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 1 },
      { type: 'session/title', data: { title: '被分类的会话' } },
    ])
    const ctx = { get: () => undefined }

    const created = await runAction(ctx, { home, action: 'create-folder', name: '工作' })
    assert.equal(created.ok, true)
    const folderId = created.folder.id

    const assigned = await runAction(ctx, { home, action: 'assign', session: 'session-aaa', folder: folderId })
    assert.equal(assigned.ok, true)

    const renamed = await runAction(ctx, { home, action: 'rename-folder', folder: folderId, name: '工作事项' })
    assert.equal(renamed.ok, true)

    const listed = await runAction(ctx, { home, action: 'list' })
    assert.match(listed.text, /工作事项/u)

    const removed = await runAction(ctx, { home, action: 'delete-folder', folder: folderId })
    assert.equal(removed.ok, true)
    assert.equal(removed.detached, 1)
  } finally {
    cleanup()
  }
})

await test('动作层：归档走 workspaceRegistry', async () => {
  const { home, cleanup } = makeHome()
  try {
    const calls = []
    const registry = {
      async archiveSession(sessionId, options) { calls.push(['archive', sessionId, options]) },
      async unarchiveSession(sessionId) { calls.push(['unarchive', sessionId]) },
    }
    const ctx = { get: name => (name === 'workspaceRegistry' ? registry : undefined) }

    const archived = await runAction(ctx, { home, action: 'archive', session: 'session-aaa' })
    assert.equal(archived.ok, true)
    const forced = await runAction(ctx, { home, action: 'archive', session: 'session-aaa', stopActivity: true })
    assert.equal(forced.ok, true)
    const back = await runAction(ctx, { home, action: 'unarchive', session: 'session-aaa' })
    assert.equal(back.ok, true)

    assert.deepEqual(calls, [
      ['archive', 'session-aaa', {}],
      ['archive', 'session-aaa', { stopActivity: true }],
      ['unarchive', 'session-aaa'],
    ])

    const noRegistry = await runAction({ get: () => undefined }, { home, action: 'archive', session: 'session-aaa' })
    assert.equal(noRegistry.ok, false)
    assert.match(noRegistry.text, /workspaceRegistry/u)
  } finally {
    cleanup()
  }
})

await test('非法会话 id 被拒绝', async () => {
  const { home, cleanup } = makeHome()
  try {
    const result = await runAction({ get: () => undefined }, { home, action: 'assign', session: '../evil', folder: null })
    assert.equal(result.ok, false)
    assert.match(result.text, /非法的会话 id/u)
  } finally {
    cleanup()
  }
})

await test('回收站：移入 → 列出 → 恢复', async () => {
  const { home, cleanup } = makeHome()
  try {
    const sessionDir = join(home, 'sessions', '--F-18752-Documents-a--', 'session-aaa')
    writeSession(home, '--F-18752-Documents-a--', 'session-aaa', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 1 },
      { type: 'session/title', data: { title: '要删除的会话' } },
    ])
    const ctx = { get: () => undefined }

    // 先归入文件夹，删除后归属应一并消失
    const created = await runAction(ctx, { home, action: 'create-folder', name: '临时' })
    await runAction(ctx, { home, action: 'assign', session: 'session-aaa', folder: created.folder.id })

    const trashed = await runAction(ctx, { home, action: 'trash', session: 'session-aaa' })
    assert.equal(trashed.ok, true)
    assert.equal(existsSync(sessionDir), false)
    const { store } = loadStore(home)
    assert.equal(Object.hasOwn(store.assignments, 'session-aaa'), false)

    const listed = await runAction(ctx, { home, action: 'trash-list' })
    assert.match(listed.text, /session-aaa/u)

    const restored = await runAction(ctx, { home, action: 'restore', name: trashed.name })
    assert.equal(restored.ok, true)
    assert.equal(existsSync(sessionDir), true)
  } finally {
    cleanup()
  }
})

await test('删除会话会把它从归档集合里摘掉', async () => {
  const { home, cleanup } = makeHome()
  try {
    for (const id of ['session-arc1', 'session-arc2']) {
      writeSession(home, '--F-18752-Documents-a--', id, [
        { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 40 },
        { type: 'session/title', data: { title: id } },
      ])
    }
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: ['session-arc1', 'session-arc2', 'session-keep'] },
      tables: { workspaces: {} },
    }))

    // 服务缺席 → 走改文件兜底
    const trashed = await runAction({ get: () => undefined }, { home, action: 'trash', session: 'session-arc1' })
    assert.equal(trashed.ok, true)
    let after = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(after.global.archivedSessionIds, ['session-arc2', 'session-keep'])

    // 服务可用 → 走 unarchiveSession，服务内存与磁盘一起更新
    const unarchived = []
    const ctx = {
      get: name => (name === 'workspaceRegistry'
        ? { unarchiveSession: async (id) => { unarchived.push(id) } }
        : undefined),
    }
    const purged = await runAction(ctx, { home, action: 'purge', session: 'session-arc2', confirm: true })
    assert.equal(purged.ok, true)
    assert.deepEqual(unarchived, ['session-arc2'], '服务可用时交给 unarchiveSession 处理')

    // 删除前还要把它从所属工作区的 sessionIds 里摘掉
    const detached = []
    const ctx3 = {
      get: name => (name === 'workspaceRegistry'
        ? {
            unarchiveSession: async () => {},
            list: () => [{
              title: 'demo',
              sessionIds: ['session-arc3'],
              detachSession: async (id) => { detached.push(id) },
            }],
          }
        : undefined),
    }
    writeSession(home, '--F-18752-Documents-a--', 'session-arc3', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 41 },
      { type: 'session/title', data: { title: '第三个' } },
    ])
    const removed = await runAction(ctx3, { home, action: 'trash', session: 'session-arc3' })
    assert.equal(removed.ok, true)
    assert.deepEqual(detached, ['session-arc3'], '删除前要从工作区列表摘掉引用')
  } finally {
    cleanup()
  }
})

await test('批量删除：一次移入多个会话，个别失败不影响其余', async () => {
  const { home, cleanup } = makeHome()
  try {
    for (const id of ['session-b1', 'session-b2', 'session-b3']) {
      writeSession(home, '--F-18752-Documents-b--', id, [
        { type: 'session', cwd: 'F:\\18752\\Documents\\b', createdAt: 10 },
        { type: 'session/title', data: { title: id } },
      ])
    }
    const ctx = { get: () => undefined }

    const all = await runAction(ctx, {
      home,
      action: 'trash',
      sessions: ['session-b1', 'session-b2', 'session-b3'],
    })
    assert.equal(all.ok, true)
    assert.equal(all.trashed, 3)
    assert.equal(all.failed, 0)
    for (const id of ['session-b1', 'session-b2', 'session-b3']) {
      assert.equal(existsSync(join(home, 'sessions', '--F-18752-Documents-b--', id)), false)
    }

    writeSession(home, '--F-18752-Documents-b--', 'session-b4', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\b', createdAt: 11 },
      { type: 'session/title', data: { title: '第四个' } },
    ])
    const partial = await runAction(ctx, {
      home,
      action: 'trash',
      sessions: ['session-b4', 'session-nope'],
    })
    assert.equal(partial.ok, true)
    assert.equal(partial.trashed, 1)
    assert.equal(partial.failed, 1)
    assert.match(partial.text, /1 个失败/u)

    // 「使用中」的会话也照删（与单个删除一致），只在结果里点明它们要等 DSH 释放
    writeSession(home, '--F-18752-Documents-b--', 'session-b5', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\b', createdAt: 12 },
      { type: 'session/title', data: { title: '正在用' } },
    ])
    writeSession(home, '--F-18752-Documents-b--', 'session-b6', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\b', createdAt: 13 },
      { type: 'session/title', data: { title: '闲置的' } },
    ])
    const liveCtx = { get: name => (name === 'agents' ? { list: () => [{ id: 'session-b5' }] } : undefined) }
    const removed = await runAction(liveCtx, {
      home,
      action: 'trash',
      sessions: ['session-b5', 'session-b6'],
    })
    assert.equal(removed.ok, true)
    assert.equal(removed.trashed, 2, '使用中的会话也要真的删掉')
    assert.equal(removed.live, 1)
    assert.match(removed.text, /其中 1 个仍在使用中/u)
    assert.equal(existsSync(join(home, 'sessions', '--F-18752-Documents-b--', 'session-b5')), false)
  } finally {
    cleanup()
  }
})

await test('彻底删除与清空回收站都需要确认', async () => {
  const { home, cleanup } = makeHome()
  try {
    const sessionDir = join(home, 'sessions', '--F-18752-Documents-a--', 'session-bbb')
    writeSession(home, '--F-18752-Documents-a--', 'session-bbb', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 2 },
      { type: 'session/title', data: { title: '第二个' } },
    ])
    const ctx = { get: () => undefined }

    const refused = await runAction(ctx, { home, action: 'purge', session: 'session-bbb' })
    assert.equal(refused.ok, false)
    assert.match(refused.text, /确认/u)
    assert.equal(existsSync(sessionDir), true)

    const purged = await runAction(ctx, { home, action: 'purge', session: 'session-bbb', confirm: true })
    assert.equal(purged.ok, true)
    assert.equal(existsSync(sessionDir), false)

    const trashed = await runAction(ctx, { home, action: 'trash', session: 'session-aaa' })
    assert.equal(trashed.ok, false, '会话已删，不该还能移入回收站')

    writeSession(home, '--F-18752-Documents-a--', 'session-ccc', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 3 },
      { type: 'session/title', data: { title: '第三个' } },
    ])
    const entry = await runAction(ctx, { home, action: 'trash', session: 'session-ccc' })
    assert.equal(entry.ok, true)
    const emptyRefused = await runAction(ctx, { home, action: 'empty', name: entry.name })
    assert.equal(emptyRefused.ok, false)
    const emptied = await runAction(ctx, { home, action: 'empty', name: entry.name, confirm: true })
    assert.equal(emptied.ok, true)
  } finally {
    cleanup()
  }
})

await test('把未分组的会话归入工作区', async () => {
  const { home, cleanup } = makeHome()
  try {
    writeSession(home, '--F-18752-Documents-plugin--', 'session-w1', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\plugin', createdAt: 20 },
      { type: 'session/title', data: { title: '中文' } },
    ])
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      global: {},
      tables: { workspaces: { 'ws-1': { path: 'F:\\18752\\Documents\\a', title: 'a', sessionIds: [] } } },
    }))

    // 快照里带上「已注册工作区目录」与每个会话的归组状态
    const { buildSnapshot } = await import('../lib/index.js')
    const snapshot = buildSnapshot({ home })
    assert.equal(snapshot.workspacePaths.length, 1)
    assert.match(snapshot.workspacePaths[0], /documents\\a/iu)
    assert.equal(snapshot.sessions[0].workspace, null, '尚未归组的会话应为 null')

    const calls = []
    const attached = []
    const workspace = {
      title: 'plugin',
      async attachSession(sessionId) { attached.push(sessionId) },
    }
    const ctx = {
      get: name => (name === 'workspaceRegistry'
        ? {
            resolveByPath: async (path) => (path.endsWith('plugin') ? undefined : workspace),
            create: async (path) => { calls.push(path); return workspace },
          }
        : undefined),
    }

    const created = await runAction(ctx, {
      home,
      action: 'create-workspace',
      path: 'F:\\18752\\Documents\\plugin',
      sessions: ['session-w1'],
    })
    assert.equal(created.ok, true)
    assert.equal(created.created, 1)
    assert.deepEqual(calls, ['F:\\18752\\Documents\\plugin'])
    assert.deepEqual(attached, ['session-w1'])

    // 目录已注册：不再 create，但仍然 attach（幂等重试）
    const again = await runAction(ctx, {
      home,
      action: 'create-workspace',
      paths: ['F:\\18752\\Documents\\a'],
    })
    assert.equal(again.ok, true)
    assert.equal(again.created, 0)
    assert.equal(calls.length, 1, '已注册的目录不该再调用 create')
  } finally {
    cleanup()
  }
})

await test('命令解析与同步动作', async () => {
  const { home, cleanup } = makeHome()
  try {
    writeSession(home, '--F-18752-Documents-a--', 'session-ddd', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 4 },
      { type: 'session/title', data: { title: '命令会话' } },
    ])
    assert.equal(parseCommand('all').all, true)
    assert.equal(parseCommand('purge abc').error !== undefined, true)
    assert.equal(parseCommand('purge abc --yes').action, 'purge')

    const listed = runSyncAction({ home, action: 'list', all: true })
    assert.equal(listed.ok, true)
    assert.match(listed.text, /命令会话/u)

    const trashed = runSyncAction({ home, action: 'trash', session: 'session-ddd' })
    assert.equal(trashed.ok, true)
    const listedTrash = runSyncAction({ home, action: 'trash-list' })
    assert.match(listedTrash.text, /session-ddd/u)
  } finally {
    cleanup()
  }
})

await test('改名兼容：旧数据文件与旧回收站清单仍能读', async () => {
  const { home, cleanup } = makeHome()
  try {
    // 旧版数据文件名（dsh-session-classify 时期）应当仍能读到
    const legacy = join(home, 'storages', 'dsh-classify.json')
    writeFileSync(legacy, JSON.stringify({
      version: 1,
      folders: [{ id: 'f-11112222', name: '旧文件夹', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }],
      assignments: {},
    }))
    const loaded = loadStore(home)
    assert.equal(loaded.store.folders.length, 1, '旧文件应被读到')
    assert.equal(loaded.store.folders[0].name, '旧文件夹')
    assert.equal(loaded.path, legacy)

    // 保存一律落到新文件名，旧文件不迁移也不删除
    saveStore(home, loaded.store)
    assert.equal(existsSync(storePathOf(home)), true, '新文件名应被写入')
    assert.equal(existsSync(legacy), true, '旧文件不该被删除')
    assert.equal(loadStore(home).store.folders.length, 1)

    // 旧回收站条目的清单名也应能读、能恢复
    writeSession(home, '--F-18752-Documents-a--', 'session-legacy', [
      { type: 'session', cwd: 'F:\\18752\\Documents\\a', createdAt: 30 },
      { type: 'session/title', data: { title: '旧的' } },
    ])
    const entry = await runAction({ get: () => undefined }, { home, action: 'trash', session: 'session-legacy' })
    assert.equal(entry.ok, true)
    // 把新清单改回旧名字，模拟改名之前进回收站的条目
    const manifestDir = join(home, '.session-trash', entry.name)
    const renamed = readFileSync(join(manifestDir, '.session-manage.json'), 'utf8')
    rmSync(join(manifestDir, '.session-manage.json'))
    writeFileSync(join(manifestDir, '.session-classify.json'), renamed)

    const list = runSyncAction({ home, action: 'trash-list' })
    assert.match(list.text, /session-legacy/u, '旧清单的条目应出现在列表里')
    const restored = runAction({ get: () => undefined }, { home, action: 'restore', name: entry.name })
    const done = await restored
    assert.equal(done.ok, true, done.text)
    assert.equal(existsSync(join(home, 'sessions', '--F-18752-Documents-a--', 'session-legacy')), true)
  } finally {
    cleanup()
  }
})

console.log(`全部通过：${passed} 项`)

# dsh-session-classify

用**文件夹**给 DeepSeek Harness 的会话自行分类，并顺手管理它们的去留：归档的对话、要删的对话，都在同一个面板里。

本插件是 `dsh-session-classify` 与 `dsh-session-manager` 的合并体——后者已不再需要，删除会话、回收站、恢复这些能力都在这里。

## 功能

**分类（工作区树）**

左栏不再是自己建的文件夹，而是**和侧边栏一致的工作区树**：

- 树按工作区目录的层级自动分层：`plugin` 下面直接挂 `plugin/classify`、`plugin/token` 等子工作区，可折叠（▾/▸）；
- 点某个工作区 → 右栏只显示该工作区里的对话，右侧顶部还会给出它的子工作区卡片，方便逐层下钻；
- 另有「全部会话」与「未归组」两个范围：未归组的会话在该行点「归入工作区」即可（目录不是工作区时会自动补建并挂入）；
- 列表默认包含**已归档**的对话，标「已归档」徽章，可一键取消归档找回；
- 搜索（标题 / 工作区 / id）与「全部 / 未归档 / 已归档」筛选。

> 旧版本的自建文件夹数据仍留在 `<DSH_HOME>/storages/dsh-classify.json` 里，但界面不再使用，也不影响任何会话。

**会话管理**

- 每行「⋯」展开操作区：重命名（写回会话标题）、打开、归档 / 取消归档、删除、「彻底删除」。
- **批量操作**：列表上方常驻「全选」（选当前范围 / 筛选下的全部会话），选中后可批量删除（二次确认，自动跳过正在使用的会话）；未归组的会话还能批量「归入工作区」。
- **删除默认进回收站** `<DSH_HOME>/.session-trash/`，左栏「回收站」里可**恢复**或**彻底清除**；彻底清除与彻底删除都要二次确认。
- 删除会一并清理索引缓存（`session_projcache.json`、`~/.dsh-tui/session-index.json`）、归档标记与工作区引用，避免侧栏留下点开报 `not-found` 的残影。
- 斜杠命令 `/sessions`：列表、移入回收站、彻底删除、查看与恢复回收站。
- 模型工具 `session_manage`：对 Agent 说「把这个对话删了」，由它先列出来再删。

## 安装

本地插件（junction 链接，改代码即时热重载）：

```sh
dsh plugin --profile <profile> add F:/18752/Documents/plugin/classify
```

装完重启 DSH，然后**刷新一次页面**（Ctrl+R），侧边栏出现「会话分类」图标。

> 改了 `lib/client.js` 之后同样需要刷新页面或重启 DSH；宿主半侧（`lib/index.js`）的热重载取决于 profile 里 `hmr.root` 是否包含本目录。

## 用法

### 面板

侧边栏点「会话分类」：

- **左栏**：全部会话 / 未分类 / 各文件夹 / 回收站。
- **右栏**：会话行。勾选框用于批量；「⋯」展开后可移入文件夹、重命名、打开、归档、删除、彻底删除。
- **回收站**：每行显示原位置与大小，可「恢复」或「彻底清除」。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 列出最近会话（按工作区） |
| `/sessions all` | 列出全部会话 |
| `/sessions trash <id前缀>` | 移入回收站 |
| `/sessions purge <id前缀> --yes` | 彻底删除 |
| `/sessions trash-list` | 查看回收站 |
| `/sessions restore <条目名>` | 从回收站恢复 |
| `/sessions empty <条目名> --yes` | 清空回收站条目 |

id 前缀就是列表里显示的 8 位；`session-` 前缀可省略，且必须唯一匹配。

### 工具

模型可调用 `session_manage`：`action` 取 `list` / `trash` / `purge` / `trash-list` / `restore` / `empty`，配合 `session` 或 `name`。

## 数据放在哪

| 数据 | 位置 | 谁写 |
| --- | --- | --- |
| 文件夹与归入关系 | `<DSH_HOME>/storages/dsh-classify.json` | 本插件（备份 `.bak`） |
| 会话正文 | `<DSH_HOME>/sessions/<cwd-slug>/<session-id>/` | DSH |
| 归档集合 | `<DSH_HOME>/storages/workspace.json` 的 `global.archivedSessionIds` | DSH（本插件只读） |
| 回收站 | `<DSH_HOME>/.session-trash/` | 本插件 |

- 归档 / 取消归档**不直接改文件**，而是调用 Host 的 `workspaceRegistry` 服务，保证侧边栏、Agent 的唤醒门与磁盘状态一致。
- 删除文件夹只删分类，会话本身与归档状态都不动，里面的会话回到「未分类」。
- 彻底删除前请确认；要留档先 `/export`。

## 配置

在 profile 的 `cordis.patch.yml` 里用同 id 覆盖：

```yaml
- id: session-classify
  config:
    enabled: true
    dshHome: 'F:\\dsh-home'   # 默认 $DSH_HOME 或 ~/.dsh
    limit: 30                  # 命令/工具列出的默认条数
```

## 注意

- **会话库由桌面版 DSH 与 dsh-TUI 共用**（同一个 `<DSH_HOME>/sessions`），在这里删掉的对话两边都会消失。
- 正在使用的会话不要删（关掉那个会话再操作）；正在运行的会话归档会被 DSH 拒绝，面板会给出「停止并归档」。
- 归档的会话在 DSH 里不可打开，面板会禁用「打开」并提示先取消归档。
- **面板左栏 = DSH 工作区**：和侧边栏同一份数据（`workspace.json`）。所以在这里看到的分组与侧栏一致；「未归组」就是还没进入任何工作区的会话，点「归入工作区」即可补上（目录不是工作区会自动注册）。
- **面板比侧栏多一层折叠**：侧栏工作区是平铺的，本面板按目录路径把 `plugin/xxx` 挂到 `plugin` 下面显示（只是展示层级，不改 DSH 数据）。
- 清理残留：`{ "action": "prune-ghosts" }` 会摘掉「磁盘上已不存在的会话」在工作区引用、归档标记与投影缓存里的痕迹（侧栏里点开报 `not-found` 的条目就是这么来的）。
- **「使用中」的会话删不干净**：DSH 侧栏的「进行中 / 未分组」读的是**内存里的会话表**，不是磁盘。会话打开过就会留在内存里，即使文件已删，侧栏仍列着它（面板里标「使用中」，顶部会提示有几个"内存残留"）。这类只能切换会话或重启 DSH 才会消失，插件侧无法强制释放。

## 测试

```sh
node test/selftest.mjs
```

自测在临时目录里造会话库与分类数据，覆盖文件夹增删改序、会话枚举（多帧 zstd）、归档标记、回收站的移入 / 恢复 / 彻底删除 / 清空的确认门、命令解析与路径校验，不碰真实的 `~/.dsh`。

## License

MIT

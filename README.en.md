# dsh-session-manage

Sort DeepSeek Harness sessions into **your own folders**, and manage their fate from the same panel: archived conversations, sessions you want gone, and the trash in between.

> Renamed: this plugin used to be `dsh-session-classify`; on 2026-11-11 it became **`dsh-session-manage`** (plugin id `session-classify` → `session-manage`, display name "Session Manage"). It also absorbs the retired `dsh-session-manager` (deleting sessions, trash, restore); both data files keep their old names readable — see "Where the data lives".

## Features

**Classification (workspace tree)**

The left column is no longer your own folders: it mirrors the sidebar's **workspace tree**.

- The tree nests by workspace directory: `plugin` holds `plugin/classify`, `plugin/token`, … and collapses (▾/▸);
- Pick a workspace to see only its conversations; its child workspaces appear as cards at the top of the list for drilling down;
- "All sessions" and "Ungrouped" scopes cover the rest — "Group into workspace" on an ungrouped row registers the directory as a workspace when needed and attaches the session;
- Archived conversations are included by default, badged and one click away from being unarchived;
- Search (title / workspace / id) and All / Active / Archived filters.

> Folder data from much earlier versions is read-only compatible; the UI no longer uses it and it affects no session.

**Session management**

- The "⋯" control on each row expands: rename (writes the session title back), open, archive / unarchive, delete, delete forever.
- **Bulk actions**: a permanent "Select all" above the list; selected rows can be **deleted in bulk** (second confirmation, sessions in use skipped) and ungrouped ones can be **grouped into workspaces** in bulk.
- **Delete moves the session to the trash** at `<DSH_HOME>/.session-trash/`; the Trash scope restores it or empties the entry. Both permanent actions need a second confirmation.
- Deleting also cleans the index caches (`session_projcache.json`, `~/.dsh-tui/session-index.json`), the archive marker, and workspace references, so the sidebar keeps no `not-found` ghosts.
- Slash command `/sessions`: list, trash, purge, inspect and restore the trash.
- Model tool `session_manage`: ask the agent to delete a conversation and it will list first, then delete.

## Install

Local plugin (junction link, hot reload on edits):

```sh
dsh plugin --profile <profile> add F:/18752/Documents/plugin/classify
```

Restart DSH, then **reload the page once** (Ctrl+R); the "Session Manage" icon appears in the sidebar.

> Package name and directory name may differ: this checkout is still `classify` (the profile pins `"dsh-session-manage": "link:F:/18752/Documents/plugin/classify"`); the plugin identity is `name` in `package.json`.

> After editing `lib/client.js` you also need a page reload or DSH restart; Host-side hot reload depends on whether the profile's `hmr.root` includes this directory.

## Usage

### Panel

Open "Session Manage" in the sidebar:

- **Left**: all sessions / unfiled / each folder / trash.
- **Right**: session rows. Checkboxes are for bulk moves; "⋯" expands folder moves, rename, open, archive, delete, delete forever.
- **Trash**: each entry shows its original path and size, with Restore and Empty actions.

### Commands

| Command | Effect |
| --- | --- |
| `/sessions` | list recent sessions grouped by workspace |
| `/sessions all` | list every session |
| `/sessions trash <id-prefix>` | move to trash |
| `/sessions purge <id-prefix> --yes` | delete forever |
| `/sessions trash-list` | show the trash |
| `/sessions restore <entry>` | restore one entry |
| `/sessions empty <entry> --yes` | empty one entry |

The 8-character id shown in lists works as a prefix; `session-` may be omitted and the match must be unique.

### Tool

The model can call `session_manage` with `action` in `list` / `trash` / `purge` / `trash-list` / `restore` / `empty`, plus `session` or `name`.

## Where the data lives

| Data | Location | Writer |
| --- | --- | --- |
| Folders and membership | `<DSH_HOME>/storages/dsh-session-manage.json` (legacy `dsh-classify.json` still read) | this plugin (`.bak` backup) |
| Session logs | `<DSH_HOME>/sessions/<cwd-slug>/<session-id>/` | DSH |
| Archive set | `global.archivedSessionIds` in `<DSH_HOME>/storages/workspace.json` | DSH (read-only here) |
| Trash | `<DSH_HOME>/.session-trash/` | this plugin |

- Archive / unarchive never edits files directly: they call the Host `workspaceRegistry` service, keeping the sidebar, the agent wake-up gate, and disk state consistent.
- Deleting a folder deletes only the classification; sessions keep their archive state and become "Unfiled".
- Confirm before deleting forever; use `/export` first if you want a copy.
- **Rename compatibility**: `<DSH_HOME>/storages/dsh-classify.json` and the `.session-classify.json` manifest inside old trash entries are still read; new data always goes to `dsh-session-manage.json` / `.session-manage.json`, and old files are neither migrated nor deleted.

## Configuration

Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: session-manage
  config:
    enabled: true
    dshHome: 'F:\\dsh-home'   # defaults to $DSH_HOME or ~/.dsh
    limit: 30                  # default list size for command and tool
```

## Caveats

- **The session library is shared** by desktop DSH and dsh-TUI (same `<DSH_HOME>/sessions`): a session deleted here disappears from both.
- Do not delete the session you are currently using. Archiving a running session is refused by DSH; the panel then offers "Stop and archive".
- DSH cannot open an archived session; the panel disables "Open" and asks you to unarchive first.
- **The left column is the DSH workspace list**: same data as the sidebar (`workspace.json`). "Ungrouped" means the session is not in any workspace yet; "Group into workspace" registers its directory when needed and attaches it.
- **The panel adds one level of nesting**: the sidebar is flat, while this panel nests `plugin/xxx` under `plugin` by directory path (display only, no DSH data is changed).
- Cleaning ghosts: `{ "action": "prune-ghosts" }` removes sessions that no longer exist on disk from workspace references, the archive set, and the projection cache (these are the sidebar entries that fail with `not-found`).
- **Live sessions cannot be fully deleted here**: the sidebar's "in progress / ungrouped" list reads DSH's **in-memory session table**, not the disk. A session you opened stays in memory, so the sidebar keeps listing it even after its files are gone (the panel badges it "In use" and shows how many memory leftovers exist). Only switching away or restarting DSH clears those; a plugin cannot force the release.

## Test

```sh
node test/selftest.mjs
```

The self-test builds a throwaway session library and classification file in a temp directory, covering folder CRUD and ordering, session enumeration (multi-frame zstd), archive markers, trash move / restore / permanent delete / empty confirmation gates, command parsing, and path validation. It never touches the real `~/.dsh`.

## License

MIT

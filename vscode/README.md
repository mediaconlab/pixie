# Pixie for VS Code

Pixie is a desktop companion whose brain runs in the cloud. This extension is Pixie's **IDE device**:
it lets you ask Pixie about your code, shows her replies and suggestions in a side panel, and applies
patches she proposes once you approve them. Every decision is made by the brain; the extension
only senses (what you ask, the file you are in) and performs (chat, diffs, edits).

## Pairing

1. On your Mac, open Pixie and choose **Pair a device**. You get a 6-digit code (valid for 10 minutes).
2. In VS Code run **Pixie: Pair with Pixie** from the Command Palette.
3. Enter your brain URL (for example `https://pixie-orchestrator.<subdomain>.workers.dev`) and the code.

The device token is kept in VS Code's secret storage. The URL goes in the user setting `pixie.brainUrl`.
To disconnect, run **Pixie: Unpair**, which revokes the token on the brain and deletes it locally.

## Commands

| Command | What it does |
| --- | --- |
| **Pixie: Pair with Pixie** | Pair this editor using a brain URL and a 6-digit code. |
| **Pixie: Ask about this code** | Asks a question about the selection (or the whole file), including its diagnostics. |
| **Pixie: Explain selection** | Asks Pixie to explain the selected code. |
| **Pixie: Fix errors in this file** | Sends the file and its errors and warnings, and asks Pixie to fix them. |
| **Pixie: Open panel** | Opens the Pixie panel in the activity bar. |
| **Pixie: Unpair** | Revokes this editor's token and forgets it. |

The ask, explain and fix commands are also in the editor's right-click menu.

## The panel

- **Chat**: Pixie's replies, with her current emotion. Type in the box at the bottom to talk to her
  (Enter sends, Shift+Enter adds a new line).
- **Suggestions**: an explanation with an optional diff. **Show diff** opens VS Code's diff editor
  with the patched version. **Apply** writes the change as a normal, undoable edit.
- **Proposed patches**: **Approve** or **Reject** sends your answer to Pixie. A patch is applied only when the
  brain then sends the execute command, and the result is reported back.

The status bar shows whether Pixie is connected and her mood (for example `Pixie · curious`). Hover it to
see the last thing she said, and click it to open the panel.

## Privacy

Nothing is sent until you pair. After that:

- Code is sent only when you run a command, or when automatic sharing is on (see below).
- Files matching `pixie.excludeGlobs` are **never** sent.
- Before anything is sent, obvious secrets are replaced with `‹redacted›`. This covers `sk-…`, `ghp_…` and
  `github_pat_…` tokens, `AKIA…` keys, PEM private-key blocks, and `password` / `secret` / `token` = "…" values.
- File content is trimmed to 20,000 characters, centred on your cursor or selection.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pixie.brainUrl` | `""` | Brain base URL. Set by pairing. This is a user-level setting only, so a workspace cannot redirect your token. |
| `pixie.deviceName` | `""` | The name this editor reports. Defaults to `Visual Studio Code on <hostname>`. |
| `pixie.shareOnSave` | `false` | Send the active file each time you save it. |
| `pixie.shareDiagnostics` | `true` | Send the active file when its errors change. Waits 3 s after the last change and sends at most once every 30 s. |
| `pixie.excludeGlobs` | `["**/.env*", "**/*.pem", "**/*.key", "**/*secret*", "**/node_modules/**"]` | Files that are never sent. |

Automatic context is sent only while connected; it is never queued. Messages you send yourself are queued
while offline (up to 100) and delivered when Pixie reconnects. Reconnects back off from 1 s to 30 s.

## Development

```sh
npm ci
npm run build      # esbuild → dist/extension.js, dist/webview.js, dist/panel.css
npm run typecheck  # tsc --noEmit
npm test           # vitest (pure logic: patch applier, redaction, globs, trimming, protocol, socket client)
npm run package    # → pixie-vscode.vsix
```

To try it, press F5 in this folder with a launch configuration of type `extensionHost`, or install the VSIX with
`code --install-extension pixie-vscode.vsix`.

The extension implements the `ide` side of [`PROTOCOL.md`](https://github.com/mediaconlab/pixie/blob/main/PROTOCOL.md).

## License

MIT

/** The Pixie WebviewView: chat log, input box, suggestion and proposal cards. */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { HostToWebview, PanelItem, PanelState, WebviewToHost } from "./webview/messages";

export const VIEW_ID = "pixie.panel";
const MAX_ITEMS = 200;

export class PixiePanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private items: PanelItem[] = [];
  private state: PanelState = { paired: false, connection: "idle", persona: "Pixie", emotion: "neutral", queued: 0 };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (msg: WebviewToHost) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.html(view.webview, distUri);
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: WebviewToHost) => {
        if (m?.type === "ready") {
          this.post({ type: "init", items: this.items, state: this.state });
          return;
        }
        this.onMessage(m);
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  find(id: string): PanelItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  findProposal(proposalId: string): Extract<PanelItem, { kind: "proposal" }> | undefined {
    return this.items.find((i): i is Extract<PanelItem, { kind: "proposal" }> => i.kind === "proposal" && i.proposalId === proposalId);
  }

  /** Add a new item or replace an existing one with the same id. */
  upsert(item: PanelItem): void {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) this.items[idx] = item;
    else {
      this.items.push(item);
      if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    }
    this.post({ type: "item", item });
  }

  update<K extends PanelItem>(id: string, patch: Partial<K>): void {
    const cur = this.find(id);
    if (!cur) return;
    this.upsert({ ...cur, ...patch } as PanelItem);
  }

  setState(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.post({ type: "state", state: this.state });
  }

  clear(): void {
    this.items = [];
    this.post({ type: "clear" });
  }

  private post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "panel.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Pixie</title>
</head>
<body>
<header class="status" id="status" role="status" aria-live="polite"></header>
<main class="log" id="log" aria-live="polite" aria-label="Conversation with Pixie"></main>
<form class="composer" id="composer" autocomplete="off">
  <textarea id="input" rows="1" placeholder="Talk to Pixie… (Enter to send, Shift+Enter for a new line)" aria-label="Message Pixie"></textarea>
  <button type="submit" id="send" title="Send">Send</button>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const bytes = randomBytes(32);
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

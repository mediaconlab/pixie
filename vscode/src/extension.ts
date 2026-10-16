/**
 * Pixie for VS Code: the "ide" device of the Pixie protocol (see PROTOCOL.md).
 * The extension only senses (ide.context, user.say) and performs (chat, suggestions, patches);
 * all decisions are made by the brain.
 */
import * as os from "node:os";
import * as vscode from "vscode";
import WebSocket from "ws";
import { claimPairing, describeApiError, revokeDevice } from "./api";
import { Connection, ConnectionState, SocketFactory, SocketLike } from "./connection";
import { buildContext, errorSignature, isDocExcluded, isShareable } from "./context";
import { PixiePanel, VIEW_ID } from "./panel";
import { applyChanges, PATCHED_SCHEME, PatchedContentProvider, planPatch, resolveFile, showDiff } from "./patcher";
import {
  APP_VERSION,
  CodePatchPayload,
  emotionWord,
  Envelope,
  ErrorData,
  ExecuteData,
  IdeContext,
  isValidPairCode,
  newId,
  normaliseBrainUrl,
  normalisePerformance,
  Proposal,
  Suggestion,
  WelcomeData,
  wsUrlFor,
} from "./protocol";
import { redact } from "./redact";
import { DebouncedGate } from "./throttle";
import type { PanelItem, WebviewToHost } from "./webview/messages";

const TOKEN_KEY = "pixie.token";
const DEVICE_ID_KEY = "pixie.deviceId";
const URL_KEY = "pixie.brainUrl";
const DIAG_DEBOUNCE_MS = 3_000;
const DIAG_MIN_INTERVAL_MS = 30_000;

type SuggestionItem = Extract<PanelItem, { kind: "suggestion" }>;
type ProposalItem = Extract<PanelItem, { kind: "proposal" }>;

class PixieExtension implements vscode.Disposable {
  private connection: Connection | null = null;
  private connState: ConnectionState = "idle";
  private paired = false;
  private persona = "Pixie";
  private emotion = "neutral";
  private lastSaid = "";
  private readonly status: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private readonly panel: PixiePanel;
  private readonly patched = new PatchedContentProvider();
  private readonly executed = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastErrorSig = new Map<string, string>();
  private readonly diagGate: DebouncedGate;
  private unauthorizedShown = false;
  private suppressConfigRestart = false;
  private restartChain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Pixie");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "pixie.openPanel";
    this.status.name = "Pixie";
    this.panel = new PixiePanel(ctx.extensionUri, (m) => void this.onWebviewMessage(m));
    this.diagGate = new DebouncedGate(() => this.sendDiagnosticsContext(), DIAG_DEBOUNCE_MS, DIAG_MIN_INTERVAL_MS);

    this.disposables.push(
      this.output,
      this.status,
      this.panel,
      this.patched,
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.panel, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.registerTextDocumentContentProvider(PATCHED_SCHEME, this.patched),
      vscode.commands.registerCommand("pixie.pair", () => this.pair()),
      vscode.commands.registerCommand("pixie.unpair", () => this.unpair()),
      vscode.commands.registerCommand("pixie.openPanel", () => this.panel.reveal()),
      vscode.commands.registerCommand("pixie.ask", () => this.ask()),
      vscode.commands.registerCommand("pixie.explainSelection", () => this.explainSelection()),
      vscode.commands.registerCommand("pixie.fixErrors", () => this.fixErrors()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.languages.onDidChangeDiagnostics((e) => this.onDiagnostics(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) this.lastErrorSig.set(ed.document.uri.toString(), errorSignature(ed.document.uri));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (this.suppressConfigRestart) return;
        if (e.affectsConfiguration("pixie.brainUrl") || e.affectsConfiguration("pixie.deviceName")) void this.restart();
      }),
      { dispose: () => this.diagGate.cancel() },
      { dispose: () => this.connection?.stop() },
    );
    this.renderStatus();
    this.status.show();
  }

  // ---------------------------------------------------------------- config

  private brainUrl(): string | undefined {
    // Only the user-level value is honoured: a workspace must never be able to redirect the device token.
    const fromSetting = vscode.workspace.getConfiguration("pixie").inspect<string>("brainUrl")?.globalValue?.trim();
    return fromSetting || this.ctx.globalState.get<string>(URL_KEY) || undefined;
  }

  private deviceName(): string {
    const custom = vscode.workspace.getConfiguration("pixie").get<string>("deviceName")?.trim();
    return custom || `${vscode.env.appName} on ${os.hostname()}`;
  }

  private log(msg: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  // ------------------------------------------------------------ connection

  async start(): Promise<void> {
    const token = await this.ctx.secrets.get(TOKEN_KEY);
    const url = this.brainUrl();
    this.paired = !!token && !!url;
    this.panel.setState({ paired: this.paired });
    if (!token || !url) {
      this.setConnState("idle");
      return;
    }
    let wsUrl: string;
    try {
      wsUrl = wsUrlFor(url);
    } catch (e) {
      this.log(`invalid brain URL ${url}: ${(e as Error).message}`);
      this.setConnState("closed");
      return;
    }
    const factory: SocketFactory = (u, headers) =>
      new WebSocket(u, { headers, handshakeTimeout: 15_000, maxPayload: 1024 * 1024 }) as unknown as SocketLike;
    this.connection = new Connection({
      wsUrl,
      token,
      factory,
      hello: { kind: "ide", name: this.deviceName(), app_version: APP_VERSION, capabilities: ["code"] },
      events: {
        onState: (s) => this.setConnState(s),
        onEnvelope: (env) => this.onEnvelope(env),
        onUnauthorized: () => void this.onUnauthorized(),
        onLog: (m) => this.log(m),
      },
    });
    this.unauthorizedShown = false;
    this.log(`connecting to ${wsUrl}`);
    this.connection.start();
  }

  /** Serialised stop + start so overlapping restarts never leave two sockets open. */
  private restart(): Promise<void> {
    this.restartChain = this.restartChain
      .catch(() => undefined)
      .then(async () => {
        this.connection?.stop();
        this.connection = null;
        await this.start();
      });
    return this.restartChain;
  }

  private setConnState(s: ConnectionState): void {
    this.connState = s;
    this.panel.setState({ connection: s, queued: this.connection?.queued ?? 0 });
    this.renderStatus();
  }

  private renderStatus(): void {
    const name = this.persona || "Pixie";
    if (!this.paired) {
      this.status.text = `$(circle-slash) ${name} · not paired`;
      this.status.tooltip = "Pixie is not paired with this editor. Click to open the panel, or run “Pixie: Pair with Pixie”.";
      this.status.backgroundColor = undefined;
      return;
    }
    switch (this.connState) {
      case "open":
        this.status.text = `$(sparkle) ${name} · ${emotionWord(this.emotion)}`;
        break;
      case "connecting":
        this.status.text = `$(sync~spin) ${name} · connecting`;
        break;
      default:
        this.status.text = `$(debug-disconnect) ${name} · offline`;
    }
    const md = new vscode.MarkdownString(undefined, false);
    md.isTrusted = false;
    md.supportThemeIcons = false;
    md.appendText(this.lastSaid ? this.lastSaid : this.connState === "open" ? `${name} is connected.` : `${name} is disconnected.`);
    this.status.tooltip = md;
  }

  private send<T>(type: string, data: T): string | undefined {
    if (!this.connection) {
      void this.promptPair();
      return undefined;
    }
    const id = this.connection.send(type, data);
    this.panel.setState({ queued: this.connection.queued });
    if (this.connState !== "open") {
      this.panel.upsert({
        id: newId("ntc"),
        kind: "notice",
        ts: Date.now(),
        tone: "info",
        text: "Offline: queued, will send when Pixie reconnects.",
      });
    }
    return id;
  }

  private async onUnauthorized(): Promise<void> {
    this.log("brain rejected the device token");
    this.setConnState("closed");
    if (this.unauthorizedShown) return;
    this.unauthorizedShown = true;
    const pick = await vscode.window.showWarningMessage(
      "Pixie no longer recognises this editor (the device may have been removed). Pair again?",
      "Pair",
    );
    if (pick === "Pair") await this.pair();
  }

  // ------------------------------------------------------------- incoming

  private onEnvelope(env: Envelope): void {
    const data = (env.data ?? {}) as Record<string, unknown>;
    switch (env.type) {
      case "welcome":
        return this.onWelcome(data as WelcomeData);
      case "bot.perform":
        return this.onPerform(data);
      case "ide.suggestion":
        return this.onSuggestion(data as unknown as Suggestion);
      case "bot.propose":
        return this.onPropose(data as unknown as Proposal);
      case "bot.execute":
        void this.onExecute(data as unknown as ExecuteData);
        return;
      case "error": {
        const err = data as unknown as ErrorData;
        this.log(`brain error ${err.code}: ${err.message ?? ""}`);
        this.panel.upsert({
          id: newId("ntc"),
          kind: "notice",
          ts: Date.now(),
          tone: "error",
          text: err.code === "rate_limited" ? "Pixie needs a breather (rate limited). Try again in a moment." : `Pixie error: ${err.message || err.code}`,
        });
        return;
      }
      default:
        // Events meant for other devices, or from a newer brain: ignore.
        this.log(`ignored event ${env.type}`);
    }
  }

  private onWelcome(w: WelcomeData): void {
    if (w.persona?.name) this.persona = w.persona.name;
    this.panel.setState({ persona: this.persona });
    this.log(`welcome${w.user_name ? ` (${w.user_name})` : ""}`);
    this.renderStatus();
  }

  private onPerform(raw: unknown): void {
    const p = normalisePerformance(raw);
    this.emotion = p.emotion;
    if (p.say) this.lastSaid = p.say;
    this.panel.setState({ emotion: emotionWord(p.emotion) });
    this.renderStatus();
    if (p.say) {
      this.panel.upsert({ id: newId("bot"), kind: "bot", ts: Date.now(), text: p.say, emotion: emotionWord(p.emotion) });
    }
  }

  private onSuggestion(s: Suggestion): void {
    if (!s || typeof s.file !== "string") return;
    const item: SuggestionItem = {
      id: newId("sug"),
      kind: "suggestion",
      ts: Date.now(),
      file: s.file,
      explanation: typeof s.explanation === "string" ? s.explanation : "",
      patch: typeof s.patch === "string" && s.patch.trim() ? s.patch : null,
      line: typeof s.line === "number" ? s.line : undefined,
      status: "pending",
    };
    this.panel.upsert(item);
    if (!this.panel.visible) {
      void vscode.window
        .showInformationMessage(`${this.persona} has a suggestion for ${s.file}`, "Open Pixie")
        .then((pick) => pick && this.panel.reveal());
    }
  }

  private onPropose(p: Proposal): void {
    if (!p || p.kind !== "code.patch" || typeof p.proposal_id !== "string") return;
    const payload = (p.payload ?? {}) as unknown as CodePatchPayload;
    if (typeof payload.patch !== "string") return;
    const existing = this.panel.findProposal(p.proposal_id);
    const item: ProposalItem = {
      id: existing?.id ?? newId("prp"),
      kind: "proposal",
      ts: existing?.ts ?? Date.now(),
      proposalId: p.proposal_id,
      title: p.title || "Apply a patch?",
      detail: p.detail || "",
      file: typeof payload.file === "string" ? payload.file : "",
      patch: payload.patch,
      expiresAt: typeof p.expires_at === "number" ? p.expires_at : undefined,
      status: existing?.status ?? "pending",
    };
    this.panel.upsert(item);
    if (!this.panel.visible) {
      void vscode.window
        .showInformationMessage(`${this.persona}: ${item.title}`, "Review")
        .then((pick) => pick && this.panel.reveal());
    }
  }

  private async onExecute(x: ExecuteData): Promise<void> {
    if (!x || typeof x.proposal_id !== "string") return;
    if (x.kind !== "code.patch") {
      this.send("exec.result", { proposal_id: x.proposal_id, ok: false, error: `unsupported kind ${x.kind}` });
      return;
    }
    if (this.executed.has(x.proposal_id)) {
      this.log(`duplicate bot.execute ${x.proposal_id} ignored`);
      return;
    }
    this.executed.add(x.proposal_id);
    const payload = (x.payload ?? {}) as unknown as CodePatchPayload;
    const item = this.panel.findProposal(x.proposal_id);
    try {
      if (typeof payload.patch !== "string" || !payload.patch.trim()) throw new Error("payload has no patch");
      const changes = await planPatch(payload.file || item?.file, payload.patch);
      await applyChanges(changes);
      this.send("exec.result", { proposal_id: x.proposal_id, ok: true });
      if (item) this.panel.update<ProposalItem>(item.id, { status: "applied", error: undefined });
      vscode.window.setStatusBarMessage(`$(check) Pixie applied a patch to ${changes.map((c) => c.displayPath).join(", ")}`, 5000);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.log(`execute ${x.proposal_id} failed: ${msg}`);
      this.send("exec.result", { proposal_id: x.proposal_id, ok: false, error: msg.slice(0, 500) });
      if (item) this.panel.update<ProposalItem>(item.id, { status: "failed", error: msg });
      else void vscode.window.showErrorMessage(`Pixie could not apply the patch: ${msg}`);
    }
  }

  // ------------------------------------------------------------- webview

  private async onWebviewMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case "say":
        return this.say(m.text);
      case "pair":
        return this.pair();
      case "reconnect":
        if (this.connection) this.connection.reconnectNow();
        else await this.start();
        return;
      case "showDiff":
        return this.showItemDiff(m.id);
      case "apply":
        return this.applySuggestion(m.id);
      case "approve":
      case "reject":
        return this.feedback(m.id, m.type);
      case "openFile":
        return this.openItemFile(m.id);
    }
  }

  private say(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (!this.send("user.say", { text: redact(clean), via: "typed" })) return;
    this.panel.upsert({ id: newId("usr"), kind: "user", ts: Date.now(), text: clean });
  }

  private itemPatch(id: string): { item: SuggestionItem | ProposalItem; file: string; patch: string } | undefined {
    const item = this.panel.find(id);
    if (!item || (item.kind !== "suggestion" && item.kind !== "proposal") || !item.patch) return undefined;
    return { item, file: item.file, patch: item.patch };
  }

  private async showItemDiff(id: string): Promise<void> {
    const it = this.itemPatch(id);
    if (!it) return;
    try {
      const changes = await planPatch(it.file, it.patch);
      await showDiff(this.patched, changes, `${this.persona}'s patch`);
    } catch (e) {
      const msg = (e as Error).message;
      this.panel.update(id, { error: msg } as Partial<PanelItem>);
      void vscode.window.showErrorMessage(`Pixie: can't preview this patch: ${msg}`);
    }
  }

  private async applySuggestion(id: string): Promise<void> {
    const it = this.itemPatch(id);
    if (!it || it.item.kind !== "suggestion") return;
    try {
      const changes = await planPatch(it.file, it.patch);
      await applyChanges(changes);
      this.panel.update<SuggestionItem>(id, { status: "applied", error: undefined });
    } catch (e) {
      this.panel.update<SuggestionItem>(id, { status: "failed", error: (e as Error).message });
    }
  }

  private feedback(id: string, verdict: "approve" | "reject"): void {
    const item = this.panel.find(id);
    if (!item || item.kind !== "proposal" || item.status !== "pending") return;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.panel.update<ProposalItem>(id, { status: "expired" });
      return;
    }
    if (!this.send("user.feedback", { proposal_id: item.proposalId, verdict })) return;
    this.panel.update<ProposalItem>(id, { status: verdict === "approve" ? "approved" : "rejected" });
  }

  private async openItemFile(id: string): Promise<void> {
    const item = this.panel.find(id);
    if (!item || (item.kind !== "suggestion" && item.kind !== "proposal") || !item.file) return;
    try {
      const uri = await resolveFile(item.file, true);
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = item.kind === "suggestion" && item.line ? Math.max(0, item.line - 1) : 0;
      const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
    } catch (e) {
      void vscode.window.showWarningMessage(`Pixie: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------- commands

  private async promptPair(): Promise<void> {
    const pick = await vscode.window.showInformationMessage("Pixie isn't paired with this editor yet.", "Pair now");
    if (pick) await this.pair();
  }

  async pair(): Promise<void> {
    const current = this.brainUrl();
    const urlInput = await vscode.window.showInputBox({
      title: "Pair with Pixie (1/2)",
      prompt: "Your Pixie brain URL",
      placeHolder: "https://pixie-orchestrator.<subdomain>.workers.dev",
      value: current ?? "",
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          normaliseBrainUrl(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (urlInput === undefined) return;
    const url = normaliseBrainUrl(urlInput);
    const code = await vscode.window.showInputBox({
      title: "Pair with Pixie (2/2)",
      prompt: "6-digit pairing code from Pixie on your Mac (Pair a device)",
      placeHolder: "482913",
      ignoreFocusOut: true,
      validateInput: (v) => (isValidPairCode(v.replace(/\s+/g, "")) ? undefined : "Enter the 6 digits shown on your Mac"),
    });
    if (code === undefined) return;

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Pairing with Pixie…" },
        () => claimPairing(url, code.replace(/\s+/g, ""), this.deviceName()),
      );
      this.connection?.stop();
      this.connection = null;
      await this.ctx.secrets.store(TOKEN_KEY, result.token);
      await this.ctx.globalState.update(DEVICE_ID_KEY, result.device_id);
      await this.ctx.globalState.update(URL_KEY, url);
      const cfg = vscode.workspace.getConfiguration("pixie");
      const inspected = cfg.inspect<string>("brainUrl");
      this.suppressConfigRestart = true;
      try {
        if ((inspected?.globalValue ?? "") !== url) {
          await cfg.update("brainUrl", url, vscode.ConfigurationTarget.Global);
        }
      } catch (e) {
        this.log(`could not save pixie.brainUrl setting (using globalState): ${(e as Error).message}`);
      } finally {
        this.suppressConfigRestart = false;
      }
      await this.restart();
      this.panel.upsert({ id: newId("ntc"), kind: "notice", ts: Date.now(), tone: "info", text: "Paired! Pixie can now see what you ask about." });
      void vscode.window.showInformationMessage("Pixie is paired with this editor.");
    } catch (e) {
      void vscode.window.showErrorMessage(`Pairing failed: ${describeApiError(e)}`);
    }
  }

  async unpair(): Promise<void> {
    const sure = await vscode.window.showWarningMessage(
      "Unpair this editor from Pixie? Its device token will be revoked.",
      { modal: true },
      "Unpair",
    );
    if (sure !== "Unpair") return;
    const token = await this.ctx.secrets.get(TOKEN_KEY);
    const deviceId = this.ctx.globalState.get<string>(DEVICE_ID_KEY);
    const url = this.brainUrl();
    this.connection?.stop();
    this.connection = null;
    if (token && deviceId && url) {
      try {
        await revokeDevice(url, token, deviceId);
      } catch (e) {
        this.log(`revoke failed (continuing): ${describeApiError(e)}`);
      }
    }
    await this.ctx.secrets.delete(TOKEN_KEY);
    await this.ctx.globalState.update(DEVICE_ID_KEY, undefined);
    this.paired = false;
    this.lastSaid = "";
    this.emotion = "neutral";
    this.panel.clear();
    this.panel.setState({ paired: false, connection: "idle", emotion: "neutral", queued: 0 });
    this.setConnState("idle");
    void vscode.window.showInformationMessage("Pixie has been unpaired from this editor.");
  }

  private activeEditor(): vscode.TextEditor | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) void vscode.window.showInformationMessage("Pixie: open a file first.");
    return ed;
  }

  private async sendAsked(editor: vscode.TextEditor, question: string, includeSelection = true): Promise<void> {
    if (!this.connection) return this.promptPair();
    const built = buildContext(editor, "asked", question, { includeSelection });
    if (!built.ok) {
      const why =
        built.reason === "excluded"
          ? "This file matches pixie.excludeGlobs, so Pixie won't read it."
          : "Pixie can only read files from the workspace.";
      void vscode.window.showWarningMessage(why);
      return;
    }
    const c = built.context;
    this.send("ide.context", c);
    const where = c.selection ? `${c.file}:${c.selection.start_line}-${c.selection.end_line}` : c.file;
    const extra = c.diagnostics.length ? ` · ${c.diagnostics.length} diagnostic${c.diagnostics.length === 1 ? "" : "s"}` : "";
    this.panel.upsert({ id: newId("usr"), kind: "user", ts: Date.now(), text: question, context: where + extra });
    await this.panel.reveal();
  }

  private async ask(): Promise<void> {
    const ed = this.activeEditor();
    if (!ed) return;
    const q = await vscode.window.showInputBox({
      title: "Ask Pixie about this code",
      prompt: ed.selection.isEmpty ? "Question about the current file" : "Question about the selected code",
      placeHolder: "why does this fail?",
      ignoreFocusOut: true,
    });
    if (!q?.trim()) return;
    await this.sendAsked(ed, q.trim());
  }

  private async explainSelection(): Promise<void> {
    const ed = this.activeEditor();
    if (!ed) return;
    if (ed.selection.isEmpty) {
      void vscode.window.showInformationMessage("Pixie: select some code to explain.");
      return;
    }
    await this.sendAsked(ed, "Explain this code");
  }

  private async fixErrors(): Promise<void> {
    const ed = this.activeEditor();
    if (!ed) return;
    await this.sendAsked(ed, "Fix the errors in this file", false);
  }

  // ------------------------------------------------------- auto context

  private sendAuto(editor: vscode.TextEditor, reason: IdeContext["reason"]): void {
    if (!this.connection || this.connState !== "open") return; // automatic context is never queued
    const built = buildContext(editor, reason, null);
    if (!built.ok) return;
    this.connection.send("ide.context", built.context);
    this.log(`shared ${built.context.file} (${reason})`);
  }

  private onSave(doc: vscode.TextDocument): void {
    if (!vscode.workspace.getConfiguration("pixie").get<boolean>("shareOnSave", false)) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document !== doc || !isShareable(doc) || isDocExcluded(doc)) return;
    this.sendAuto(ed, "save");
  }

  private onDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    if (!vscode.workspace.getConfiguration("pixie").get<boolean>("shareDiagnostics", true)) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const key = ed.document.uri.toString();
    if (!e.uris.some((u) => u.toString() === key)) return;
    const sig = errorSignature(ed.document.uri);
    const prev = this.lastErrorSig.get(key);
    this.lastErrorSig.set(key, sig);
    if (sig === prev || sig === "") return; // only share when there are (changed) errors
    this.diagGate.trigger();
  }

  private sendDiagnosticsContext(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !vscode.workspace.getConfiguration("pixie").get<boolean>("shareDiagnostics", true)) return;
    if (errorSignature(ed.document.uri) === "") return;
    this.sendAuto(ed, "diagnostics");
  }

  dispose(): void {
    for (const d of this.disposables.reverse()) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

let instance: PixieExtension | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  instance = new PixieExtension(context);
  context.subscriptions.push(instance);
  await instance.start();
}

export function deactivate(): void {
  instance?.dispose();
  instance = undefined;
}

/** Panel webview script. Runs in the webview sandbox; never uses innerHTML for untrusted data. */
import { classifyDiffLines } from "../patch";
import type { HostToWebview, PanelItem, PanelState, WebviewToHost } from "./messages";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const log = document.getElementById("log") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;

let state: PanelState = { paired: false, connection: "idle", persona: "Pixie", emotion: "neutral", queued: 0 };
const nodes = new Map<string, HTMLElement>();

function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function diffView(patch: string): HTMLElement {
  const pre = el("pre", "diff");
  const lines = classifyDiffLines(patch);
  const shown = lines.slice(0, 400);
  for (const l of shown) {
    const span = el("span", `d-${l.kind}`, l.text + "\n");
    pre.appendChild(span);
  }
  if (lines.length > shown.length) pre.appendChild(el("span", "d-meta", `… ${lines.length - shown.length} more lines`));
  return pre;
}

const STATUS_TEXT: Record<string, string> = {
  pending: "",
  applied: "Applied",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
  expired: "Expired",
};

function render(item: PanelItem): HTMLElement {
  switch (item.kind) {
    case "bot": {
      const row = el("div", "msg bot");
      row.dataset.emotion = item.emotion;
      const meta = el("div", "meta");
      meta.append(el("span", "who", state.persona || "Pixie"), el("span", "emo", item.emotion), el("span", "time", time(item.ts)));
      row.append(meta, el("div", "text", item.text));
      return row;
    }
    case "user": {
      const row = el("div", "msg user");
      const meta = el("div", "meta");
      meta.append(el("span", "who", "You"), el("span", "time", time(item.ts)));
      row.append(meta);
      if (item.context) row.append(el("div", "ctx", item.context));
      row.append(el("div", "text", item.text));
      return row;
    }
    case "notice":
      return el("div", `notice ${item.tone}`, item.text);
    case "suggestion": {
      const card = el("section", "card suggestion");
      const head = el("div", "card-head");
      const fileBtn = button(item.line ? `${item.file}:${item.line}` : item.file, "link", () => post({ type: "openFile", id: item.id }));
      head.append(el("span", "badge", "Suggestion"), fileBtn);
      card.append(head, el("div", "text", item.explanation));
      if (item.patch) {
        card.append(diffView(item.patch));
        const actions = el("div", "actions");
        const done = item.status !== "pending" && item.status !== "failed";
        actions.append(
          button("Show diff", "secondary", () => post({ type: "showDiff", id: item.id })),
          button(item.status === "applied" ? "Applied" : "Apply", "primary", () => post({ type: "apply", id: item.id }), done),
        );
        card.append(actions);
      }
      if (item.error) card.append(el("div", "error", item.error));
      return card;
    }
    case "proposal": {
      const card = el("section", `card proposal status-${item.status}`);
      const head = el("div", "card-head");
      head.append(el("span", "badge", "Proposed patch"), button(item.file, "link", () => post({ type: "openFile", id: item.id })));
      card.append(head, el("div", "title", item.title));
      if (item.detail) card.append(el("div", "text", item.detail));
      if (item.patch) card.append(diffView(item.patch));
      const actions = el("div", "actions");
      const pending = item.status === "pending";
      actions.append(button("Show diff", "secondary", () => post({ type: "showDiff", id: item.id })));
      if (pending) {
        actions.append(
          button("Approve", "primary", () => post({ type: "approve", id: item.id })),
          button("Reject", "secondary", () => post({ type: "reject", id: item.id })),
        );
      } else {
        actions.append(el("span", `pill ${item.status}`, STATUS_TEXT[item.status] ?? item.status));
      }
      card.append(actions);
      if (item.error) card.append(el("div", "error", item.error));
      return card;
    }
  }
}

function isNearBottom(): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function upsert(item: PanelItem): void {
  const stick = isNearBottom();
  const node = render(item);
  node.dataset.id = item.id;
  const existing = nodes.get(item.id);
  if (existing) existing.replaceWith(node);
  else log.appendChild(node);
  nodes.set(item.id, node);
  while (nodes.size > 200) {
    const [firstId, firstNode] = nodes.entries().next().value as [string, HTMLElement];
    firstNode.remove();
    nodes.delete(firstId);
  }
  if (stick || !existing) log.scrollTop = log.scrollHeight;
  renderEmpty();
}

function renderEmpty(): void {
  const empty = document.getElementById("empty");
  if (nodes.size > 0) {
    empty?.remove();
    return;
  }
  if (empty) return;
  const box = el("div", "empty");
  box.id = "empty";
  if (!state.paired) {
    box.append(
      el("p", undefined, "Pixie isn't paired with this editor yet."),
      el("p", "hint", "On your Mac, open Pixie and choose “Pair a device” to get a 6-digit code."),
      button("Pair with Pixie", "primary", () => post({ type: "pair" })),
    );
  } else {
    box.append(
      el("p", undefined, "Say hi, or select some code and run “Pixie: Ask about this code”."),
    );
  }
  log.appendChild(box);
}

function renderState(): void {
  statusEl.replaceChildren();
  const dot = el("span", `dot ${state.paired ? state.connection : "unpaired"}`);
  let text: string;
  if (!state.paired) text = "Not paired";
  else if (state.connection === "open") text = `${state.persona || "Pixie"} · ${state.emotion}`;
  else if (state.connection === "connecting") text = "Connecting…";
  else text = "Offline";
  statusEl.append(dot, el("span", "label", text));
  if (state.queued > 0) statusEl.append(el("span", "queued", `${state.queued} queued`));
  if (state.paired && state.connection === "closed") statusEl.append(button("Retry", "link", () => post({ type: "reconnect" })));
  if (!state.paired) statusEl.append(button("Pair", "link", () => post({ type: "pair" })));
  input.disabled = !state.paired;
  sendBtn.disabled = !state.paired;
  document.getElementById("empty")?.remove();
  renderEmpty();
}

function autosize(): void {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  post({ type: "say", text });
  input.value = "";
  autosize();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", autosize);

window.addEventListener("message", (ev: MessageEvent<HostToWebview>) => {
  const msg = ev.data;
  switch (msg?.type) {
    case "init":
      state = msg.state;
      log.replaceChildren();
      nodes.clear();
      renderState();
      for (const it of msg.items) upsert(it);
      break;
    case "item":
      upsert(msg.item);
      break;
    case "state":
      state = msg.state;
      renderState();
      break;
    case "clear":
      log.replaceChildren();
      nodes.clear();
      renderEmpty();
      break;
  }
});

renderState();
post({ type: "ready" });

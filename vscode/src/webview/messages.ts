/** Messages between the extension host and the panel webview. */

export type ItemStatus = "pending" | "applied" | "approved" | "rejected" | "failed" | "expired";

export type PanelItem =
  | { id: string; kind: "bot"; ts: number; text: string; emotion: string }
  | { id: string; kind: "user"; ts: number; text: string; context?: string }
  | { id: string; kind: "notice"; ts: number; text: string; tone: "info" | "error" }
  | {
      id: string;
      kind: "suggestion";
      ts: number;
      file: string;
      explanation: string;
      patch: string | null;
      line?: number;
      status: ItemStatus;
      error?: string;
    }
  | {
      id: string;
      kind: "proposal";
      ts: number;
      proposalId: string;
      title: string;
      detail: string;
      file: string;
      patch: string;
      expiresAt?: number;
      status: ItemStatus;
      error?: string;
    };

export interface PanelState {
  paired: boolean;
  connection: "idle" | "connecting" | "open" | "closed";
  persona: string;
  emotion: string;
  queued: number;
}

export type HostToWebview =
  | { type: "init"; items: PanelItem[]; state: PanelState }
  | { type: "item"; item: PanelItem }
  | { type: "state"; state: PanelState }
  | { type: "clear" };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "say"; text: string }
  | { type: "showDiff"; id: string }
  | { type: "apply"; id: string }
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "openFile"; id: string }
  | { type: "pair" }
  | { type: "reconnect" };

/** Builds ide.context payloads from the active editor (vscode-dependent). */
import * as vscode from "vscode";
import { isExcluded } from "./glob";
import type { IdeContext, IdeDiagnostic } from "./protocol";
import { redact } from "./redact";
import { MAX_CONTENT, trimAround, truncate } from "./trim";

export const DEFAULT_EXCLUDES = ["**/.env*", "**/*.pem", "**/*.key", "**/*secret*", "**/node_modules/**"];
const MAX_DIAGNOSTICS = 50;
const SUPPORTED_SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs", "vsls"]);

export function excludeGlobs(): string[] {
  const v = vscode.workspace.getConfiguration("pixie").get<unknown>("excludeGlobs");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : DEFAULT_EXCLUDES;
}

export function isShareable(doc: vscode.TextDocument): boolean {
  return SUPPORTED_SCHEMES.has(doc.uri.scheme);
}

export function isDocExcluded(doc: vscode.TextDocument): boolean {
  const relative = vscode.workspace.asRelativePath(doc.uri, false);
  return isExcluded(
    { relative, absolute: doc.uri.scheme === "file" ? doc.uri.fsPath : doc.uri.path },
    excludeGlobs(),
    process.platform === "win32",
  );
}

export function diagnosticsFor(uri: vscode.Uri, onlyErrors = false): IdeDiagnostic[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) =>
      onlyErrors
        ? d.severity === vscode.DiagnosticSeverity.Error
        : d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
    )
    .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line)
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => ({
      line: d.range.start.line + 1,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? ("error" as const) : ("warning" as const),
      message: redact(truncate(d.message, 1000)),
    }));
}

/** Stable signature of the error diagnostics for change detection. */
export function errorSignature(uri: vscode.Uri): string {
  return diagnosticsFor(uri, true)
    .map((d) => `${d.line}:${d.message}`)
    .join("\n");
}

export type BuildResult = { ok: true; context: IdeContext } | { ok: false; reason: "excluded" | "unsupported" };

export function buildContext(
  editor: vscode.TextEditor,
  reason: IdeContext["reason"],
  question: string | null,
  opts: { includeSelection?: boolean } = {},
): BuildResult {
  const doc = editor.document;
  if (!isShareable(doc)) return { ok: false, reason: "unsupported" };
  if (isDocExcluded(doc)) return { ok: false, reason: "excluded" };

  const full = doc.getText();
  const sel = editor.selection;
  const startOff = doc.offsetAt(sel.start);
  const endOff = doc.offsetAt(sel.end);
  const redactedFull = redact(full);
  let content: string;
  if (redactedFull.length <= MAX_CONTENT) {
    content = redactedFull;
  } else {
    // Map the cursor/selection into the redacted text (redaction changes lengths).
    const focusStart = redact(full.slice(0, startOff)).length;
    const focusEnd = focusStart + redact(full.slice(startOff, endOff)).length;
    content = redact(trimAround(redactedFull, focusStart, focusEnd, MAX_CONTENT));
  }

  let selection: IdeContext["selection"] = null;
  if ((opts.includeSelection ?? true) && !sel.isEmpty) {
    selection = {
      start_line: sel.start.line + 1,
      end_line: sel.end.line + 1,
      text: redact(truncate(doc.getText(sel), MAX_CONTENT)),
    };
  }

  return {
    ok: true,
    context: {
      file: vscode.workspace.asRelativePath(doc.uri, false),
      language: doc.languageId,
      content,
      selection,
      diagnostics: diagnosticsFor(doc.uri),
      question: question ? redact(question) : null,
      reason,
    },
  };
}

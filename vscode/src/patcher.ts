/** vscode side of patch handling: resolve files, preview with vscode.diff, apply with WorkspaceEdit. */
import * as path from "node:path";
import * as vscode from "vscode";
import { applyFilePatch, FilePatch, parsePatch, PatchError } from "./patch";

export const PATCHED_SCHEME = "pixie-patched";

/** Serves the patched (and, for new files, the empty original) text for diff previews. */
export class PatchedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private seq = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  register(fileName: string, text: string, label: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: PATCHED_SCHEME,
      path: "/" + fileName.replace(/^\/+/, ""),
      query: `${label}-${++this.seq}`,
    });
    this.docs.set(uri.toString(), text);
    // Keep memory bounded.
    if (this.docs.size > 50) {
      const first = this.docs.keys().next().value;
      if (first !== undefined) this.docs.delete(first);
    }
    return uri;
  }

  dispose(): void {
    this.emitter.dispose();
    this.docs.clear();
  }
}

export interface PlannedChange {
  uri: vscode.Uri;
  displayPath: string;
  exists: boolean;
  original: string;
  /** null = delete the file */
  result: string | null;
}

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path from the brain to a workspace URI. Relative paths are tried in each workspace folder
 * (preferring one where the file exists); absolute paths must lie inside a workspace folder.
 * Already-open documents are matched by their workspace-relative path first.
 */
export async function resolveFile(file: string, mustExist: boolean): Promise<vscode.Uri> {
  const clean = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.includes("\0")) throw new PatchError("Patch has no target file");

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === PATCHED_SCHEME) continue;
    if (vscode.workspace.asRelativePath(doc.uri, false) === clean) return doc.uri;
  }

  const folders = workspaceFolders();
  if (path.isAbsolute(clean) || /^[A-Za-z]:\//.test(clean)) {
    const uri = vscode.Uri.file(clean);
    if (folders.length > 0 && !folders.some((f) => isInside(uri.fsPath, f.uri.fsPath))) {
      throw new PatchError(`Refusing to touch ${clean}: it is outside the workspace`);
    }
    return uri;
  }
  if (folders.length === 0) throw new PatchError("Open a folder first so Pixie knows where to apply the patch");

  // "folderName/src/x.ts" in multi-root workspaces (asRelativePath includes the folder name).
  const candidates: vscode.Uri[] = [];
  for (const f of folders) {
    const prefix = f.name + "/";
    if (folders.length > 1 && clean.startsWith(prefix)) candidates.push(vscode.Uri.joinPath(f.uri, clean.slice(prefix.length)));
  }
  for (const f of folders) candidates.push(vscode.Uri.joinPath(f.uri, clean));

  for (const c of candidates) {
    const folder = folders.find((f) => isInside(c.fsPath, f.uri.fsPath));
    if (!folder) throw new PatchError(`Refusing to touch ${clean}: it is outside the workspace`);
  }
  for (const c of candidates) if (await exists(c)) return c;
  if (mustExist) throw new PatchError(`File not found in workspace: ${clean}`);
  return candidates[candidates.length - 1];
}

async function readText(uri: vscode.Uri): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc.getText();
}

/** Parse the patch and compute the new contents of every file it touches (without writing anything). */
export async function planPatch(defaultFile: string | undefined, patchText: string): Promise<PlannedChange[]> {
  const files = parsePatch(patchText);
  const changes: PlannedChange[] = [];
  for (const fp of files) {
    const target = targetPath(fp, files.length === 1 ? defaultFile : undefined);
    const uri = await resolveFile(target, !fp.isNew);
    const present = await exists(uri);
    if (fp.isNew && present) {
      const current = await readText(uri);
      if (current.length > 0) throw new PatchError(`${target} already exists`);
    }
    const original = present ? await readText(uri) : "";
    const result = applyFilePatch(present ? original : null, fp);
    changes.push({ uri, displayPath: vscode.workspace.asRelativePath(uri, false), exists: present, original, result });
  }
  return changes;
}

function targetPath(fp: FilePatch, defaultFile: string | undefined): string {
  // Prefer the brain-supplied payload file for single-file patches; headers may be a/ b/ or absent.
  const p = defaultFile || fp.newPath || fp.oldPath;
  if (!p) throw new PatchError("Patch does not say which file it changes");
  return p;
}

export async function showDiff(provider: PatchedContentProvider, changes: PlannedChange[], title: string): Promise<void> {
  for (const c of changes) {
    const right = provider.register(c.displayPath, c.result ?? "", "patched");
    const left = c.exists ? c.uri : provider.register(c.displayPath, "", "empty");
    const name = path.basename(c.displayPath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${name} ↔ ${title}${c.result === null ? " (delete)" : c.exists ? "" : " (new file)"}`,
      { preview: true },
    );
  }
}

export async function applyChanges(changes: PlannedChange[]): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const c of changes) {
    if (c.result === null) {
      edit.deleteFile(c.uri, { ignoreIfNotExists: true });
    } else if (!c.exists) {
      edit.createFile(c.uri, { ignoreIfExists: true });
      edit.insert(c.uri, new vscode.Position(0, 0), c.result);
    } else {
      const doc = await vscode.workspace.openTextDocument(c.uri);
      if (doc.getText() !== c.original) {
        throw new PatchError(`${c.displayPath} changed while the patch was being prepared; try again`);
      }
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      edit.replace(c.uri, new vscode.Range(new vscode.Position(0, 0), end), c.result);
    }
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new PatchError("VS Code refused the edit");
  const first = changes.find((c) => c.result !== null);
  if (first) {
    const doc = await vscode.workspace.openTextDocument(first.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

/** Plan + apply in one go (used by bot.execute and the "Apply" button). */
export async function applyPatchToWorkspace(defaultFile: string | undefined, patchText: string): Promise<PlannedChange[]> {
  const changes = await planPatch(defaultFile, patchText);
  await applyChanges(changes);
  return changes;
}

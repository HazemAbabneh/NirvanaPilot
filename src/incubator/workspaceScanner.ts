import { execFile, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

export interface WorkspaceSnapshot {
  root: string;
  unstagedDiff: string;
  stagedDiff: string;
  editorContext: string;
  hasChanges: boolean;
}

const MAX_DIFF_CHARS = 30_000;
const MAX_EDITOR_CHARS = 12_000;

function runGit(
  args: string[],
  cwd: string,
  token: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (token.isCancellationRequested) {
      reject(new Error('Workspace scan cancelled.'));
      return;
    }

    let child: ChildProcess | undefined;
    let settled = false;
    const cancellation = token.onCancellationRequested(() => {
      child?.kill();
      if (!settled) {
        settled = true;
        reject(new Error('Workspace scan cancelled.'));
      }
    });

    child = execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      cancellation.dispose();
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function collectVisibleEditorContext(): string {
  const sections: string[] = [];
  let remaining = MAX_EDITOR_CHARS;
  const seen = new Set<string>();

  for (const editor of vscode.window.visibleTextEditors) {
    const document = editor.document;
    const key = document.uri.toString();
    if (seen.has(key) || document.isClosed || remaining <= 0) {
      continue;
    }
    seen.add(key);

    const selections = editor.selections.length > 0
      ? editor.selections
      : [new vscode.Selection(0, 0, 0, 0)];
    const ranges = selections.slice(0, 4).map(selection => {
      const start = Math.max(0, Math.min(selection.start.line, selection.end.line) - 20);
      const end = Math.min(document.lineCount - 1, Math.max(selection.start.line, selection.end.line) + 20);
      return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    });
    const excerpts = ranges.map(range => document.getText(range)).join('\n...\n');
    const section = `### ${vscode.workspace.asRelativePath(document.uri)}\n${excerpts}`;
    const bounded = section.slice(0, remaining);
    sections.push(bounded);
    remaining -= bounded.length;
  }

  return sections.join('\n\n');
}

export async function scanWorkspace(token: vscode.CancellationToken): Promise<WorkspaceSnapshot> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('Open a workspace folder before running NirvanaPilot.');
  }

  const [unstagedResult, stagedResult] = await Promise.allSettled([
    runGit(['diff', 'HEAD', '--'], root, token),
    runGit(['diff', '--cached', '--'], root, token)
  ]);

  if (token.isCancellationRequested) {
    throw new Error('Workspace scan cancelled.');
  }

  const unstagedDiff = unstagedResult.status === 'fulfilled'
    ? unstagedResult.value.slice(0, MAX_DIFF_CHARS)
    : `Git diff unavailable: ${unstagedResult.reason instanceof Error ? unstagedResult.reason.message : String(unstagedResult.reason)}`;
  const stagedDiff = stagedResult.status === 'fulfilled'
    ? stagedResult.value.slice(0, MAX_DIFF_CHARS)
    : `Git cached diff unavailable: ${stagedResult.reason instanceof Error ? stagedResult.reason.message : String(stagedResult.reason)}`;
  const hasChanges = (unstagedResult.status === 'fulfilled' && Boolean(unstagedResult.value.trim()))
    || (stagedResult.status === 'fulfilled' && Boolean(stagedResult.value.trim()));

  return {
    root,
    unstagedDiff,
    stagedDiff,
    editorContext: collectVisibleEditorContext(),
    hasChanges
  };
}
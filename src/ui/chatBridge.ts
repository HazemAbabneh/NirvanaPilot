import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { checkOllamaHealth, getConfiguredModel } from '../ai/ollamaClient';
import { scanWorkspace, type WorkspaceSnapshot } from '../incubator/workspaceScanner';
import { simulateCounterfactual, type ArchitecturalDivergence } from '../simulator/counterfactualEngine';

interface IncubationReport {
  snapshot: WorkspaceSnapshot;
  divergence?: ArchitecturalDivergence;
  generatedAt: Date;
  inputTokens: number;
  outputTokens: number;
  usedFallback: boolean;
}

let latestReport: IncubationReport | undefined;
let pendingPatch = '';
const MARKDOWN_FENCE = String.fromCharCode(96).repeat(3);

export function invalidateAmbientReport(): void {
  latestReport = undefined;
  pendingPatch = '';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function runAmbientIncubation(
  token: vscode.CancellationToken
): Promise<IncubationReport> {
  const snapshot = await scanWorkspace(token);
  if (!snapshot.hasChanges) {
    const report: IncubationReport = {
      snapshot,
      generatedAt: new Date(),
      inputTokens: 0,
      outputTokens: 0,
      usedFallback: false
    };
    latestReport = report;
    return report;
  }

  const input = `${snapshot.unstagedDiff}\n${snapshot.stagedDiff}\n${snapshot.editorContext}`;
  const result = await simulateCounterfactual(snapshot, token);
  if (token.isCancellationRequested) {
    throw new Error('Ambient simulation cancelled.');
  }
  const output = JSON.stringify(result.divergence);
  const report: IncubationReport = {
    snapshot,
    divergence: result.divergence,
    generatedAt: new Date(),
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
    usedFallback: result.usedFallback
  };
  latestReport = report;
  return report;
}

function reportMarkdown(report: IncubationReport): string {
  if (!report.snapshot.hasChanges) {
    return 'No Git changes were found at the last scan, so no model inference was run.';
  }

  const divergence = report.divergence;
  if (!divergence) {
    return 'The scan completed without a counterfactual result.';
  }

  const lines = [
    `**Risk score:** ${divergence.riskScore}/100  `,
    `**Entropy delta:** ${divergence.entropyDelta}  `,
    `**Captured:** ${report.generatedAt.toLocaleString()}`,
    '',
    `**Six-month hypothesis**\n\n${divergence.breakingHypothesis}`,
    '',
    `**Mitigation**\n\n${divergence.mitigationStrategy}`
  ];

  if (report.usedFallback) {
    lines.push('', '_The local response did not pass schema validation; this is a fallback, not a model finding._');
  }

  return lines.join('\n');
}

function findApplicablePatch(candidate: string): string | undefined {
  const fenceStart = candidate.indexOf(MARKDOWN_FENCE);
  const fenceEnd = fenceStart < 0 ? -1 : candidate.indexOf(MARKDOWN_FENCE, fenceStart + MARKDOWN_FENCE.length);
  const patch = (fenceEnd >= 0
    ? candidate.slice(fenceStart + MARKDOWN_FENCE.length, fenceEnd).replace(/^(?:diff|patch)\s*/i, '')
    : candidate).trim();
  if (!patch.startsWith('diff --git ')) {
    return undefined;
  }

  const headers = patch.split('\n').filter(line => line.startsWith('diff --git '));
  if (headers.length === 0 || headers.some(line => {
    const header = line.match(/^diff --git a\/([^\s]+) b\/([^\s]+)$/);
    if (!header) {
      return true;
    }
    return [header[1], header[2]].some(path => path.startsWith('/') || path.split('/').includes('..'));
  })) {
    return undefined;
  }
  return patch;
}

function getComparisonRates(): { input: number; output: number } {
  const configuration = vscode.workspace.getConfiguration('nirvanapilot');
  return {
    input: configuration.get<number>('cloudInputPricePerMillion', 2.5),
    output: configuration.get<number>('cloudOutputPricePerMillion', 10)
  };
}

function formatLedger(inputTokens: number, outputTokens: number): string {
  const rates = getComparisonRates();
  const inputCost = inputTokens / 1_000_000 * rates.input;
  const outputCost = outputTokens / 1_000_000 * rates.output;
  const total = inputCost + outputCost;
  return [
    '# NirvanaPilot Sovereign Compliance Ledger',
    '',
    `- Estimated local input tokens: ${inputTokens.toLocaleString()} (${(inputTokens / 1_000).toFixed(2)} thousand)`,
    `- Estimated local output tokens: ${outputTokens.toLocaleString()} (${(outputTokens / 1_000).toFixed(2)} thousand)`,
    `- Comparison input rate: $${rates.input.toFixed(4)} per million tokens`,
    `- Comparison output rate: $${rates.output.toFixed(4)} per million tokens`,
    `- Estimated hosted charge avoided: **$${total.toFixed(8)}**`,
    '',
    'The token counts are character-based estimates and the rates are configurable comparison values, not a provider quote or billing record. Local inference has no per-token API charge; this estimate excludes hardware, electricity, model download, and local service costs.',
    '',
    'Data boundary: the extension sends bounded Git diffs and visible-editor context only to the configured Ollama endpoint. No hosted inference API is called.'
  ].join('\n');
}

async function openLedger(inputTokens: number, outputTokens: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: formatLedger(inputTokens, outputTokens)
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

function applyPatch(root: string, patch: string, checkOnly: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = checkOnly ? ['apply', '--check'] : ['apply'];
    const process = spawn('git', args, { cwd: root, windowsHide: true });
    let stderr = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', chunk => { stderr += String(chunk); });
    process.on('error', reject);
    process.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git apply exited with code ${String(code)}.`));
      }
    });
    process.stdin.end(patch);
  });
}

async function runChatSimulation(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<IncubationReport> {
  stream.markdown('Scanning staged and unstaged Git changes plus visible editor context...\n\n');
  const snapshot = await scanWorkspace(token);
  if (!snapshot.hasChanges) {
    const report: IncubationReport = {
      snapshot,
      generatedAt: new Date(),
      inputTokens: 0,
      outputTokens: 0,
      usedFallback: false
    };
    latestReport = report;
    return report;
  }

  stream.markdown(`Found changes. Asking local ${getConfiguredModel()} to simulate architectural pressure...\n\n`);
  let rawResponse = '';
  stream.markdown('Local model response stream:\n\n');
  const result = await simulateCounterfactual(snapshot, token, chunk => {
    rawResponse += chunk;
    stream.markdown(chunk);
  });
  const input = `${snapshot.unstagedDiff}\n${snapshot.stagedDiff}\n${snapshot.editorContext}`;
  const output = JSON.stringify(result.divergence);
  const report: IncubationReport = {
    snapshot,
    divergence: result.divergence,
    generatedAt: new Date(),
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(rawResponse || output),
    usedFallback: result.usedFallback
  };
  latestReport = report;
  return report;
}

export function registerChatBridge(context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'nirvanapilot.nirvanapilot',
    async (request, _chatContext, stream, token) => {
      try {
        if (request.command === 'status') {
          stream.markdown(`Checking local model health for ${getConfiguredModel()}...\n\n`);
          const health = await checkOllamaHealth(token);
          stream.markdown(`${health.available ? 'Available' : 'Unavailable'}: ${health.detail}`);
          return;
        }

        let report: IncubationReport;
        if (request.command === 'simulate' || !latestReport) {
          report = await runChatSimulation(stream, token);
        } else {
          report = latestReport;
          stream.markdown('Using the most recent idle-time simulation.\n\n');
        }

        stream.markdown(reportMarkdown(report));
        if (report.divergence?.simulatedDiff) {
          const patch = findApplicablePatch(report.divergence.simulatedDiff);
          if (patch) {
            pendingPatch = patch;
            stream.markdown(`\n\n**Proposed unified diff**\n\n${MARKDOWN_FENCE}diff\n${patch}\n${MARKDOWN_FENCE}\n\n`);
            stream.button({
              command: 'nirvanapilot.applySimulation',
              title: 'Review and apply patch'
            });
          } else {
            stream.markdown('\n\nThe model supplied a diff that did not pass the local patch-header safety check, so it is not offered for application.');
          }
        }

        stream.button({
          command: 'nirvanapilot.showLedger',
          title: 'Show cost ledger',
          arguments: [report.inputTokens, report.outputTokens]
        });
      } catch (error) {
        if (token.isCancellationRequested) {
          stream.markdown('Simulation cancelled because editing resumed.');
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        stream.markdown(`NirvanaPilot could not complete this request: ${detail}`);
      }
    }
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'nirvanapilot.svg');
  const applyCommand = vscode.commands.registerCommand('nirvanapilot.applySimulation', async () => {
    if (!pendingPatch) {
      void vscode.window.showInformationMessage('There is no validated NirvanaPilot patch to apply.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage('Open a workspace folder before applying a patch.');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      'Review the proposed Git patch and apply it to the current workspace?',
      { modal: true },
      'Apply Patch'
    );
    if (confirmation !== 'Apply Patch') {
      return;
    }

    try {
      await applyPatch(root, pendingPatch, true);
      await applyPatch(root, pendingPatch, false);
      pendingPatch = '';
      void vscode.window.showInformationMessage('NirvanaPilot patch applied. Review the resulting changes in Source Control.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Patch was not applied: ${detail}`);
    }
  });
  const ledgerCommand = vscode.commands.registerCommand(
    'nirvanapilot.showLedger',
    (inputTokens = 0, outputTokens = 0) => openLedger(Number(inputTokens) || 0, Number(outputTokens) || 0)
  );
  context.subscriptions.push(applyCommand, ledgerCommand);

  return participant;
}
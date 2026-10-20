import * as vscode from 'vscode';
import { InferenceCancelledError } from './ai/ollamaClient';
import { invalidateAmbientReport, runAmbientIncubation, registerChatBridge } from './ui/chatBridge';

const IDLE_DELAY_MS = 15_000;
type SlothState = 'Resting' | 'Awake' | 'Incubating' | 'Ready' | 'Unavailable';

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.name = 'NirvanaPilot';
  status.tooltip = 'NirvanaPilot waits for a pause before examining local changes.';
  status.show();
  context.subscriptions.push(status);

  let state: SlothState = 'Resting';
  let timer: NodeJS.Timeout | undefined;
  let activeRun: vscode.CancellationTokenSource | undefined;

  const setState = (next: SlothState): void => {
    state = next;
    const labels: Record<SlothState, string> = {
      Resting: '$(circle-outline) NirvanaPilot: resting',
      Awake: '$(edit) NirvanaPilot: awake',
      Incubating: '🧘 NirvanaPilot is incubating your subconscious architecture...',
      Ready: '$(check) NirvanaPilot: simulation ready',
      Unavailable: '$(warning) NirvanaPilot: local simulation unavailable'
    };
    status.text = labels[next];
    status.accessibilityInformation = { label: `NirvanaPilot state: ${next}` };
  };

  const scheduleIncubation = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      setState('Incubating');
      const source = new vscode.CancellationTokenSource();
      activeRun = source;
      void runAmbientIncubation(source.token).then(report => {
        if (source.token.isCancellationRequested) {
          return;
        }
        setState(report.usedFallback ? 'Unavailable' : report.snapshot.hasChanges ? 'Ready' : 'Resting');
      }).catch(error => {
        if (source.token.isCancellationRequested || error instanceof InferenceCancelledError) {
          return;
        }
        setState('Unavailable');
        console.warn('NirvanaPilot ambient incubation failed:', error);
      }).finally(() => {
        if (activeRun === source) {
          activeRun = undefined;
        }
        source.dispose();
      });
    }, IDLE_DELAY_MS);
  };

  const documentListener = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length === 0) {
      return;
    }
    invalidateAmbientReport();
    activeRun?.cancel();
    activeRun = undefined;
    setState('Awake');
    scheduleIncubation();
  });

  context.subscriptions.push(documentListener, {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      activeRun?.cancel();
      activeRun?.dispose();
    }
  });
  context.subscriptions.push(registerChatBridge(context));

  scheduleIncubation();
  setState(state);
}

export function deactivate(): void {
  // Extension subscriptions own timers, cancellation, and participant disposal.
}
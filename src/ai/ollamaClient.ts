import * as vscode from 'vscode';

export class InferenceCancelledError extends Error {
  constructor() {
    super('Local inference was cancelled.');
    this.name = 'InferenceCancelledError';
  }
}

function getOllamaBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration('nirvanapilot')
    .get<string>('ollamaEndpoint', 'http://localhost:11434');
  return configured.replace(/\/+$/, '');
}

export function getConfiguredModel(): string {
  return vscode.workspace
    .getConfiguration('nirvanapilot')
    .get<string>('model', 'gemma2:9b');
}

export async function generateLocally(
  prompt: string,
  token: vscode.CancellationToken,
  onChunk?: (chunk: string) => void
): Promise<string> {
  if (token.isCancellationRequested) {
    throw new InferenceCancelledError();
  }

  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  const model = getConfiguredModel();
  let responseText = '';

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        options: { temperature: 0.2, num_predict: 2048 }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama returned HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (!response.body) {
      throw new Error('Ollama returned an empty streaming response.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    while (true) {
      if (token.isCancellationRequested) {
        throw new InferenceCancelledError();
      }

      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as { response?: unknown; error?: unknown };
        if (typeof event.error === 'string') {
          throw new Error(`Ollama inference failed: ${event.error}`);
        }
        if (typeof event.response === 'string') {
          responseText += event.response;
          onChunk?.(event.response);
        }
      }

      if (done) {
        break;
      }
    }

    if (pending.trim()) {
      const event = JSON.parse(pending) as { response?: unknown; error?: unknown };
      if (typeof event.error === 'string') {
        throw new Error(`Ollama inference failed: ${event.error}`);
      }
      if (typeof event.response === 'string') {
        responseText += event.response;
        onChunk?.(event.response);
      }
    }

    return responseText;
  } catch (error) {
    if (token.isCancellationRequested || controller.signal.aborted) {
      throw new InferenceCancelledError();
    }
    throw error;
  } finally {
    cancellation.dispose();
  }
}

export async function checkOllamaHealth(
  token?: vscode.CancellationToken
): Promise<{ available: boolean; detail: string }> {
  const controller = new AbortController();
  const cancellation = token?.onCancellationRequested(() => controller.abort());

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/tags`, {
      signal: controller.signal
    });
    if (!response.ok) {
      return { available: false, detail: `Ollama returned HTTP ${response.status}.` };
    }

    const payload = await response.json() as {
      models?: Array<{ name?: unknown }>;
    };
    const model = getConfiguredModel();
    const models = payload.models ?? [];
    const found = models.some(item => item.name === model || item.name === `${model}:latest`);
    return found
      ? { available: true, detail: `Ollama is responding and ${model} is installed.` }
      : { available: false, detail: `Ollama is responding, but ${model} is not installed.` };
  } catch (error) {
    if (token?.isCancellationRequested || controller.signal.aborted) {
      return { available: false, detail: 'Health check cancelled.' };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, detail: `Cannot reach local Ollama: ${detail}` };
  } finally {
    cancellation?.dispose();
  }
}
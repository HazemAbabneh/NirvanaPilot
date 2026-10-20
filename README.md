# NirvanaPilot

**Slow code review for the future.** NirvanaPilot is a VS Code extension that waits until you stop editing, inspects the current Git changes, and asks a local Gemma 2 model to reason about architectural risks that may emerge as the codebase grows.

The sloth stays quiet while you work. After 15 seconds without an edit, it scans the working tree and a small amount of context from visible editors. If there are changes to consider, it sends that bounded context to Ollama on your machine and caches a counterfactual report. Resume typing at any point and the active scan or model request is cancelled. Nothing is sent to a cloud model.

When you return, use NirvanaPilot in Copilot Chat:

- `/incubate` shows the cached idle report, or runs one immediately if none exists.
- `/simulate` forces a fresh architectural simulation.
- `/status` checks whether the configured local Ollama model is available.

Generated diffs are suggestions, not silently applied edits. A patch is available only when the model returns a valid unified diff. The review button checks it with `git apply --check`, asks for confirmation, and then applies it.

## Ambient Pipeline

```text
VS Code text edit
	|
	+-- cancel current CancellationTokenSource immediately
	+-- reset 15-second debounce timer
		      |
		      v
	      Idle: Incubating
		      |
	   git diff HEAD + --cached
	   visible-editor context
		      |
	   no changes? ---- yes ---> rest; no model call
		      |
		      no
		      v
	Ollama /api/generate (Gemma 2 9B)
	streamed locally, cancellable
		      |
	strict JSON validation + fallback
		      |
	cached counterfactual report
		      |
	Copilot Chat /incubate
	report + optional confirmed patch
```

## Why Open Innovation and Local Models Mathematically Outclass Closed APIs

NirvanaPilot is intentionally an opt-in local inference workflow. The Git diff and selected editor context travel only to the Ollama service configured on the developer's machine; the extension does not call a hosted inference endpoint. This keeps proprietary source and unfinished changes inside the workspace's trust boundary, subject to the user's local Ollama configuration and machine security.

For an equivalent hosted request, a cost ledger can estimate the avoided API charge from input and output token estimates and user-configurable per-million-token rates:

```text
estimated avoided charge = input_tokens / 1,000,000 * input_rate
			    + output_tokens / 1,000,000 * output_rate
```

That figure is a comparison, not a billing statement: token counts are estimates, rates are configurable, and local hardware, energy, and model-download costs are excluded. Once Gemma 2 is installed, NirvanaPilot incurs no per-token inference charge; local compute is not literally free. This distinction makes the economics auditable instead of pretending every machine has zero operating cost.

The architectural value is also a hypothesis, not an oracle. The model is asked to examine coupling, growth pressure, failure propagation, and likely maintenance friction. It cannot guarantee what will happen in six months, and its output should be reviewed like any other proposed change.

## Requirements

- VS Code 1.99 or newer with GitHub Copilot Chat available.
- Node.js 20 or newer for building the extension.
- Ollama running locally at `http://localhost:11434`.
- The `gemma2:9b` model pulled with `ollama pull gemma2:9b`.

Set `nirvanapilot.ollamaEndpoint`, `nirvanapilot.model`, and the optional comparison rates in Settings. The scanner limits diffs and editor context; it does not recursively read the repository.

## Development

```sh
npm install
npm run compile
```

Press F5 from VS Code to launch the Extension Development Host. The extension activates after startup and registers the `@nirvanapilot` Copilot Chat participant.

## Privacy and Safety

- Inference uses the configured local Ollama endpoint and is cancellable when editing resumes.
- Only Git diffs and bounded context from visible text editors are sent to the local model.
- Model output is parsed and validated; malformed output produces a conservative fallback report.
- Suggested patches require a user click, a confirmation prompt, and a successful `git apply --check` before application.
- Local network exposure, Ollama logging, downloaded model licensing, and machine security remain the user's responsibility.

## License

MIT. See [LICENSE](LICENSE).
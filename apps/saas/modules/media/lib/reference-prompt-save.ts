import type { EditorProductKey } from "./editor-recovery";

export interface ReferencePromptCapture {
	assetId: string;
	productKey: EditorProductKey;
	prompt: string;
	captureId: string;
}

/** Debounce draft changes; one bounded retry uses the same immutable capture identity. */
export function scheduleReferencePromptSave(
	input: Omit<ReferencePromptCapture, "captureId">,
	save: (input: ReferencePromptCapture, signal: AbortSignal) => Promise<unknown>,
) {
	const controller = new AbortController();
	const capture = { ...input, captureId: crypto.randomUUID() };
	let timer: ReturnType<typeof setTimeout>;
	async function attempt(retry: boolean) {
		if (controller.signal.aborted) return;
		try {
			await save(capture, controller.signal);
		} catch {
			// This support record cannot block editing, retry a generation or replace safety evidence.
			if (retry && !controller.signal.aborted) timer = setTimeout(() => void attempt(false), 5_000);
		}
	}
	timer = setTimeout(() => void attempt(true), 2_000);
	return () => {
		clearTimeout(timer);
		controller.abort();
	};
}

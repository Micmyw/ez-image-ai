import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scheduleReferencePromptSave } from "./reference-prompt-save";

const input = {
	assetId: "asset-a",
	productKey: "image-nano-banana-2-lite" as const,
	prompt: "A watercolor portrait",
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("reference prompt draft saving", () => {
	it("debounces editing and cancels the previous owner or image's pending capture", async () => {
		const save = vi.fn(async () => ({}));
		const cancel = scheduleReferencePromptSave(input, save);
		await vi.advanceTimersByTimeAsync(1_000);
		cancel();
		const cleanup = scheduleReferencePromptSave(
			{ ...input, assetId: "asset-b", prompt: "new text" },
			save,
		);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(save).toHaveBeenCalledOnce();
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ assetId: "asset-b", prompt: "new text" }),
			expect.any(AbortSignal),
		);
		cleanup();
	});
	it("retries an unknown save only once with the same capture ID", async () => {
		const save = vi.fn(async () => {
			throw new Error("connection lost");
		});
		const cleanup = scheduleReferencePromptSave(input, save);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(save).toHaveBeenCalledTimes(2);
		expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
		cleanup();
	});
	it("aborts in-flight work and suppresses retries after leaving the draft", async () => {
		let reject!: (error: Error) => void;
		const save = vi.fn(
			(_input, _signal: AbortSignal) =>
				new Promise((_, fail) => {
					reject = fail;
				}),
		);
		const cleanup = scheduleReferencePromptSave(input, save);
		await vi.advanceTimersByTimeAsync(2_000);
		cleanup();
		reject(new Error("abort"));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(save).toHaveBeenCalledOnce();
		expect(save.mock.calls[0][1].aborted).toBe(true);
	});
});

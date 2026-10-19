import { describe, it, expect, vi } from "vitest";

import {
	uploadGuestDraft,
	completeGuestDraftUpload,
	type GuestDraftUploadCheckpoint,
} from "./guest-draft-client";

const file = new File(["same private bytes"], "reference.png", { type: "image/png" });
const input = {
	capabilityVersion: "cap-v1",
	productKey: "image-nano-banana-2-lite" as const,
	skuKey: "nano-banana-2-lite-1k" as const,
	file,
	prompt: "Keep the subject",
	aspectRatio: "auto" as const,
	turnstileToken: "fresh-challenge",
};
const ready = {
	status: "READY",
	claimToken: "c".repeat(43),
	continueUrl: "/draft/continue",
	productKey: input.productKey,
	skuKey: input.skuKey,
	accessHint: "guest-trial",
};
function requestUrl(url: RequestInfo | URL): string {
	return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}
function fixture(
	firstCompletion: () => Response = () => Response.json({ status: "PENDING", retryAfterMs: 500 }),
) {
	let checkpoint: GuestDraftUploadCheckpoint | null = null;
	let completionCalls = 0;
	const fetcher = vi.fn(async (url: RequestInfo | URL) =>
		requestUrl(url).endsWith("upload-intents")
			? Response.json({
					sessionId: "original-session",
					assetId: "original-asset",
					uploadUrl: "https://storage.test/original-signed-upload",
					completionToken: "b".repeat(43),
					expiresAt: "2035-10-19T12:00:00.000Z",
				})
			: ++completionCalls === 1
				? firstCompletion()
				: Response.json(ready),
	);
	const uploadFile = vi.fn().mockResolvedValue(undefined);
	return {
		get checkpoint() {
			return checkpoint;
		},
		onCheckpoint: (value: GuestDraftUploadCheckpoint) => {
			checkpoint = value;
		},
		fetcher,
		uploadFile,
		options: {
			fetcher: fetcher as typeof fetch,
			uploadFile,
			completion: { maximumAttempts: 1, wait: vi.fn() },
		},
	};
}
describe("guest upload retry keeps the immutable upload intent", () => {
	it("keeps an unconfirmed consumed-completion response unknown without allocating another intent", async () => {
		const f = fixture(() => new Response("unconfirmed", { status: 503 }));
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow("GUEST_UPLOAD_COMPLETION_FAILED");
		f.fetcher.mockResolvedValue(new Response("unconfirmed", { status: 503 }));
		await expect(
			uploadGuestDraft({ ...input, checkpoint: f.checkpoint }, f.options),
		).rejects.toThrow("GUEST_UPLOAD_COMPLETION_FAILED");
		expect(
			f.fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith("upload-intents")),
		).toHaveLength(1);
		expect(f.uploadFile).toHaveBeenCalledOnce();
		expect(f.checkpoint?.handoff).toBeUndefined();
	});
	it("continues the same asset/session after a pending timeout without uploading or allocating again", async () => {
		const f = fixture();
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow("GUEST_UPLOAD_COMPLETION_TIMEOUT");
		expect(f.checkpoint?.uploaded).toBe(true);
		await expect(
			uploadGuestDraft(
				{
					...input,
					checkpoint: f.checkpoint,
					onCheckpoint: f.onCheckpoint,
					turnstileToken: "another-challenge",
				},
				f.options,
			),
		).resolves.toMatchObject({ claimToken: ready.claimToken });
		expect(
			f.fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith("upload-intents")),
		).toHaveLength(1);
		expect(f.uploadFile).toHaveBeenCalledTimes(1);
		const requests = f.fetcher.mock.calls.filter(([url]) =>
			requestUrl(url).endsWith("upload-completions"),
		);
		expect(requests).toHaveLength(2);
	});
	it("retains the same upload after an unknown completion HTTP failure", async () => {
		const f = fixture(() => new Response("unavailable", { status: 503 }));
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow("GUEST_UPLOAD_COMPLETION_FAILED");
		await uploadGuestDraft(
			{ ...input, checkpoint: f.checkpoint, onCheckpoint: f.onCheckpoint },
			f.options,
		);
		expect(f.uploadFile).toHaveBeenCalledTimes(1);
		expect(f.fetcher).toHaveBeenCalledTimes(3);
	});
	it("retries an uncertain PUT against its original staging URL and identical file", async () => {
		const f = fixture(() => Response.json(ready));
		f.uploadFile.mockRejectedValueOnce(new Error("unknown transport result"));
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow("unknown transport result");
		await uploadGuestDraft(
			{ ...input, checkpoint: f.checkpoint, onCheckpoint: f.onCheckpoint },
			f.options,
		);
		expect(
			f.fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith("upload-intents")),
		).toHaveLength(1);
		expect(f.uploadFile.mock.calls[0]![0]).toBe(f.uploadFile.mock.calls[1]![0]);
		expect(f.uploadFile.mock.calls[1]![1]).toBe(file);
	});
	it.each([
		{ prompt: "Changed prompt" },
		{ aspectRatio: "1:1" },
		{ skuKey: "gpt-image-2-1k" },
		{ file: new File(["different bytes"], file.name, { type: file.type }) },
		{ capabilityVersion: "cap-v2" },
	])("refuses changed immutable input on a retained checkpoint %s", async (patch) => {
		const f = fixture();
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow();
		const calls = f.fetcher.mock.calls.length;
		await expect(
			uploadGuestDraft({ ...input, ...patch, checkpoint: f.checkpoint } as never, f.options),
		).rejects.toThrow("GUEST_UPLOAD_RETRY_INPUT_CHANGED");
		expect(f.fetcher).toHaveBeenCalledTimes(calls);
		expect(f.uploadFile).toHaveBeenCalledTimes(1);
	});
	it("refuses an expired session without silently creating a new upload", async () => {
		const f = fixture();
		await expect(
			uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options),
		).rejects.toThrow();
		const calls = f.fetcher.mock.calls.length;
		await expect(
			uploadGuestDraft(
				{ ...input, checkpoint: f.checkpoint },
				{ ...f.options, now: () => new Date("2036-01-01").getTime() },
			),
		).rejects.toThrow("GUEST_UPLOAD_SESSION_EXPIRED");
		expect(f.fetcher).toHaveBeenCalledTimes(calls);
	});
	it("replays a known successful handoff without consuming completion again", async () => {
		const f = fixture(() => Response.json(ready));
		const first = await uploadGuestDraft({ ...input, onCheckpoint: f.onCheckpoint }, f.options);
		expect(await uploadGuestDraft({ ...input, checkpoint: f.checkpoint }, f.options)).toEqual(
			first,
		);
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		expect(f.uploadFile).toHaveBeenCalledTimes(1);
	});
	it.each([
		"GUEST_UPLOAD_CONTENT_REJECTED",
		"GUEST_UPLOAD_REVIEW_REQUIRED",
		"GUEST_UPLOAD_SAFETY_UNAVAILABLE",
	])("stops polling immediately on the terminal server outcome %s", async (code) => {
		const fetcher = vi.fn(async () => Response.json({ status: "FAILED", code }));
		const wait = vi.fn();
		await expect(
			completeGuestDraftUpload(
				{
					sessionId: "session",
					completionToken: "b".repeat(43),
					capabilityVersion: input.capabilityVersion,
					productKey: input.productKey,
					skuKey: input.skuKey,
					sha256: "a".repeat(64),
					prompt: input.prompt,
				},
				{ fetcher, wait },
			),
		).rejects.toThrow(code);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(wait).not.toHaveBeenCalled();
	});
});

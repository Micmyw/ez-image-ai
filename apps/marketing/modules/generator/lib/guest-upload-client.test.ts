import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createGuestDraftUploadIntent,
	uploadGuestDraft,
	uploadGuestFile,
} from "./guest-upload-client";

class FakeXhr {
	static instances: FakeXhr[] = [];
	readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
	onerror: (() => void) | null = null;
	onload: (() => void) | null = null;
	status = 200;
	method = "";
	url = "";
	body: Document | XMLHttpRequestBodyInit | null = null;

	constructor() {
		FakeXhr.instances.push(this);
	}

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	setRequestHeader() {}

	send(body: Document | XMLHttpRequestBodyInit | null) {
		this.body = body;
		this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 } as ProgressEvent);
		this.onload?.();
	}
}

describe("marketing signed guest upload", () => {
	afterEach(() => {
		FakeXhr.instances = [];
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("reports transferred XHR bytes for a direct private PUT", async () => {
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const progress = vi.fn();
		const file = new File([new Uint8Array(8)], "source.png", { type: "image/png" });

		await uploadGuestFile("https://storage.test/signed-private-put", file, progress);

		expect(FakeXhr.instances[0]).toMatchObject({
			method: "PUT",
			url: "https://storage.test/signed-private-put",
			body: file,
		});
		expect(progress).toHaveBeenCalledWith({ loaded: 4, total: 8, percentage: 50 });
	});

	it("uses separate intent/completion calls and returns an opaque form handoff", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		vi.stubGlobal("crypto", {
			subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xaa).buffer) },
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					sessionId: "session_1",
					assetId: "asset_1",
					uploadUrl: "https://storage.test/signed-private-put",
					completionToken: "b".repeat(43),
					expiresAt: "2026-08-28T01:00:00.000Z",
				}),
			)
			.mockResolvedValueOnce(Response.json({ status: "PENDING", retryAfterMs: 250 }))
			.mockResolvedValueOnce(
				Response.json({
					status: "READY",
					claimToken: "c".repeat(43),
					continueUrl: "/draft/continue",
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const file = new File([new Uint8Array(8)], "source.png", { type: "image/png" });

		const upload = uploadGuestDraft({
			saasUrl: "https://app.test",
			capabilityVersion: "guest-v17",
			file,
			prompt: "Replace the background",
			turnstileToken: "turnstile-proof",
		});
		await vi.runAllTimersAsync();

		await expect(upload).resolves.toEqual({
			action: "https://app.test/draft/continue",
			claimToken: "c".repeat(43),
		});

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://app.test/api/media/guest-drafts/upload-intents",
			expect.objectContaining({ credentials: "omit", method: "POST" }),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			3,
			"https://app.test/api/media/guest-drafts/upload-completions",
			expect.objectContaining({ credentials: "omit", method: "POST" }),
		);
		expect(FakeXhr.instances).toHaveLength(1);
		const firstCompletionBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
		const resumedCompletionBody = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string);
		expect(resumedCompletionBody).toEqual(firstCompletionBody);
		expect(resumedCompletionBody.completionToken).toBe("b".repeat(43));
		const serializedCalls = JSON.stringify(fetchMock.mock.calls);
		expect(serializedCalls).not.toContain("data:image");
		expect(serializedCalls).not.toContain("base64");
		expect(serializedCalls).not.toContain('"credentials":"include"');
		expect(serializedCalls).not.toContain('"credentials":"same-origin"');
	});

	it("fails with a stable timeout after bounded non-consuming completion polls", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => Response.json({ status: "PENDING", retryAfterMs: 250 }));
		vi.stubGlobal("fetch", fetchMock);

		const completion = import("./guest-upload-client").then(({ completeGuestDraftUpload }) =>
			completeGuestDraftUpload(
				{
					saasUrl: "https://app.test",
					sessionId: "session_1",
					completionToken: "b".repeat(43),
					capabilityVersion: "guest-v17",
					sha256: "a".repeat(64),
					prompt: "Replace the background",
				},
				{ maximumAttempts: 3 },
			),
		);
		const timeout = expect(completion).rejects.toThrow("GUEST_UPLOAD_COMPLETION_TIMEOUT");
		await vi.runAllTimersAsync();
		await timeout;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("allows task-owned loopback HTTP storage in local testing but rejects remote HTTP", async () => {
		const intent = {
			sessionId: "session_1",
			assetId: "asset_1",
			uploadUrl: "http://127.0.0.1:9000/media-private/signed-put",
			completionToken: "b".repeat(43),
			expiresAt: "2026-08-28T01:00:00.000Z",
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(intent)));

		await expect(
			createGuestDraftUploadIntent({
				saasUrl: "http://127.0.0.1:3000",
				capabilityVersion: "guest-v17",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "turnstile-proof",
			}),
		).resolves.toEqual(intent);

		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ...intent, uploadUrl: "http://storage.example.com/signed-put" }),
				),
		);
		await expect(
			createGuestDraftUploadIntent({
				saasUrl: "http://127.0.0.1:3000",
				capabilityVersion: "guest-v17",
				contentType: "image/png",
				bytes: 8,
				sha256: "a".repeat(64),
				turnstileToken: "turnstile-proof",
			}),
		).rejects.toThrow("GUEST_UPLOAD_INTENT_INVALID");
	});
});

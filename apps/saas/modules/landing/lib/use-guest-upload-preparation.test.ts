import { describe, expect, it, vi } from "vitest";

import type { GuestDraftUploadCheckpoint, GuestUploadPreparationInput } from "./guest-draft-client";
import { createGuestPreparationController } from "./use-guest-upload-preparation";

const a = new File(["a"], "a.png", { type: "image/png" });
const b = new File(["b"], "b.png", { type: "image/png" });
const input = (file: File) => ({
	file,
	capabilityVersion: "cap-v1",
	productKey: "image-nano-banana-2-lite" as const,
	turnstileToken: "challenge",
});
function checkpoint(file: File): GuestDraftUploadCheckpoint {
	return {
		fileFingerprint: file.name,
		preparedFile: file,
		sha256: "a".repeat(64),
		requestId: crypto.randomUUID(),
		capabilityVersion: "cap-v1",
		intentProductKey: "image-nano-banana-2-lite",
		uploaded: true,
		sealed: true,
		intent: {
			sessionId: file.name,
			assetId: file.name,
			completionToken: "c".repeat(43),
			uploadUrl: "https://storage.test/upload",
			expiresAt: "2035-01-01T00:00:00.000Z",
		},
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("early guest preparation ownership", () => {
	it("shares the active preparation with Generate without a second request", async () => {
		const pending = deferred<GuestDraftUploadCheckpoint>();
		const prepare = vi.fn(() => pending.promise);
		const controller = createGuestPreparationController(prepare);
		controller.select(a);
		const early = controller.ensure(input(a));
		const generation = controller.ensure(input(a));
		expect(generation).toBe(early);
		expect(prepare).toHaveBeenCalledOnce();
		pending.resolve(checkpoint(a));
		await early;
	});
	it("ignores all A callbacks after B is selected and only reports B as sealed", async () => {
		const pendingA = deferred<GuestDraftUploadCheckpoint>();
		const pendingB = deferred<GuestDraftUploadCheckpoint>();
		const requests: GuestUploadPreparationInput[] = [];
		const controller = createGuestPreparationController(
			vi.fn((request) => {
				requests.push(request);
				return request.file === a ? pendingA.promise : pendingB.promise;
			}),
		);
		const onSealed = vi.fn();
		const onChange = vi.fn();
		controller.select(a);
		const earlyA = controller
			.ensure(input(a), { onSealed, onChange })
			.catch((error: Error) => error.message);
		controller.select(b);
		const earlyB = controller.ensure(input(b), { onSealed, onChange });
		expect(requests.map((request) => request.file)).toEqual([a]);
		const before = onChange.mock.calls.length;
		requests[0]?.onCheckpoint?.(checkpoint(a));
		pendingA.resolve(checkpoint(a));
		expect(await earlyA).toBe("GUEST_UPLOAD_REPLACED");
		expect(requests.map((request) => request.file)).toEqual([a, b]);
		expect(onChange).toHaveBeenCalledTimes(before);
		expect(controller.read()?.checkpoint).toBeNull();
		requests[1]?.onCheckpoint?.(checkpoint(b));
		pendingB.resolve(checkpoint(b));
		await earlyB;
		expect(controller.read()?.checkpoint?.preparedFile).toBe(b);
		expect(onSealed).toHaveBeenCalledOnce();
		expect(onSealed.mock.calls[0]?.[0].preparedFile).toBe(b);
	});
	it("clear prevents a late sealing result from becoming the selected file", async () => {
		const pending = deferred<GuestDraftUploadCheckpoint>();
		const controller = createGuestPreparationController(vi.fn(() => pending.promise));
		const onSealed = vi.fn();
		controller.select(a);
		const early = controller.ensure(input(a), { onSealed }).catch((error: Error) => error.message);
		controller.select(null);
		pending.resolve(checkpoint(a));
		expect(await early).toBe("GUEST_UPLOAD_REPLACED");
		expect(controller.read()).toBeNull();
		expect(onSealed).not.toHaveBeenCalled();
	});
	it("retains a checkpoint after failure and passes it to an explicit retry", async () => {
		const original = { ...checkpoint(a), sealed: false };
		const prepare = vi.fn(async (request: GuestUploadPreparationInput) => {
			if (!request.checkpoint) {
				request.onCheckpoint?.(original);
				throw new Error("unknown sealing response");
			}
			return { ...request.checkpoint, sealed: true };
		});
		const controller = createGuestPreparationController(prepare);
		controller.select(a);
		await expect(controller.ensure(input(a))).rejects.toThrow("unknown sealing response");
		await controller.ensure(input(a));
		expect(prepare.mock.calls[1]?.[0].checkpoint).toBe(original);
	});
});

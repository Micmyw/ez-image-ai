import { TestMediaSafetyAdapter } from "@repo/ai";
import { isApprovedImageResult } from "@repo/config/image-result";
import { describe, expect, it, vi } from "vitest";

import { mergeImageResult } from "./image-result";
import { imageResultFixture } from "./image-result.fixture";
import { submitImageResult, pollImageResult } from "./review-image-result";

function setup() {
	const receipt = imageResultFixture();
	const order: string[] = [];
	const submitImage = vi.fn(async (input: { idempotencyKey: string }) => {
		order.push("seeapi-post");
		return {
			...receipt.submission,
			idempotency: { ...receipt.submission.idempotency, key: input.idempotencyKey },
		};
	});
	const safety = Object.assign(new TestMediaSafetyAdapter(), {
		submitImage,
		retrieveImage: vi.fn(async () => receipt.decision!),
	});
	const write = vi.fn(async (value: typeof receipt) => {
		order.push(value.decision?.decision === "ALLOW" ? "visible" : "accepted-record");
		return value;
	});
	const prepare = vi.fn(async () => {
		order.push("convert");
		return { assetUrl: "data:image/jpeg;base64,AA==", bytes: 10, checksum: "a".repeat(64) };
	});
	return { receipt, order, submitImage, safety, write, prepare };
}

describe("callback output critical path", () => {
	it.each(["png", "jpg"])(
		"submits %s URL before recording; never downloads/converts the source",
		async (format) => {
			const f = setup();
			const completion = {
				...f.receipt.completion,
				outputUrl: `https://tempfile.aiquickdraw.com/result.${format}`,
			};
			const receipt = await submitImageResult(f.receipt.context, completion, f);
			expect(f.order).toEqual(["seeapi-post", "accepted-record"]);
			expect(f.prepare).not.toHaveBeenCalled();
			expect(f.submitImage.mock.calls[0]![0]).toMatchObject({ assetUrl: completion.outputUrl });
			expect(receipt.preparedIdentity).toBeUndefined();
		},
	);
	it.each(["gif", "svg", "webp"])("uses the shared thumbnail converter for %s", async (format) => {
		const f = setup();
		await submitImageResult(
			f.receipt.context,
			{ ...f.receipt.completion, outputUrl: `https://tempfile.aiquickdraw.com/result.${format}` },
			f,
		);
		expect(f.order).toEqual(["convert", "seeapi-post", "accepted-record"]);
		expect(f.submitImage.mock.calls[0]![0]).toMatchObject({
			assetUrl: "data:image/jpeg;base64,AA==",
		});
	});
	it("replays the same provider key and body after a lost acceptance record", async () => {
		const f = setup();
		f.write.mockRejectedValueOnce(new Error("storage unavailable"));
		await expect(submitImageResult(f.receipt.context, f.receipt.completion, f)).rejects.toThrow();
		await submitImageResult(f.receipt.context, f.receipt.completion, f);
		expect(f.submitImage.mock.calls[0]).toEqual(f.submitImage.mock.calls[1]);
	});
	it("publishes authentic ALLOW without a database, archive or settlement dependency", async () => {
		const f = setup();
		let receipt = await submitImageResult(f.receipt.context, f.receipt.completion, f);
		receipt = await pollImageResult(receipt, { ...f, wait: async () => {}, maximumQueries: 1 });
		expect(isApprovedImageResult(receipt)).toBe(true);
		expect(f.order).toEqual(["seeapi-post", "accepted-record", "visible"]);
		expect(f.submitImage).toHaveBeenCalledTimes(1);
	});
	it("respects first 2-second and subsequent Retry-After delays", async () => {
		const f = setup();
		let now = Date.now();
		f.safety.retrieveImage.mockResolvedValueOnce({
			decision: "REVIEW",
			reasonCode: "IMAGE_PROCESSING",
			ruleVersion: f.receipt.submission.ruleVersion,
			retryAfterMs: 3500,
		});
		const wait = vi.fn(async (ms: number) => {
			now += ms;
		});
		await pollImageResult(
			await submitImageResult(f.receipt.context, f.receipt.completion, { ...f, now: () => now }),
			{ ...f, now: () => now, wait },
		);
		expect(wait.mock.calls.map(([ms]) => ms)).toEqual([2000, 3500]);
	});
	it("never exposes pending, rejected, forged-task or expired results", () => {
		const f = imageResultFixture();
		for (const decision of [
			undefined,
			{ ...f.decision!, decision: "REJECT" as const },
			{ ...f.decision!, evidence: { ...f.decision!.evidence!, requestId: "other" } },
		])
			expect(isApprovedImageResult({ ...f, decision })).toBe(false);
		expect(isApprovedImageResult(f, f.context.expiresAt + 1)).toBe(false);
	});
	it("converts proven invalid media once and retains the failed task for diagnostics", async () => {
		const f = setup();
		const initial = await submitImageResult(f.receipt.context, f.receipt.completion, f);
		const invalid = {
			...initial,
			decision: {
				decision: "ERROR" as const,
				reasonCode: "MODERATION_MEDIA_INVALID",
				ruleVersion: initial.submission.ruleVersion,
				evidence: {
					requestId: initial.submission.moderationTaskId,
					models: ["nsfw-filter-2"],
					operations: 1,
					scores: {},
					seeapiFailure: {
						taskId: initial.submission.moderationTaskId,
						status: "failed" as const,
						code: "MEDIA_INVALID",
					},
				},
			},
		};
		f.submitImage.mockImplementationOnce(async (input) => ({
			...initial.submission,
			moderationTaskId: "thumbnail-review",
			idempotency: { ...initial.submission.idempotency, key: input.idempotencyKey },
		}));
		const converted = await pollImageResult(invalid, { ...f, maximumQueries: 0 });
		expect(converted.reviewInput).toBe("thumbnail");
		expect(converted.priorReview?.decision).toEqual(invalid.decision);
		expect(converted.submission.idempotency.key).not.toBe(initial.submission.idempotency.key);
		expect(f.prepare).toHaveBeenCalledOnce();
		expect(mergeImageResult(invalid, converted)).toMatchObject({ reviewInput: "thumbnail" });
		expect(mergeImageResult(converted, initial)).toBe(converted);
		for (const malformed of [
			{ ...invalid, decision: { ...invalid.decision, decision: "REJECT" as const } },
			{
				...invalid,
				decision: {
					...invalid.decision,
					evidence: { ...invalid.decision.evidence, requestId: "wrong-task" },
				},
			},
		]) {
			await pollImageResult(malformed, { ...f, maximumQueries: 0 });
		}
		expect(f.prepare).toHaveBeenCalledOnce();
	});
	it("refuses replacement URLs and never downgrades an approved receipt", () => {
		const f = imageResultFixture();
		expect(mergeImageResult(f, { ...f, decision: undefined, approvedAt: undefined })).toBe(f);
		expect(() =>
			mergeImageResult(f, {
				...f,
				completion: { ...f.completion, outputUrl: "https://tempfile.aiquickdraw.com/changed.png" },
			}),
		).toThrow("CONFLICT");
	});
});

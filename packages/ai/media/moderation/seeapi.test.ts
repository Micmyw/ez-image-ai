import { describe, expect, it, vi } from "vitest";

import { SeeapiSafetyAdapter } from "./seeapi";

const input = {
	assetUrl: "https://private.example/image.png?signed=private",
	ruleVersion: "test-rule",
	idempotencyKey: "asset-verification-1",
};
const task = (status = "succeeded", flagged = false) => ({
	id: "task_test",
	object: "inference",
	model: "nsfw-filter",
	endpoint: "image-moderation",
	provider: "seeapi",
	status,
	result:
		status === "succeeded"
			? {
					type: "json",
					data: {
						flagged,
						categories: { nsfw: flagged ? ["test-category"] : [], special_care: [] as string[] },
					},
				}
			: null,
	error: null,
});
function fixture(body: unknown, status = 200) {
	const fetcher = vi.fn<typeof fetch>(async (_url, request) => {
		// Match Workers: redirect="error" fails before a request can be sent.
		if (request?.redirect === "error") throw new TypeError("Invalid redirect value");
		return Response.json(body, { status });
	});
	return {
		fetcher,
		adapter: new SeeapiSafetyAdapter({ apiKey: "fixture-secret", fetch: fetcher }),
	};
}
describe("SeeAPI image moderation", () => {
	it("submits once with idempotency and strict settings, without approving acceptance", async () => {
		const { adapter, fetcher } = fixture(task("processing"), 202);
		expect(await adapter.submitImage(input)).toMatchObject({
			moderationTaskId: "task_test",
			status: "RUNNING",
			idempotency: { key: input.idempotencyKey, providerSupported: true },
		});
		const [url, request] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://api.seeapi.com/v1/inferences");
		expect(request?.redirect).toBe("manual");
		expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(input.idempotencyKey);
		expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer fixture-secret");
		expect(JSON.parse(request?.body as string)).toMatchObject({
			model: "nsfw-filter",
			endpoint: "image-moderation",
			provider: "seeapi",
			input: { image_url: input.assetUrl, threshold_offset: 0, strict_special_care: true },
		});
	});
	it.each([301, 302, 303, 307, 308])(
		"rejects HTTP %s without following a credentialed redirect",
		async (status) => {
			const { adapter, fetcher } = fixture(task(), status);
			await expect(adapter.submitImage(input)).rejects.toThrow("MODERATION_UNAVAILABLE");
			expect(
				await adapter.retrieveImage({ ...input, moderationTaskId: "task_test" }),
			).toMatchObject({ decision: "ERROR" });
			expect(fetcher).toHaveBeenCalledTimes(2);
			for (const [, request] of fetcher.mock.calls) expect(request?.redirect).toBe("manual");
		},
	);
	it.each(["queued", "processing"])("keeps %s pending", async (status) => {
		expect(
			await fixture(task(status)).adapter.retrieveImage({
				...input,
				moderationTaskId: "task_test",
			}),
		).toMatchObject({ decision: "REVIEW", reasonCode: "IMAGE_PROCESSING" });
	});
	it.each([false, true])("interprets succeeded with flagged=%s", async (flagged) => {
		const result = await fixture(task("succeeded", flagged)).adapter.retrieveImage({
			...input,
			moderationTaskId: "task_test",
		});
		expect(result.decision).toBe(flagged ? "REJECT" : "ALLOW");
		expect(JSON.stringify(result)).not.toMatch(/fixture-secret|signed=private/);
	});
	it.each([
		{},
		{ ...task(), id: "wrong-task" },
		{ ...task(), result: null },
		{ ...task(), error: { code: "failed", message: "private detail" } },
		{ ...task(), status: "failed" },
	])("fails closed for malformed or failed results", async (response) => {
		expect(
			await fixture(response).adapter.retrieveImage({ ...input, moderationTaskId: "task_test" }),
		).toMatchObject({ decision: "ERROR" });
	});
	it("keeps special-care matches pending without claiming a definite violation", async () => {
		const response = task();
		response.result!.data.categories.special_care = ["sensitive-label"];
		expect(
			await fixture(response).adapter.retrieveImage({ ...input, moderationTaskId: "task_test" }),
		).toMatchObject({ decision: "REVIEW" });
	});
});

import { SEEAPI_TEXT_CATEGORIES, SEEAPI_TEXT_SAFETY_RULE_VERSION } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { createSeeapiTextScanner } from "./seeapi-text";

const input = { text: "A mountain landscape", ruleVersion: SEEAPI_TEXT_SAFETY_RULE_VERSION };
const approved = {
	decision: "ALLOW" as const,
	reasonCode: "WAFFO_PROMPT_ALLOWED",
	evidence: {
		requestId: "waffo-1",
		action: "allow" as const,
		semanticStatus: "scored",
		matchedCategories: [],
	},
};
function result(flagged = false) {
	return {
		flagged,
		threshold: 0.3,
		categories: Object.fromEntries(
			SEEAPI_TEXT_CATEGORIES.map((category) => [
				category,
				{
					score: flagged && category === "sexual_explicit" ? 0.9 : 0.01,
					flagged: flagged && category === "sexual_explicit",
				},
			]),
		),
	};
}
function task(data: unknown = result()) {
	return {
		id: "task_1",
		object: "inference",
		model: "text-nsfw-filter",
		endpoint: "text-moderation",
		provider: "seeapi",
		status: "succeeded",
		error: null,
		result: { type: "json", data },
	};
}
function scanner(responses: unknown[]) {
	const fetcher = vi.fn<typeof fetch>(async () => {
		const value = responses.shift();
		if (value instanceof Error) throw value;
		return value instanceof Response ? value : Response.json(value);
	});
	const fallbackScan = vi.fn(async () => approved);
	return {
		fetcher,
		fallbackScan,
		scan: createSeeapiTextScanner({ apiKey: "secret", fetch: fetcher, fallbackScan }),
	};
}

describe("SeeAPI text primary with technical-only Waffo fallback", () => {
	it.each([false, true])(
		"uses a complete SeeAPI decision without invoking Waffo (flagged=%s)",
		async (flagged) => {
			const { scan, fetcher, fallbackScan } = scanner([task(result(flagged))]);
			const decision = await scan(input);
			expect(decision).toMatchObject({
				decision: flagged ? "REJECT" : "ALLOW",
				evidence: { requestId: "task_1", seeapiText: { flagged, threshold: 0.3 } },
			});
			expect(fallbackScan).not.toHaveBeenCalled();
			const [url, init] = fetcher.mock.calls[0]!;
			expect(url).toBe("https://api.seeapi.com/v1/inferences");
			expect(init).toMatchObject({ method: "POST", redirect: "manual" });
			expect(JSON.parse(init!.body as string)).toEqual({
				model: "text-nsfw-filter",
				endpoint: "text-moderation",
				provider: "seeapi",
				input: { text: input.text, threshold: 0.3 },
			});
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
			expect(JSON.stringify(decision)).not.toMatch(/secret|mountain/);
		},
	);
	it.each([429, 408, 503, 504])(
		"uses Waffo for HTTP %s and records the primary failure",
		async (status) => {
			const { scan, fallbackScan } = scanner([Response.json({}, { status })]);
			expect(await scan(input)).toMatchObject({
				decision: "ALLOW",
				evidence: {
					waffo: approved.evidence,
					textFallback: { primaryProvider: "seeapi", fallbackProvider: "waffo" },
				},
			});
			expect(fallbackScan).toHaveBeenCalledExactlyOnceWith(input.text);
		},
	);
	it.each(["RATE_LIMITED", "PROVIDER_TIMEOUT", "DETECTION_REPORT_FAILED", "INTERNAL_ERROR"])(
		"uses Waffo for an authenticated failed task: %s",
		async (code) => {
			const { scan } = scanner([{ ...task(), status: "failed", result: null, error: { code } }]);
			expect(await scan(input)).toMatchObject({
				decision: "ALLOW",
				evidence: { textFallback: { primaryTaskId: "task_1" } },
			});
		},
	);
	it.each([
		new TypeError("fetch failed"),
		new DOMException("timeout", "AbortError"),
		{},
		{ ...task(), result: null },
	])("uses fallback for technical errors or unusable responses", async (response) => {
		const { scan, fallbackScan } = scanner([response]);
		expect(await scan(input)).toMatchObject({ decision: "ALLOW" });
		expect(fallbackScan).toHaveBeenCalledOnce();
	});
	it.each([
		{ ...task(result(true)), error: { code: "INTERNAL_ERROR" } },
		{ ...task({ flagged: true }), model: "wrong" },
		task({ flagged: true, categories: [] }),
		Response.json(task(result(true)), { status: 503 }),
		task({ flagged: false, categories: { sexual_explicit: { flagged: true } } }),
		task({ flagged: false, categories: { sexual_explicit: { flagged: false, score: 0.9 } } }),
		{ ...task(result(true)), status: "failed", error: { code: "RATE_LIMITED" } },
		{ ...task(result(true)), status: "processing" },
	])("retains restrictive signals in inconsistent responses without fallback", async (response) => {
		const { scan, fallbackScan } = scanner([response]);
		expect(await scan(input)).toMatchObject({ decision: "REVIEW" });
		expect(fallbackScan).not.toHaveBeenCalled();
	});
	it.each([400, 401, 403, 422])(
		"does not fall back for invalid configuration or input: %s",
		async (status) => {
			const { scan, fallbackScan } = scanner([Response.json({}, { status })]);
			expect(await scan(input)).toMatchObject({ decision: "ERROR" });
			expect(fallbackScan).not.toHaveBeenCalled();
		},
	);
	it.each(["CONTENT_POLICY_VIOLATION", "UNKNOWN_CODE"])(
		"does not reinterpret unclassified terminal failures as technical: %s",
		async (code) => {
			const { scan, fallbackScan } = scanner([
				{ ...task(), status: "failed", result: null, error: { code } },
			]);
			expect(await scan(input)).toMatchObject({
				decision: "ERROR",
				reasonCode: "SEEAPI_TEXT_TERMINAL_UNCLASSIFIED",
			});
			expect(fallbackScan).not.toHaveBeenCalled();
		},
	);
	it("keeps polling one accepted pending task across retries without resubmitting or falling back", async () => {
		const pending = { ...task(), status: "processing", result: null };
		const { scan, fetcher, fallbackScan } = scanner([pending, pending, task()]);
		expect(await scan(input)).toMatchObject({
			decision: "ERROR",
			reasonCode: "MODERATION_SUBMISSION_UNCERTAIN",
		});
		expect(await scan(input)).toMatchObject({ decision: "ALLOW" });
		expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET", "GET"]);
		expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.seeapi.com/v1/inferences/task_1");
		expect(fallbackScan).not.toHaveBeenCalled();
	});
	it("reuses the submission key after a transport failure", async () => {
		const { scan, fetcher, fallbackScan } = scanner([new TypeError("fetch failed"), task()]);
		fallbackScan.mockRejectedValue(new Error("unavailable"));
		expect(await scan(input)).toMatchObject({ decision: "ERROR" });
		expect(await scan(input)).toMatchObject({ decision: "ALLOW" });
		expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
			new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key"),
		);
	});
	it("passes an explicit persisted moderation key to the provider", async () => {
		const { scan, fetcher } = scanner([task()]);
		await scan({ ...input, idempotencyKey: "video-text-job-1" });
		expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
			"video-text-job-1",
		);
	});
	it.each([
		{ decision: "ALLOW", reasonCode: "WAFFO_PROMPT_ALLOWED" },
		{ ...approved, evidence: { ...approved.evidence, semanticStatus: "shadow_scored" } },
	])("rejects incomplete fallback approvals", async (value) => {
		const scan = createSeeapiTextScanner({
			apiKey: "secret",
			fetch: async () => Response.json({}, { status: 429 }),
			fallbackScan: async () => value as typeof approved,
		});
		expect(await scan(input)).toMatchObject({
			decision: "ERROR",
			reasonCode: "MODERATION_INVALID_RESPONSE",
		});
	});
	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"preserves a restrictive/error fallback verdict: %s",
		async (decision) => {
			const scan = createSeeapiTextScanner({
				apiKey: "secret",
				fetch: async () => Response.json({}, { status: 429 }),
				fallbackScan: async () => ({ decision, reasonCode: "WAFFO_DENIED" }),
			});
			expect(await scan(input)).toMatchObject({ decision });
		},
	);
	it("bounds response size before falling back", async () => {
		const { scan, fallbackScan } = scanner([Response.json({ padding: "x".repeat(65_537) })]);
		expect(await scan(input)).toMatchObject({
			decision: "ALLOW",
			evidence: { textFallback: { primaryReasonCode: "MODERATION_INVALID_RESPONSE" } },
		});
		expect(fallbackScan).toHaveBeenCalledOnce();
	});
	it("aborts timed-out SeeAPI requests before invoking fallback", async () => {
		let aborted = false;
		const fallbackScan = vi.fn(async () => {
			expect(aborted).toBe(true);
			return approved;
		});
		const scan = createSeeapiTextScanner({
			apiKey: "secret",
			timeoutMs: 5,
			fallbackScan,
			fetch: async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("timeout", "AbortError"));
					});
				}),
		});
		expect(await scan(input)).toMatchObject({
			decision: "ALLOW",
			evidence: { textFallback: { primaryReasonCode: "MODERATION_TIMEOUT" } },
		});
	});
});

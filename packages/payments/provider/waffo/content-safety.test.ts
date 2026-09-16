import { createHash, generateKeyPairSync, verify } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWaffoPromptScanner } from "./content-safety";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const environment = {
	WAFFO_ENVIRONMENT: "prod",
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	WAFFO_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const allowed = {
	action: "allow",
	reasonCode: "allowed",
	requestId: "request-fixture-1",
	semanticStatus: "scored",
	matchedCategories: [],
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(verdict: unknown = allowed, status = 200) {
	const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: verdict }, { status }));
	vi.stubGlobal("fetch", fetcher);
	return { scan: createWaffoPromptScanner(environment), fetcher };
}

describe("Waffo production prompt scanning", () => {
	it("uses merchant signing independently of checkout environment and webhook credentials", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: allowed }));
		vi.stubGlobal("fetch", fetcher);
		const scan = createWaffoPromptScanner({
			WAFFO_ENVIRONMENT: "test",
			WAFFO_MERCHANT_ID: environment.WAFFO_MERCHANT_ID,
			WAFFO_PRIVATE_KEY: environment.WAFFO_PRIVATE_KEY,
		});
		expect(await scan("A mountain landscape")).toMatchObject({ decision: "ALLOW" });
		expect(fetcher.mock.calls[0]![0]).toBe(
			"https://api.waffo.ai/v1/actions/verification/scan-prompt",
		);
	});
	it("signs the documented semantic-enforcement request and retains only redacted evidence", async () => {
		const { scan, fetcher } = fixture({
			...allowed,
			prompt: "private prompt",
			secret: "do-not-store",
		});
		const result = await scan("private prompt");
		expect(result).toMatchObject({
			decision: "ALLOW",
			evidence: { requestId: allowed.requestId, action: "allow" },
		});
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe("https://api.waffo.ai/v1/actions/verification/scan-prompt");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			signal: expect.any(AbortSignal),
		});
		const body = init?.body;
		if (typeof body !== "string") throw new Error("Expected the signed JSON request body");
		expect(JSON.parse(body)).toEqual({
			prompt: "private prompt",
			locale: "en",
			semantic: "enforce",
		});
		const headers = new Headers(init?.headers);
		expect(headers.has("x-idempotency-key")).toBe(false);
		expect(headers.get("x-merchant-id")).toBe(environment.WAFFO_MERCHANT_ID);
		const hash = createHash("sha256").update(body).digest("base64");
		const canonical = `POST\n/v1/actions/verification/scan-prompt\n${headers.get("x-timestamp")}\n${hash}`;
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(canonical),
				publicKey,
				Buffer.from(headers.get("x-signature") ?? "", "base64"),
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(/private prompt|do-not-store|PRIVATE KEY/);
	});

	it.each([
		["block", "restricted_content", "skipped_rules_block", "REJECT"],
		["review", "review_required", "scored", "REVIEW"],
		["review", "service_degraded", "provider_error", "ERROR"],
	] as const)(
		"stops generation for %s / %s",
		async (action, reasonCode, semanticStatus, decision) => {
			const { scan } = fixture({
				...allowed,
				action,
				reasonCode,
				semanticStatus,
				matchedCategories: ["adult_nsfw"],
			});
			expect(await scan("synthetic test prompt")).toMatchObject({ decision });
		},
	);

	it.each([
		null,
		{},
		{ ...allowed, action: "unknown" },
		{ ...allowed, requestId: "" },
		{ ...allowed, reasonCode: "service_degraded" },
		{ ...allowed, matchedCategories: ["adult_nsfw"] },
		{ ...allowed, semanticStatus: "disabled" },
		{ ...allowed, semanticStatus: "shadow_scored" },
		{ ...allowed, semanticStatus: "skipped_budget" },
		{ ...allowed, semanticStatus: "provider_error" },
		{ ...allowed, semanticStatus: "provider_timeout" },
		{ ...allowed, warnings: [{ message: "partial" }] },
	])("fails closed for incomplete or inconsistent verdicts", async (response) => {
		expect(await fixture(response).scan("test prompt")).toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
		});
	});

	it.each(["", " \n ", "x".repeat(10_001)])(
		"rejects invalid input without making an API request",
		async (prompt) => {
			const { scan, fetcher } = fixture();
			expect(await scan(prompt)).toMatchObject({
				decision: "ERROR",
				reasonCode: "MODERATION_INVALID_INPUT",
			});
			expect(fetcher).not.toHaveBeenCalled();
		},
	);

	it.each([400, 401, 429, 500, 503])(
		"does not accept an allow-shaped HTTP %s response or retry it inline",
		async (status) => {
			const { scan, fetcher } = fixture(allowed, status);
			expect(await scan("test prompt")).toMatchObject({ decision: "ERROR" });
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);

	it("fails closed without exposing upstream errors or credentials", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(`private prompt ${environment.WAFFO_PRIVATE_KEY}`);
			}),
		);
		expect(await createWaffoPromptScanner(environment)("private prompt")).toEqual({
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
		});
	});

	it("bounds response bytes even when content-length is absent", async () => {
		const { scan, fetcher } = fixture();
		fetcher.mockResolvedValue(new Response("x".repeat(65_537)));
		expect(await scan("test prompt")).toMatchObject({ decision: "ERROR" });
	});

	it("rejects malformed JSON", async () => {
		const { scan, fetcher } = fixture();
		fetcher.mockResolvedValue(new Response("not json"));
		expect(await scan("test prompt")).toMatchObject({ decision: "ERROR" });
	});

	it("aborts a stalled request after the shared 15-second deadline", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), milliseconds);
			return controller.signal;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
							once: true,
						});
					}),
			),
		);
		const pending = createWaffoPromptScanner(environment)("test prompt");
		await vi.advanceTimersByTimeAsync(15_001);
		expect(await pending).toMatchObject({ decision: "ERROR" });
	});

	it("requires production credentials before issuing any request", () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect(() => createWaffoPromptScanner({ ...environment, WAFFO_PRIVATE_KEY: "" })).toThrow(
			"WAFFO_CONFIGURATION_INCOMPLETE",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

import { createHash, generateKeyPairSync, verify } from "node:crypto";

import {
	createVideoTextSafetyProfile,
	isApprovedVideoTextDecision,
} from "@repo/config/video-text-safety";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moderateVideoText } from "./text-moderation";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const environment = {
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const profile = createVideoTextSafetyProfile();
const input = { text: "A red balloon", ruleVersion: profile.ruleVersion };
const allowed = {
	action: "allow",
	reasonCode: "allowed",
	requestId: "waffo-test",
	semanticStatus: "scored",
	matchedCategories: [],
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("video Waffo prompt moderation", () => {
	it("uses the real merchant-signed scanner with semantic enforcement", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: allowed }));
		vi.stubGlobal("fetch", fetcher);
		const decision = await moderateVideoText(input, environment);
		expect(isApprovedVideoTextDecision(decision, profile)).toBe(true);
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe("https://api.waffo.ai/v1/actions/verification/scan-prompt");
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		const body = init?.body as string;
		expect(JSON.parse(body)).toEqual({ prompt: input.text, locale: "en", semantic: "enforce" });
		const headers = new Headers(init?.headers);
		const hash = createHash("sha256").update(body).digest("base64");
		const signed = `POST\n/v1/actions/verification/scan-prompt\n${headers.get("x-timestamp")}\n${hash}`;
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(signed),
				publicKey,
				Buffer.from(headers.get("x-signature") ?? "", "base64"),
			),
		).toBe(true);
	});
	it.each([
		[
			{
				...allowed,
				action: "block",
				reasonCode: "restricted_content",
				matchedCategories: ["adult_nsfw"],
			},
			"REJECT",
		],
		[{ ...allowed, action: "review", reasonCode: "review_required" }, "REVIEW"],
		[{ ...allowed, semanticStatus: "provider_timeout" }, "ERROR"],
		[{ ...allowed, semanticStatus: "shadow_scored" }, "ERROR"],
		[{ ...allowed, warnings: ["degraded"] }, "ERROR"],
	] as const)(
		"fails closed for a restrictive or incomplete Waffo verdict",
		async (verdict, expected) => {
			const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: verdict }));
			vi.stubGlobal("fetch", fetcher);
			expect(await moderateVideoText(input, environment)).toMatchObject({
				decision: expected,
				ruleVersion: profile.ruleVersion,
			});
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);
	it("does not bypass or retry an unavailable scanner", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ data: allowed }, { status: 503 }),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await moderateVideoText(input, environment)).toMatchObject({
			decision: "ERROR",
			reasonCode: "MODERATION_SERVICE_ERROR",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("rejects absent credentials and an unknown policy before making requests", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect(await moderateVideoText(input, {})).toMatchObject({
			decision: "ERROR",
			reasonCode: "MODERATION_CONFIGURATION_ERROR",
		});
		expect(
			await moderateVideoText({ ...input, ruleVersion: "old-rule" }, environment),
		).toMatchObject({ decision: "ERROR", reasonCode: "VIDEO_TEXT_SAFETY_PROFILE_INVALID" });
		expect(fetcher).not.toHaveBeenCalled();
	});
});

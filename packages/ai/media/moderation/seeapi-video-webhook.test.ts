import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifySeeapiVideoWebhook } from "./seeapi-video-webhook";

const nowSeconds = 1_800_000_000;
const secret = "whsec_fixture_only_not_a_real_key";
const keyId = "whkey_fixture";
const encoder = new TextEncoder();
const body = encoder.encode('{"id":"fixture-task","text":"你好"}');
function signedInput(rawBody = body, timestampHeader = String(nowSeconds), keySecret = secret) {
	const signatureHeader = `v1=${createHmac("sha256", keySecret)
		.update(timestampHeader + ".")
		.update(rawBody)
		.digest("hex")}`;
	return {
		rawBody,
		timestampHeader,
		signatureHeader,
		signingKeyHeader: keyId,
		keys: { [keyId]: secret },
		nowSeconds,
	};
}

describe("SeeAPI raw-byte webhook signature", () => {
	it("verifies the official timestamp-dot-rawBytes algorithm with an independent Node signer", async () => {
		expect(await verifySeeapiVideoWebhook(signedInput())).toBe(true);
	});
	it("accepts the official case-insensitive v1/hex signature format", async () => {
		const input = signedInput();
		expect(
			await verifySeeapiVideoWebhook({
				...input,
				signatureHeader: input.signatureHeader.toUpperCase(),
			}),
		).toBe(true);
	});
	it.each([-300, 300])("accepts the exact %i-second clock boundary", async (offset) => {
		expect(await verifySeeapiVideoWebhook(signedInput(body, String(nowSeconds + offset)))).toBe(
			true,
		);
	});
	it.each([-301, 301])("rejects timestamps %i seconds from the clock", async (offset) => {
		expect(await verifySeeapiVideoWebhook(signedInput(body, String(nowSeconds + offset)))).toBe(
			false,
		);
	});
	it.each([
		nowSeconds - 300.001,
		nowSeconds + 300.001,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects an invalid clock/window %s", async (clock) => {
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), nowSeconds: clock })).toBe(false);
	});
	it("defaults to the current clock when no explicit clock is provided", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
		try {
			expect(await verifySeeapiVideoWebhook({ ...signedInput(), nowSeconds: undefined })).toBe(
				true,
			);
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		null,
		"",
		" 1800000000",
		"1800000000 ",
		"1800000000,1800000000",
		"+1800000000",
		"1.8e9",
		"1800000000.0",
		"-1800000000",
		"9007199254740992",
		"١٨٠٠٠٠٠٠٠٠",
	])("rejects malformed/unsafe timestamp %s", async (timestampHeader) => {
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), timestampHeader })).toBe(false);
	});
	it("signs the original timestamp representation including leading zeros", async () => {
		const padded = signedInput(body, "001800000000");
		expect(await verifySeeapiVideoWebhook(padded)).toBe(true);
		expect(
			await verifySeeapiVideoWebhook({ ...padded, signatureHeader: signedInput().signatureHeader }),
		).toBe(false);
	});
	it.each([
		null,
		"",
		"v2=" + "0".repeat(64),
		"v1=" + "0".repeat(63),
		"v1=" + "0".repeat(65),
		"v1=" + "g".repeat(64),
		" v1=" + "0".repeat(64),
		"v1=" + "0".repeat(64) + ",v1=" + "0".repeat(64),
	])("rejects malformed signature %s", async (signatureHeader) => {
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), signatureHeader })).toBe(false);
	});
	it.each([
		null,
		"",
		"whkey_unknown",
		" whkey_fixture",
		"whkey_fixture ",
		"whkey_fixture,whkey_other",
		"fixture",
		"__proto__",
		"constructor",
	])("rejects absent/unknown/invalid key UID %s", async (signingKeyHeader) => {
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), signingKeyHeader })).toBe(false);
	});
	it("does not use inherited secret properties", async () => {
		const keys = Object.create({ [keyId]: secret }) as Record<string, string>;
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), keys })).toBe(false);
	});
	it("rejects empty or incorrect selected secrets", async () => {
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), keys: { [keyId]: "" } })).toBe(false);
		expect(
			await verifySeeapiVideoWebhook({ ...signedInput(), keys: { [keyId]: "wrong-secret" } }),
		).toBe(false);
	});
	it("selects old/new secrets by exact key UID and does not try another key on mismatch", async () => {
		const oldSecret = "whsec_old_fixture";
		const keys = { [keyId]: secret, whkey_old: oldSecret };
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), keys })).toBe(true);
		expect(
			await verifySeeapiVideoWebhook({
				...signedInput(body, String(nowSeconds), oldSecret),
				signingKeyHeader: "whkey_old",
				keys,
			}),
		).toBe(true);
		expect(
			await verifySeeapiVideoWebhook({ ...signedInput(), signingKeyHeader: "whkey_old", keys }),
		).toBe(false);
	});
	it("uses the complete configured secret without prefix removal, decoding, or trimming", async () => {
		const exactSecret = " whsec_fixture_secret_with_spaces ";
		expect(
			await verifySeeapiVideoWebhook({
				...signedInput(body, String(nowSeconds), exactSecret),
				keys: { [keyId]: exactSecret },
			}),
		).toBe(true);
	});
	it("rejects changed bytes, JSON whitespace and reordered keys", async () => {
		const input = signedInput();
		for (const rawBody of [
			encoder.encode('{"id":"different-task","text":"你好"}'),
			encoder.encode('{ "id":"fixture-task","text":"你好"}'),
			encoder.encode('{"text":"你好","id":"fixture-task"}'),
		])
			expect(await verifySeeapiVideoWebhook({ ...input, rawBody })).toBe(false);
	});
	it("preserves a BOM and opaque non-JSON bytes for the caller to parse separately", async () => {
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
		const input = signedInput(withBom);
		expect(await verifySeeapiVideoWebhook(input)).toBe(true);
		expect(await verifySeeapiVideoWebhook({ ...input, rawBody: body })).toBe(false);
		expect(await verifySeeapiVideoWebhook(signedInput(new Uint8Array([0, 255, 128, 13, 10])))).toBe(
			true,
		);
	});
	it("uses only the given Uint8Array view, excluding bytes outside its offset and length", async () => {
		const padded = new Uint8Array([99, 98, ...body, 97]);
		const view = padded.subarray(2, padded.length - 1);
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), rawBody: view })).toBe(true);
		expect(await verifySeeapiVideoWebhook({ ...signedInput(), rawBody: padded })).toBe(false);
	});
	it("fails closed on a Web Crypto error", async () => {
		const broken = vi
			.spyOn(crypto.subtle, "importKey")
			.mockRejectedValueOnce(new Error("private internals"));
		try {
			expect(await verifySeeapiVideoWebhook(signedInput())).toBe(false);
		} finally {
			broken.mockRestore();
		}
	});
});

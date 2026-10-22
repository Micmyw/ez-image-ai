import { describe, expect, it } from "vitest";

import { MediaPublicError, stableMediaErrorCode, toMediaOrpcError } from "./errors";
import { TextModerationError } from "./public-moderation-reason";

describe("public media capacity errors", () => {
	it.each([
		["ASSET_CONTENT_NOT_ALLOWED", "CONTENT_NOT_ALLOWED"],
		["GUEST_PRICE_CHANGED", "PRICE_CHANGED"],
		["JOB_NOT_FOUND", "NOT_FOUND"],
	] as const)("preserves the existing non-capacity alias %s", (message, expected) => {
		expect(stableMediaErrorCode(new Error(message))).toBe(expected);
	});
	it.each([
		"CONCURRENT_JOB_LIMIT_REACHED",
		"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED",
		"RATE_LIMITED",
	] as const)("preserves the admission scope of %s in the public response", (code) => {
		const error = new Error(code);
		expect(stableMediaErrorCode(error)).toBe(code);
		expect(toMediaOrpcError(error)).toMatchObject({
			code: "BAD_REQUEST",
			message: code,
			data: { code },
		});
	});

	it.each([
		"UNKNOWN_CONCURRENT_JOB_LIMIT_REACHED",
		"PROVIDER_CONCURRENT_JOB_LIMIT_REACHED_UNKNOWN",
		"UNKNOWN_RATE_LIMITED",
		"Bearer private-provider-payload",
	])("does not mistake the unknown error %s for a public admission rejection", (message) => {
		expect(stableMediaErrorCode(new Error(message))).toBe("PROVIDER_UNAVAILABLE");
	});
});

describe("public media transaction conflicts", () => {
	it.each([
		["Prisma", { code: "P2034" }],
		["PostgreSQL", { code: "40001" }],
		[
			"driver adapter",
			{
				name: "DriverAdapterError",
				cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
			},
		],
		[
			"adapter wrapper",
			{
				name: "OtherError",
				cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
			},
		],
		[
			"Prisma raw query",
			{
				code: "P2010",
				meta: {
					driverAdapterError: {
						cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
					},
				},
			},
		],
	] as const)(
		"keeps a confirmed %s conflict separate from business and provider errors",
		(_, shape) => {
			for (const message of [
				"Failed credit reservation query: private SQL",
				"Failed asset update query: private SQL",
				"INSUFFICIENT_CREDITS ASSET_NOT_READY PROVIDER_UNAVAILABLE",
			]) {
				const error = Object.assign(new Error(message), shape);
				expect(stableMediaErrorCode(error)).toBe("MEDIA_REQUEST_CONFLICT");
				const publicError = toMediaOrpcError(error);
				expect(publicError).toMatchObject({
					code: "CONFLICT",
					status: 409,
					message: "MEDIA_REQUEST_CONFLICT",
					data: { code: "MEDIA_REQUEST_CONFLICT" },
				});
				expect(publicError.cause).toBeUndefined();
				expect(JSON.stringify(publicError)).not.toMatch(
					/private|SQL|P2034|40001|TransactionWriteConflict/,
				);
			}
		},
	);

	it.each([
		{ cause: { originalCode: "40001" } },
		{ cause: { kind: "TransactionWriteConflict" } },
		{ meta: { driverAdapterError: { cause: { originalCode: "40001" } } } },
		{ meta: { driverAdapterError: { cause: { kind: "TransactionWriteConflict" } } } },
	])("recognizes the structured conflict marker %j without inspecting its message", (shape) => {
		expect(stableMediaErrorCode(shape)).toBe("MEDIA_REQUEST_CONFLICT");
	});

	it.each([
		new Error("40001 TransactionWriteConflict"),
		new Error('{"code":"40001","message":"credit"}'),
		{ message: "40001", details: { code: "P2034" } },
		{ code: "P1001", message: "Connection lost after COMMIT" },
		{ code: "P2028", message: "Transaction outcome unknown" },
		{ code: "ETIMEDOUT", cause: { message: "40001" } },
		{
			code: "ETIMEDOUT",
			cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
		},
		{
			code: "ECONNRESET",
			cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
		},
		{
			code: "P1001",
			meta: {
				driverAdapterError: {
					cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
				},
			},
		},
		{ code: "P2028", cause: { originalCode: "40001", kind: "TransactionWriteConflict" } },
		{ code: "ECONNRESET", cause: { cause: { originalCode: "40001" } } },
		{ meta: { driverAdapterError: { cause: { kind: "UnknownError", message: "40001" } } } },
		new Error("UNKNOWN_MEDIA_REQUEST_CONFLICT"),
		new Error("MEDIA_REQUEST_CONFLICT_UNKNOWN"),
	])("does not turn an unconfirmed error into a transaction conflict: %j", (error) => {
		expect(stableMediaErrorCode(error)).not.toBe("MEDIA_REQUEST_CONFLICT");
	});

	it("does not recurse through cyclic causes", () => {
		const error = new Error("Unknown outcome");
		error.cause = error;
		expect(stableMediaErrorCode(error)).toBe("PROVIDER_UNAVAILABLE");
	});

	it.each(["INSUFFICIENT_CREDITS", "ASSET_NOT_READY", "IDEMPOTENCY_CONFLICT"] as const)(
		"preserves the explicit business rejection %s",
		(code) => {
			expect(stableMediaErrorCode(new MediaPublicError(code))).toBe(code);
			expect(stableMediaErrorCode(new Error(code))).toBe(code);
		},
	);

	it("preserves an explicit public technical conflict through repeated mapping", () => {
		const error = toMediaOrpcError(new MediaPublicError("MEDIA_REQUEST_CONFLICT"));
		expect(stableMediaErrorCode(error)).toBe("MEDIA_REQUEST_CONFLICT");
	});

	it("preserves the trusted text moderation outcome and safe reason", () => {
		const error = new TextModerationError({
			decision: "REJECT",
			reasonCode: "SEXUAL_CONTENT",
			ruleVersion: "private-rule",
		});
		expect(toMediaOrpcError(error)).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "CONTENT_NOT_ALLOWED", moderationReason: "sexualContent" },
		});
	});
});

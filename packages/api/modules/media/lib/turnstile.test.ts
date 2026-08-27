import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ consumeGuestTurnstileTokenHash: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { verifyGuestTurnstileToken } from "./turnstile";

const now = new Date("2026-08-28T00:05:00.000Z");

function validResponse(action: "guest_upload" | "guest_generate") {
	return {
		success: true,
		hostname: "marketing.test",
		action,
		challengeTimestamp: new Date(now.getTime() - 30_000).toISOString(),
	};
}

describe("guest Turnstile verification", () => {
	it("consumes one token for only the exact guest_upload action", async () => {
		const used = new Set<string>();
		const consumeTokenHash = vi.fn(async (tokenHash: string) => {
			if (used.has(tokenHash)) return false;
			used.add(tokenHash);
			return true;
		});
		const verify = vi.fn(async () => validResponse("guest_upload"));
		const input = {
			token: "opaque-turnstile-token",
			action: "guest_upload" as const,
			hostname: "marketing.test",
			clientIp: "203.0.113.9",
			now,
		};

		await expect(
			verifyGuestTurnstileToken(input, { verify, consumeTokenHash }),
		).resolves.toMatchObject({ tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
		await expect(verifyGuestTurnstileToken(input, { verify, consumeTokenHash })).rejects.toThrow(
			"TURNSTILE_REPLAYED",
		);
	});

	it.each([
		["failure", { ...validResponse("guest_upload"), success: false }, "TURNSTILE_REJECTED"],
		[
			"hostname",
			{ ...validResponse("guest_upload"), hostname: "evil.test" },
			"TURNSTILE_HOSTNAME_MISMATCH",
		],
		["action", validResponse("guest_generate"), "TURNSTILE_ACTION_MISMATCH"],
		[
			"freshness",
			{ ...validResponse("guest_upload"), challengeTimestamp: "2026-08-27T23:59:00.000Z" },
			"TURNSTILE_EXPIRED",
		],
	] as const)("rejects invalid %s evidence before consuming it", async (_label, response, code) => {
		const consumeTokenHash = vi.fn();
		await expect(
			verifyGuestTurnstileToken(
				{
					token: "opaque-turnstile-token",
					action: "guest_upload",
					hostname: "marketing.test",
					clientIp: "203.0.113.9",
					now,
				},
				{ verify: vi.fn(async () => response), consumeTokenHash },
			),
		).rejects.toThrow(code);
		expect(consumeTokenHash).not.toHaveBeenCalled();
	});
});

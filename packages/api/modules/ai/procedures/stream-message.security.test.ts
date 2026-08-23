import { describe, expect, it } from "vitest";

import {
	assertLegacyAiStreamEnabled,
	legacyAiMessagesSchema,
	withLegacyAiConcurrency,
} from "./stream-message";

describe("legacy AI stream security", () => {
	it("stays disabled in production even when the legacy opt-in is set", () => {
		expect(() =>
			assertLegacyAiStreamEnabled({ NODE_ENV: "production", LEGACY_AI_STREAM_ENABLED: "true" }),
		).toThrow("AI_STREAM_DISABLED");
	});

	it("requires an explicit opt-in outside production", () => {
		expect(() => assertLegacyAiStreamEnabled({ NODE_ENV: "development" })).toThrow(
			"AI_STREAM_DISABLED",
		);
	});

	it("accepts only bounded text messages", () => {
		expect(
			legacyAiMessagesSchema.safeParse([
				{ id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] },
			]),
		).toMatchObject({ success: true });
		expect(
			legacyAiMessagesSchema.safeParse([
				{ id: "message-1", role: "system", parts: [{ type: "text", text: "hello" }] },
			]),
		).toMatchObject({ success: false });
		expect(
			legacyAiMessagesSchema.safeParse([
				{ id: "message-1", role: "user", parts: [{ type: "file", url: "https://example.com" }] },
			]),
		).toMatchObject({ success: false });
		expect(
			legacyAiMessagesSchema.safeParse(
				Array.from({ length: 21 }, (_, index) => ({
					id: `message-${index}`,
					role: "user",
					parts: [{ type: "text", text: "hello" }],
				})),
			),
		).toMatchObject({ success: false });
	});

	it("allows only one concurrent stream per user and releases the lease", async () => {
		let release!: () => void;
		const first = withLegacyAiConcurrency(
			"user-1",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await expect(withLegacyAiConcurrency("user-1", async () => undefined)).rejects.toThrow(
			"AI_STREAM_CONCURRENT_LIMIT",
		);
		release();
		await first;
		await expect(withLegacyAiConcurrency("user-1", async () => undefined)).resolves.toBeUndefined();
	});
});

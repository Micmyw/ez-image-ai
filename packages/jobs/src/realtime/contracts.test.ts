import { describe, expect, it } from "vitest";

import { readMediaJobHeartbeat, readMediaJobNotification } from "./contracts";

describe("identity-only notification and heartbeat contracts", () => {
	it("projects only replay hints and discards client identity or expiry overrides", () => {
		expect(
			readMediaJobHeartbeat({
				type: "heartbeat",
				nonce: 1,
				cursor: null,
				jobId: "other",
				expiresAt: 99,
			}),
		).toEqual({ type: "heartbeat", nonce: 1, cursor: null });
		const value = { eventId: `mju_${"a".repeat(64)}`, jobId: "job", version: "ready" };
		expect(readMediaJobNotification({ ...value, privateUrl: "never-return" })).toEqual(value);
	});
	it.each([
		null,
		[],
		{},
		{ type: "heartbeat", nonce: 0, cursor: null },
		{ type: "heartbeat", nonce: 1.5, cursor: null },
		{ type: "heartbeat", nonce: 1, cursor: "unbounded" },
		{ type: "publish", nonce: 1, cursor: null },
	])("rejects malformed heartbeats: %j", (value) => {
		expect(() => readMediaJobHeartbeat(value)).toThrow("INVALID_MEDIA_JOB_HEARTBEAT");
	});
});

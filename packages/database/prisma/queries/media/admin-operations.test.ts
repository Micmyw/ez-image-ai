import { describe, expect, it } from "vitest";

import {
	assertReplayablePersistedEventStatus,
	assertRetryableAdminStage,
	toSafeAuditItem,
} from "./admin-operations";

describe("admin media operation policy", () => {
	it.each([
		["PAYMENT", "FAILED"],
		["PAYMENT", "RECEIVED"],
		["PAYMENT", "DEAD_LETTER"],
		["PROVIDER", "FAILED"],
		["PROVIDER", "RECEIVED"],
	])("allows persisted %s events in %s state", (kind, status) => {
		expect(() => assertReplayablePersistedEventStatus(kind as never, status)).not.toThrow();
	});

	it.each(["PROCESSING", "PROCESSED"])("rejects unsafe or completed event state %s", (status) => {
		expect(() => assertReplayablePersistedEventStatus("PAYMENT", status)).toThrow(
			"EVENT_NOT_REPLAYABLE",
		);
	});

	it.each([
		["DISPATCH", "RESERVED"],
		["DISPATCH", "DISPATCH_QUEUED"],
		["FINALIZE", "FINALIZING"],
		["SETTLE", "FINALIZING"],
		["SETTLE", "CANCELED"],
	])("allows %s retry for %s jobs", (stage, status) => {
		expect(() => assertRetryableAdminStage(stage as never, status)).not.toThrow();
	});

	it("does not allow dispatch replay after provider submission may have started", () => {
		expect(() => assertRetryableAdminStage("DISPATCH", "SUBMITTING")).toThrow(
			"STAGE_NOT_RETRYABLE",
		);
	});

	it("requires evidence that settlement had already been queued", () => {
		expect(() => assertRetryableAdminStage("SETTLE", "FINALIZING", false)).toThrow(
			"STAGE_NOT_RETRYABLE",
		);
		expect(() => assertRetryableAdminStage("SETTLE", "FINALIZING", true)).not.toThrow();
	});

	it("projects audit records onto a strict non-payload allowlist", () => {
		const safe = toSafeAuditItem({
			id: "audit_1",
			actorUserId: "admin_1",
			action: "MEDIA_EVENT_REPLAYED",
			targetType: "PROVIDER_WEBHOOK_EVENT",
			targetId: "event_1",
			before: { prompt: "secret prompt" },
			after: { sourceUrl: "https://signed.example/?X-Amz-Signature=secret" },
			metadata: { envelope: { apiKey: "secret" } },
			createdAt: new Date("2026-08-14T00:00:00.000Z"),
		});
		expect(safe).toEqual({
			id: "audit_1",
			actorUserId: "admin_1",
			action: "MEDIA_EVENT_REPLAYED",
			targetType: "PROVIDER_WEBHOOK_EVENT",
			targetId: "event_1",
			createdAt: "2026-08-14T00:00:00.000Z",
		});
	});
});

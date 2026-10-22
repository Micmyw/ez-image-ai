import { describe, expect, it, vi } from "vitest";

import {
	recordLockedAssetModerationOutcome,
	type ModerationOutcome,
} from "./moderation-operations";
import type { MediaDatabaseClient } from "./types";

function approved(): ModerationOutcome & { detectorCompleted: boolean } {
	return {
		targetType: "ASSET",
		targetId: "asset",
		provider: "seeapi",
		stage: "IMAGE",
		epoch: "1",
		failures: 0,
		lastErrorCode: "",
		startedAt: new Date(),
		lastFailureAt: new Date(),
		status: "APPROVED",
		serviceResponded: true,
		detectorCompleted: true,
	};
}

function fixture() {
	const execute = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1);
	const query = vi.fn(async () => []);
	const readReview = vi.fn(async () => ({
		id: "historical-review",
		resolvedBy: "admin",
		status: "REJECTED",
		attemptEpoch: "1",
	}));
	const tx = {
		$executeRaw: execute,
		$queryRaw: query,
		moderationReview: { findUnique: readReview },
	} as unknown as MediaDatabaseClient;
	return { tx, execute, query, readReview };
}

describe("locked asset moderation incident selection", () => {
	it("shares the fence only for a completed zero-failure ALLOW with no previous review", async () => {
		const f = fixture();
		await recordLockedAssetModerationOutcome(approved(), null, f.tx);
		expect(f.execute.mock.calls[0]?.[0].join("")).toContain("pg_advisory_xact_lock_shared");
		expect(f.query).toHaveBeenCalledTimes(1);
		expect(f.readReview).not.toHaveBeenCalled();
	});

	it.each([
		{ targetType: "QUOTE" },
		{ stage: "TEXT" },
		{ detectorCompleted: false },
		{ status: "REJECTED" },
		{ status: "BLOCKED" },
		{ status: "PENDING_REVIEW" },
		{ failures: 1 },
		{ serviceResponded: false },
		{ bypassed: true },
	] satisfies Array<Partial<ModerationOutcome & { detectorCompleted: boolean }>>)(
		"preserves the original exclusive review path for %j",
		async (patch) => {
			const f = fixture();
			await recordLockedAssetModerationOutcome({ ...approved(), ...patch }, null, f.tx);
			expect(f.execute.mock.calls[0]?.[0].join("")).toContain("pg_advisory_xact_lock(");
			expect(f.execute).toHaveBeenCalledTimes(1);
			expect(f.readReview).toHaveBeenCalledTimes(1);
			expect(f.query).not.toHaveBeenCalled();
		},
	);

	it("preserves an existing administrator review even when the latest result is ALLOW", async () => {
		const f = fixture();
		await recordLockedAssetModerationOutcome(approved(), { id: "historical-review" }, f.tx);
		expect(f.execute.mock.calls[0]?.[0].join("")).toContain("pg_advisory_xact_lock(");
		expect(f.readReview).toHaveBeenCalledTimes(1);
		expect(f.query).not.toHaveBeenCalled();
	});
});

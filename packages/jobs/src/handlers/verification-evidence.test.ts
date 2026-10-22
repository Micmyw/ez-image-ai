import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { appendVerificationEvidence } from "../runtime";

const proof = {
	assetId: "asset",
	assetChecksum: "a".repeat(64),
	verificationGeneration: 1,
	attemptNumber: 1,
	evidenceKind: "OUTPUT" as const,
	provider: "seeapi",
	providerTaskId: "task",
	ruleVersion: "rule",
	policyVersion: "policy",
	status: "APPROVED" as const,
	reasonCode: "SAFE",
	rawEnvelope: { decision: "ALLOW", source: "original" },
};

function fixture() {
	const rows = new Map<string, Record<string, unknown>>();
	const key = (row: Record<string, unknown>) =>
		`${String(row.assetId)}:${String(row.verificationGeneration)}:${String(row.attemptNumber)}`;
	const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		if (rows.has(key(data))) throw new Error("P2002: duplicate proof");
		rows.set(key(data), structuredClone(data));
		return data;
	});
	const createMany = vi.fn(
		async ({
			data,
			skipDuplicates,
		}: {
			data: Record<string, unknown>;
			skipDuplicates: boolean;
		}) => {
			if (rows.has(key(data)) && skipDuplicates) return { count: 0 };
			await create({ data });
			return { count: 1 };
		},
	);
	const findFirst = vi.fn(
		async ({ where }: { where: Record<string, unknown> }) => rows.get(key(where)) ?? null,
	);
	return {
		rows,
		createMany,
		findFirst,
		tx: { assetModerationResult: { create, createMany, findFirst } },
	};
}

describe("append-only verification evidence", () => {
	it("uses the unique insert instead of a separate existence read and preserves a different duplicate proof", async () => {
		const f = fixture();
		await appendVerificationEvidence(f.tx as never, proof);
		const original = structuredClone([...f.rows.values()][0]);
		await appendVerificationEvidence(f.tx as never, {
			...proof,
			assetChecksum: "b".repeat(64),
			providerTaskId: "other-task",
			status: "REJECTED",
			rawEnvelope: { decision: "REJECT", source: "conflicting" },
		});
		expect(f.findFirst).not.toHaveBeenCalled();
		expect(f.createMany).toHaveBeenCalledTimes(2);
		expect([...f.rows.values()]).toEqual([original]);
	});

	it("accepts concurrent idempotent appends without overwriting the winning proof", async () => {
		const f = fixture();
		await expect(
			Promise.all([
				appendVerificationEvidence(f.tx as never, proof),
				appendVerificationEvidence(f.tx as never, {
					...proof,
					rawEnvelope: { decision: "ALLOW", source: "duplicate" },
				}),
			]),
		).resolves.toEqual([undefined, undefined]);
		expect([...f.rows.values()]).toMatchObject([{ rawEnvelope: proof.rawEnvelope }]);
	});
});

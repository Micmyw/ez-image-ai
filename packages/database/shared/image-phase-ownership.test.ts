import { afterEach, describe, expect, it, vi } from "vitest";

import {
	acquireImagePhaseOwnership,
	IMAGE_PHASE_OWNER_LEASE_MS,
	imagePhaseIdentity,
	imagePhaseOwner,
	sameImagePhaseOwner,
	type ImagePhaseIdentity,
	type ImagePhaseLease,
	type ImagePhaseOwner,
	type ImagePhaseOwnershipPort,
	type ImageWorkflowPhase,
} from "./image-phase-ownership";

const databaseNow = new Date("2026-10-22T10:00:00.000Z");
const phase = { kind: "verification", assetId: "asset-1", generation: 2 } as const;
const owner: ImagePhaseOwner = {
	workflowId: "workflow-1",
	phaseKey: "10000000-0000-4000-8000-000000000001",
	epoch: 3,
};
const liveLease: ImagePhaseLease = {
	...owner,
	leasedUntil: new Date(databaseNow.getTime() + 30_000),
};
const uuid1 = "20000000-0000-4000-8000-000000000001";
const uuid2 = "20000000-0000-4000-8000-000000000002";

// This port supplies a database clock and atomic compare-and-swap storage. It
// does not decide ownership or lease eligibility; the real helper does that.
function persistence(initial?: ImagePhaseLease, initialPhase: ImageWorkflowPhase = phase) {
	const key = (identity: ImagePhaseIdentity) => JSON.stringify(identity);
	const rows = new Map<string, ImagePhaseLease>();
	if (initial) rows.set(key(imagePhaseIdentity(initialPhase)), initial);
	let now = databaseNow;
	let rejectWrite = false;
	const read = vi.fn(async (identity: ImagePhaseIdentity) => ({
		lease: rows.get(key(identity)) ?? null,
		now,
	}));
	const write = vi.fn(
		async (
			identity: ImagePhaseIdentity,
			next: ImagePhaseLease,
			previous: ImagePhaseLease | null,
		) => {
			if (rejectWrite || (rows.get(key(identity)) ?? null) !== previous) return false;
			rows.set(key(identity), next);
			return true;
		},
	);
	const port: ImagePhaseOwnershipPort = { read, write };
	return {
		port,
		read,
		write,
		get(subject: ImageWorkflowPhase = phase) {
			return rows.get(key(imagePhaseIdentity(subject)));
		},
		remove(subject: ImageWorkflowPhase = phase) {
			rows.delete(key(imagePhaseIdentity(subject)));
		},
		setClock(value: Date) {
			now = value;
		},
		rejectWrites() {
			rejectWrite = true;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("image phase immutable subject identity", () => {
	it("binds visual ownership to the exact asset generation", () => {
		expect(imagePhaseIdentity(phase)).toEqual({
			phaseKind: "verification",
			subjectId: "asset-1",
			generation: 2,
		});
		expect(imagePhaseIdentity({ ...phase, generation: 3 })).not.toEqual(imagePhaseIdentity(phase));
		expect(imagePhaseIdentity({ ...phase, assetId: "asset-2" })).not.toEqual(
			imagePhaseIdentity(phase),
		);
	});

	it("binds provider ownership to one attempt in its own namespace", () => {
		expect(imagePhaseIdentity({ kind: "generation", attemptId: "asset-1" })).toEqual({
			phaseKind: "generation",
			subjectId: "asset-1",
			generation: 0,
		});
		expect(imagePhaseIdentity({ kind: "generation", attemptId: "attempt-2" })).not.toEqual(
			imagePhaseIdentity({ kind: "generation", attemptId: "attempt-1" }),
		);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid verification generation %s before persistence",
		async (generation) => {
			const store = persistence();
			await expect(
				acquireImagePhaseOwnership(
					{ phase: { ...phase, generation }, workflowId: owner.workflowId },
					store.port,
				),
			).rejects.toThrow("INVALID_IMAGE_WORKFLOW_PHASE");
			expect(store.read).not.toHaveBeenCalled();
		},
	);

	it.each(["", "asset/1", "asset 1", "asset\n1", "资产", "a".repeat(129)])(
		"rejects malformed subject %j",
		(subjectId) => {
			expect(() => imagePhaseIdentity({ ...phase, assetId: subjectId })).toThrow(
				"INVALID_IMAGE_WORKFLOW_PHASE",
			);
			expect(() => imagePhaseIdentity({ kind: "generation", attemptId: subjectId })).toThrow(
				"INVALID_IMAGE_WORKFLOW_PHASE",
			);
		},
	);

	it("accepts the bounded identifier alphabet and rejects unknown kinds", () => {
		expect(imagePhaseIdentity({ ...phase, assetId: "a_1-".repeat(32) }).subjectId).toHaveLength(
			128,
		);
		expect(() =>
			imagePhaseIdentity({
				kind: "unknown",
				attemptId: "attempt-1",
			} as unknown as ImageWorkflowPhase),
		).toThrow("INVALID_IMAGE_WORKFLOW_PHASE");
	});

	it.each(["", "workflow/1", "workflow 1", "w".repeat(129)])(
		"rejects malformed workflow %j",
		async (workflowId) => {
			const store = persistence();
			await expect(acquireImagePhaseOwnership({ phase, workflowId }, store.port)).rejects.toThrow(
				"INVALID_IMAGE_WORKFLOW_ID",
			);
			expect(store.read).not.toHaveBeenCalled();
		},
	);
});

describe("image phase ownership and renewal", () => {
	it("creates one epoch with a fresh phase key and database-clock expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid1);
		const store = persistence();
		expect(
			await acquireImagePhaseOwnership({ phase, workflowId: owner.workflowId }, store.port),
		).toEqual({
			owned: true,
			phaseOwner: { workflowId: owner.workflowId, phaseKey: uuid1, epoch: 1 },
		});
		expect(store.get()?.leasedUntil).toEqual(new Date(databaseNow.getTime() + 600_000));
		expect(IMAGE_PHASE_OWNER_LEASE_MS).toBe(600_000);
		expect(store.write.mock.calls[0]?.[2]).toBeNull();
	});

	it.each([true, false])(
		"renews the same live owner without changing its identity (expected=%s)",
		async (useExpected) => {
			const randomUUID = vi.spyOn(crypto, "randomUUID");
			const store = persistence(liveLease);
			expect(
				await acquireImagePhaseOwnership(
					{ phase, workflowId: owner.workflowId, ...(useExpected ? { expectedOwner: owner } : {}) },
					store.port,
				),
			).toEqual({ owned: true, phaseOwner: owner });
			expect(store.get()?.leasedUntil).toEqual(
				new Date(databaseNow.getTime() + IMAGE_PHASE_OWNER_LEASE_MS),
			);
			expect(store.write.mock.calls[0]?.[2]).toBe(liveLease);
			expect(randomUUID).not.toHaveBeenCalled();
		},
	);

	it("does not mistake an active business lease for a reason to reject its current owner", async () => {
		const store = persistence(liveLease);
		expect(
			await acquireImagePhaseOwnership(
				{
					phase,
					workflowId: owner.workflowId,
					expectedOwner: owner,
					businessLeasedUntil: new Date(databaseNow.getTime() + 60_000),
				},
				store.port,
			),
		).toEqual({ owned: true, phaseOwner: owner });
	});

	it("rejects a foreign workflow while revealing only the current coordination identity", async () => {
		const store = persistence(liveLease);
		expect(
			await acquireImagePhaseOwnership({ phase, workflowId: "workflow-other" }, store.port),
		).toEqual({ owned: false, phaseOwner: owner });
		expect(store.write).not.toHaveBeenCalled();
	});

	it.each([
		{ ...owner, workflowId: "workflow-old" },
		{ ...owner, phaseKey: uuid1 },
		{ ...owner, epoch: owner.epoch - 1 },
		{ ...owner, epoch: owner.epoch + 1 },
	])("rejects a stale or mismatched expected receipt %j", async (expectedOwner) => {
		const store = persistence(liveLease);
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: owner.workflowId, expectedOwner },
				store.port,
			),
		).toEqual({ owned: false, phaseOwner: owner });
		expect(store.write).not.toHaveBeenCalled();
	});

	it("cannot borrow a live receipt from another workflow", async () => {
		const store = persistence(liveLease);
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: "workflow-other", expectedOwner: owner },
				store.port,
			),
		).toEqual({ owned: false, phaseOwner: owner });
		expect(store.write).not.toHaveBeenCalled();
	});

	it("keeps subjects, generations and provider attempts independently owned", async () => {
		const store = persistence(liveLease);
		for (const separatePhase of [
			{ ...phase, generation: 3 },
			{ ...phase, assetId: "asset-2" },
			{ kind: "generation", attemptId: "asset-1" },
		] satisfies ImageWorkflowPhase[]) {
			expect(
				await acquireImagePhaseOwnership(
					{ phase: separatePhase, workflowId: "workflow-other" },
					store.port,
				),
			).toMatchObject({ owned: true, phaseOwner: { workflowId: "workflow-other", epoch: 1 } });
		}
		expect(store.get()).toBe(liveLease);
	});
});

describe("image phase expiry, takeover and ABA fences", () => {
	it.each([-1, 0])(
		"rejects expired expected owners at database expiry offset %s",
		async (offset) => {
			const store = persistence({
				...liveLease,
				leasedUntil: new Date(databaseNow.getTime() + offset),
			});
			expect(
				await acquireImagePhaseOwnership(
					{ phase, workflowId: owner.workflowId, expectedOwner: owner },
					store.port,
				),
			).toEqual({ owned: false });
			expect(store.write).not.toHaveBeenCalled();
		},
	);

	it("renews one millisecond before database expiry", async () => {
		const store = persistence({ ...liveLease, leasedUntil: new Date(databaseNow.getTime() + 1) });
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: owner.workflowId, expectedOwner: owner },
				store.port,
			),
		).toEqual({ owned: true, phaseOwner: owner });
	});

	it.each(["workflow-1", "workflow-other"])(
		"increments the epoch on fresh acquisition after expiry by %s",
		async (workflowId) => {
			const expired = { ...liveLease, leasedUntil: databaseNow };
			const store = persistence(expired);
			expect(await acquireImagePhaseOwnership({ phase, workflowId }, store.port)).toEqual({
				owned: true,
				phaseOwner: { ...owner, workflowId, epoch: owner.epoch + 1 },
			});
			expect(store.write.mock.calls[0]?.[2]).toBe(expired);
		},
	);

	it.each([false, true])(
		"blocks takeover during a business lease even if owner row exists=%s",
		async (hasExpiredOwner) => {
			const store = persistence(
				hasExpiredOwner ? { ...liveLease, leasedUntil: databaseNow } : undefined,
			);
			expect(
				await acquireImagePhaseOwnership(
					{
						phase,
						workflowId: "workflow-other",
						businessLeasedUntil: new Date(databaseNow.getTime() + 1),
					},
					store.port,
				),
			).toEqual({ owned: false });
			expect(store.write).not.toHaveBeenCalled();
		},
	);

	it("permits fresh acquisition at the exact business lease expiry", async () => {
		const store = persistence({ ...liveLease, leasedUntil: databaseNow });
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: "workflow-other", businessLeasedUntil: databaseNow },
				store.port,
			),
		).toMatchObject({ owned: true, phaseOwner: { epoch: owner.epoch + 1 } });
	});

	it("never resurrects an expected receipt after its row was cleaned up", async () => {
		const store = persistence();
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: owner.workflowId, expectedOwner: owner },
				store.port,
			),
		).toEqual({ owned: false });
		expect(store.write).not.toHaveBeenCalled();
	});

	it("uses a new phase key after cleanup even when workflow and epoch repeat", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(uuid1).mockReturnValueOnce(uuid2);
		const store = persistence();
		const first = await acquireImagePhaseOwnership(
			{ phase, workflowId: owner.workflowId },
			store.port,
		);
		store.remove();
		store.setClock(new Date(databaseNow.getTime() + 25 * 60 * 60 * 1000));
		const second = await acquireImagePhaseOwnership(
			{ phase, workflowId: owner.workflowId },
			store.port,
		);
		expect(first.phaseOwner).toEqual({ workflowId: owner.workflowId, phaseKey: uuid1, epoch: 1 });
		expect(second.phaseOwner).toEqual({ workflowId: owner.workflowId, phaseKey: uuid2, epoch: 1 });
		expect(sameImagePhaseOwner(first.phaseOwner!, second.phaseOwner!)).toBe(false);
		expect(
			await acquireImagePhaseOwnership(
				{ phase, workflowId: owner.workflowId, expectedOwner: first.phaseOwner },
				store.port,
			),
		).toEqual({ owned: false, phaseOwner: second.phaseOwner });
		expect(store.write).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		"never grants ownership after a failed persisted CAS (existing=%s)",
		async (existing) => {
			const store = persistence(existing ? liveLease : undefined);
			store.rejectWrites();
			expect(
				await acquireImagePhaseOwnership({ phase, workflowId: owner.workflowId }, store.port),
			).toEqual({ owned: false });
			expect(store.get()).toBe(existing ? liveLease : undefined);
		},
	);

	it("does not grant two first owners when both reads observed no row", async () => {
		const store = persistence();
		const results = await Promise.all([
			acquireImagePhaseOwnership({ phase, workflowId: "workflow-a" }, store.port),
			acquireImagePhaseOwnership({ phase, workflowId: "workflow-b" }, store.port),
		]);
		expect(results.filter(({ owned }) => owned)).toHaveLength(1);
		expect(results.find(({ owned }) => !owned)).toEqual({ owned: false });
		expect(store.write).toHaveBeenCalledTimes(2);
	});

	it("exports only the three receipt fields and compares every one", () => {
		expect(imagePhaseOwner(liveLease)).toEqual(owner);
		expect(imagePhaseOwner(liveLease)).not.toHaveProperty("leasedUntil");
		expect(sameImagePhaseOwner(owner, { ...owner })).toBe(true);
		for (const changed of [
			{ ...owner, workflowId: "other" },
			{ ...owner, phaseKey: uuid1 },
			{ ...owner, epoch: owner.epoch + 1 },
		])
			expect(sameImagePhaseOwner(owner, changed)).toBe(false);
	});
});

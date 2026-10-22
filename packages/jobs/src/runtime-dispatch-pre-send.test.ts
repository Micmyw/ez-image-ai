import { createRouteGraphSnapshot, type MediaProviderAdapter } from "@repo/ai";
import type { GenerationSubmissionPreparation, ImagePhaseOwner } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import type { DispatchClaim } from "./contracts";
import { createDispatchPreSendProofs } from "./dispatch-pre-send-proof";
import { dispatchGeneration } from "./handlers/dispatch-generation";
import { createDatabaseDispatchStore } from "./runtime";

const now = new Date("2026-10-22T12:00:00Z");
const owner: ImagePhaseOwner = { workflowId: "workflow", phaseKey: "phase", epoch: 1 };
const route = {
	provider: "kie" as const,
	providerModelId: "nano-banana-2-lite",
	providerCostMicros: 20_000,
	weight: 100,
};

function fixture() {
	const job = {
		id: "job",
		version: 4,
		status: "DISPATCH_QUEUED",
		executionEngine: "legacy",
		ownerType: "USER",
		ownerId: "owner",
		serviceClass: "STANDARD",
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "2026-09-07.2",
		pricingVersion: "2026-09-07.2",
		dispatchEligibleAt: null,
		inputSnapshot: {
			kind: "text-to-image",
			prompt: "A calm lake",
			skuKey: "nano-banana-2-lite-1k",
			aspectRatio: "1:1",
		},
		pricingSnapshot: {
			routeGraph: createRouteGraphSnapshot({
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "2026-09-07.2",
				pricingVersion: "2026-09-07.2",
				routes: [route],
			}),
		},
		quote: { costMicros: 20_000n, moderationDecision: "ALLOW" },
		assets: [],
		guestTrial: null,
	};
	const attempt = {
		id: "attempt",
		jobId: job.id,
		attemptNumber: 1,
		provider: route.provider,
		providerModelId: route.providerModelId,
		status: "CREATED",
		uncertainSubmission: false,
		providerTaskId: null as string | null,
		submittedAt: null as Date | null,
		completedAt: null as Date | null,
		reconcileLeaseToken: null as string | null,
		reconcileLeasedUntil: null as Date | null,
		requestSnapshot: {} as Record<string, unknown>,
		nextReconcileAt: null as Date | null,
	};
	const state = {
		attemptRowVersion: "101",
		jobRowVersion: "101",
		owner: undefined as (ImagePhaseOwner & { leasedUntil: Date }) | undefined,
		commitFailure: 0,
		transactionCount: 0,
		internalClaim: undefined as unknown,
		beforeAttemptLock: undefined as (() => Promise<void>) | undefined,
		beforePrepare: undefined as (() => void) | undefined,
	};
	const query = vi.fn(
		async (sql: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
			const statement = sql.join("?");
			if (statement.includes('UPDATE "generation_attempt" AS attempt')) {
				state.beforePrepare?.();
				if (
					values[5] !== job.id ||
					values[6] !== job.version ||
					values[7] !== JSON.stringify(job.inputSnapshot) ||
					values[8] !== JSON.stringify(job.pricingSnapshot)
				)
					return [];
				Object.assign(attempt, {
					status: "SUBMISSION_UNCERTAIN",
					uncertainSubmission: true,
					submittedAt: values[0],
					nextReconcileAt: values[1],
					requestSnapshot: JSON.parse(values[2] as string),
				});
				return [{ attemptRowVersion: state.attemptRowVersion, jobRowVersion: state.jobRowVersion }];
			}
			if (statement.includes("FROM (SELECT 1) anchor")) return [{ now, ...state.owner }];
			if (statement.includes('SELECT "phaseKey"'))
				return state.owner && state.owner.leasedUntil > new Date() ? [state.owner] : [];
			if (statement.includes('AS "current"'))
				return [
					{
						current:
							!!state.owner &&
							state.owner.phaseKey === values[3] &&
							state.owner.workflowId === values[4] &&
							state.owner.epoch === values[5],
					},
				];
			if (statement.includes('AS "canSend"')) {
				const liveOwner =
					state.owner && state.owner.leasedUntil > new Date() ? state.owner : undefined;
				return [
					{
						canSend:
							values[0] === attempt.id &&
							values[1] === job.id &&
							values[2] === state.attemptRowVersion &&
							values[3] === state.jobRowVersion &&
							values[4] === job.version &&
							values[5] === attempt.attemptNumber &&
							values[6] === attempt.provider &&
							values[7] === attempt.providerModelId &&
							(values[8] as Date).getTime() === attempt.submittedAt?.getTime() &&
							values[9] === attempt.requestSnapshot.requestFingerprint &&
							job.executionEngine === "legacy" &&
							job.status === "SUBMITTING" &&
							attempt.status === "SUBMISSION_UNCERTAIN" &&
							attempt.uncertainSubmission &&
							attempt.requestSnapshot.submissionPhase === "pre_send" &&
							!attempt.providerTaskId &&
							!attempt.completedAt &&
							!attempt.reconcileLeaseToken &&
							!attempt.reconcileLeasedUntil &&
							(values[10]
								? !!liveOwner &&
									liveOwner.phaseKey === values[11] &&
									liveOwner.workflowId === values[12] &&
									liveOwner.epoch === values[13]
								: !liveOwner),
					},
				];
			}
			if (statement.includes('FROM "generation_attempt"') && statement.includes("FOR UPDATE")) {
				await state.beforeAttemptLock?.();
				return [{ id: attempt.id }];
			}
			throw new Error(`Unexpected query: ${statement}`);
		},
	);
	const tx = {
		$queryRaw: query,
		$executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
			if (sql.join("?").includes('INSERT INTO "media_workflow_phase_owner"'))
				state.owner = {
					phaseKey: values[0] as string,
					workflowId: values[4] as string,
					epoch: values[5] as number,
					leasedUntil: values[6] as Date,
				};
			return 1;
		}),
		generationJob: {
			findFirst: vi.fn(async () =>
				["RESERVED", "DISPATCH_QUEUED"].includes(job.status)
					? {
							...job,
							inputSnapshot: structuredClone(job.inputSnapshot),
							pricingSnapshot: structuredClone(job.pricingSnapshot),
							attempts: [],
						}
					: null,
			),
			updateMany: vi.fn(async () => {
				job.status = "SUBMITTING";
				job.version += 1;
				return { count: 1 };
			}),
		},
		generationAttempt: {
			create: vi.fn(async () => attempt),
			findUniqueOrThrow: vi.fn(async () => ({
				...attempt,
				job: { inputSnapshot: job.inputSnapshot },
			})),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				Object.assign(attempt, data);
				state.attemptRowVersion = "102";
				return attempt;
			}),
		},
		runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
	};
	const database = {
		$transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
			const index = ++state.transactionCount;
			const result = await operation(tx);
			if (index === 1) state.internalClaim = result;
			if (state.commitFailure === index) throw new Error("COMMIT_RESPONSE_LOST");
			return result;
		}),
	};
	const options = {
		workflowId: "workflow",
		enabledProviders: new Set(["kie"] as const),
		environment: {
			NODE_ENV: "test",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
		},
	};
	const store = createDatabaseDispatchStore(database as never, options);
	const submit = vi.fn(async (_input: Parameters<MediaProviderAdapter["submit"]>[0]) => ({
		outcome: "accepted" as const,
		providerTaskId: "task",
		status: "RUNNING" as const,
		idempotency: { providerSupported: false, replayed: false },
		reconciliation: {},
	}));
	const recordUncertainSubmission = vi.fn(async () => undefined);
	const dependencies = {
		store: {
			...store,
			recordSubmission: vi.fn(async () => ({ eventIds: [] })),
			recordUncertainSubmission,
		},
		getProvider: () => ({ submit }) as unknown as MediaProviderAdapter,
		isGenerationEnabled: () => true,
	};
	async function claim(): Promise<DispatchClaim> {
		const result = await store.claimDispatch({ jobId: job.id, version: 4 });
		if (!result || !("attemptId" in result)) throw new Error("Expected a prepared claim");
		return result;
	}
	return {
		job,
		attempt,
		state,
		tx,
		database,
		options,
		store,
		claim,
		submit,
		dependencies,
		recordUncertainSubmission,
	};
}

describe("same-request committed dispatch preparation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => vi.useRealTimers());

	it("sends immutable provider input after one preparation write and a locked narrow check", async () => {
		const f = fixture();
		await expect(
			dispatchGeneration({ jobId: "job", version: 4 }, f.dependencies),
		).resolves.toMatchObject({ outcome: "SUBMITTED" });
		expect(f.submit).toHaveBeenCalledOnce();
		const sent = (f.submit.mock.calls as unknown as Array<[{ input: object }]>)[0]![0];
		expect(Object.isFrozen(sent.input)).toBe(true);
		expect(f.tx.generationAttempt.findUniqueOrThrow).not.toHaveBeenCalled();
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		const statements = f.tx.$queryRaw.mock.calls.map(([sql]) => sql.join("?"));
		expect(
			statements.filter((sql) => sql.includes('UPDATE "generation_attempt" AS attempt')),
		).toHaveLength(1);
		const check = statements.findIndex((sql) => sql.includes('AS "canSend"'));
		expect(statements[check - 1]).toContain("FOR UPDATE");
		expect(statements[check]).toContain("attempt.xmin::text");
		expect(statements[check]).toContain("job.xmin::text");
		expect(f.database.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
			isolationLevel: "ReadCommitted",
			maxWait: 5_000,
			timeout: 20_000,
		});
	});

	it("never registers or sends after a lost claim commit response, including replay", async () => {
		const f = fixture();
		f.state.commitFailure = 1;
		await expect(dispatchGeneration({ jobId: "job", version: 4 }, f.dependencies)).rejects.toThrow(
			"COMMIT_RESPONSE_LOST",
		);
		const leaked = f.state.internalClaim as DispatchClaim;
		await expect(
			f.store.recordSubmissionStarted(leaked.attemptId, leaked.phaseOwner, leaked),
		).resolves.toBe(false);
		await expect(dispatchGeneration({ jobId: "job", version: 4 }, f.dependencies)).resolves.toEqual(
			{ outcome: "SKIPPED" },
		);
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.attempt.uncertainSubmission).toBe(true);
	});

	it("consumes the proof even when the final check commit response is lost", async () => {
		const f = fixture();
		const claim = await f.claim();
		f.state.commitFailure = 2;
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).rejects.toThrow("COMMIT_RESPONSE_LOST");
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.attempt.requestSnapshot.submissionPhase).toBe("pre_send");
	});

	it("does not call a provider when a final commit acknowledgement is unknown", async () => {
		const f = fixture();
		f.state.commitFailure = 2;
		await expect(
			dispatchGeneration({ jobId: "job", version: 4 }, f.dependencies),
		).resolves.toMatchObject({ outcome: "RECONCILE" });
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.recordUncertainSubmission).toHaveBeenCalledOnce();
	});

	it("rejects copies and cross-store claims instead of entering the legacy writer", async () => {
		const f = fixture();
		const claim = await f.claim();
		const copied = structuredClone(claim);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, copied),
		).resolves.toBe(false);
		const otherStore = createDatabaseDispatchStore(f.database as never, f.options);
		await expect(
			otherStore.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
		expect(f.tx.generationAttempt.findUniqueOrThrow).not.toHaveBeenCalled();
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBeUndefined();
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
	});

	it("consumes before waiting for the attempt lock and reads owner after that wait", async () => {
		const f = fixture();
		const claim = await f.claim();
		let release!: () => void;
		f.state.beforeAttemptLock = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const first = f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim);
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
		f.state.owner = {
			...owner,
			workflowId: "replacement",
			epoch: 2,
			leasedUntil: new Date(now.getTime() + 600_000),
		};
		release();
		await expect(first).resolves.toBe(false);
	});

	it("uses the persisted owner deadline without adding a shorter local proof timeout", async () => {
		const f = fixture();
		const claim = await f.claim();
		vi.setSystemTime(new Date(now.getTime() + 120_000));
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBeUndefined();
		const expired = fixture();
		const old = await expired.claim();
		vi.setSystemTime(new Date(now.getTime() + 700_000));
		await expect(
			expired.store.recordSubmissionStarted(old.attemptId, old.phaseOwner, old),
		).resolves.toBe(false);
	});

	it.each(["attempt", "job"] as const)(
		"rejects a same-timestamp raw %s mutation through its tuple version",
		async (subject) => {
			const f = fixture();
			const claim = await f.claim();
			if (subject === "attempt") f.state.attemptRowVersion = "102";
			else {
				f.state.jobRowVersion = "102";
				f.job.inputSnapshot.prompt = "A different instruction";
			}
			await expect(
				f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
			).resolves.toBe(false);
			expect(f.attempt.submittedAt).toEqual(now);
			expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		},
	);

	it("retains the complete historical writer only when no proof was supplied", async () => {
		const f = fixture();
		const claim = await f.claim();
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner),
		).resolves.toBeUndefined();
		expect(f.tx.generationAttempt.findUniqueOrThrow).toHaveBeenCalledOnce();
		expect(f.tx.generationAttempt.update).toHaveBeenCalledOnce();
		await expect(
			f.store.recordSubmissionStarted(claim.attemptId, claim.phaseOwner, claim),
		).resolves.toBe(false);
	});

	it("rejects job snapshot changes during the original preparation before issuing a proof", async () => {
		const f = fixture();
		f.state.beforePrepare = () => {
			f.job.inputSnapshot.prompt = "changed while preparing";
		};
		await expect(f.claim()).rejects.toThrow("GENERATION_SUBMISSION_PREPARATION_CHANGED");
		expect(f.submit).not.toHaveBeenCalled();
	});
});

describe("immutable dispatch claim capabilities", () => {
	function capability() {
		const claim: DispatchClaim = {
			phaseOwner: { ...owner },
			attemptId: "attempt",
			attemptNumber: 1,
			serviceClass: "STANDARD",
			provider: "kie",
			providerModelId: "nano-banana-2-lite",
			mediaKind: "image",
			queueKey: "kie:image",
			input: {
				kind: "image-to-image",
				prompt: "original",
				sourceAsset: { assetId: "asset", transferUrl: "https://private.example.test/source" },
			},
		};
		const prepared: GenerationSubmissionPreparation = {
			attemptId: claim.attemptId,
			attemptNumber: 1,
			jobId: "job",
			jobVersion: 5,
			provider: claim.provider,
			providerModelId: claim.providerModelId,
			requestFingerprint: "fingerprint",
			submittedAt: now.toISOString(),
			attemptRowVersion: "101",
			jobRowVersion: "101",
		};
		return { claim, prepared, proofs: createDispatchPreSendProofs() };
	}
	it("copies and freezes the actual returned route, owner and nested provider input", () => {
		const f = capability();
		const frozen = f.proofs.register(f.claim, f.prepared);
		f.claim.input.prompt = "changed original alias";
		expect(frozen.input.prompt).toBe("original");
		for (const mutate of [
			() => {
				frozen.providerModelId = "other";
			},
			() => {
				frozen.phaseOwner!.epoch = 2;
			},
			() => {
				frozen.input.prompt = "changed same object";
			},
			() => {
				if (frozen.input.kind === "image-to-image")
					frozen.input.sourceAsset.transferUrl = "https://other.example.test";
			},
		])
			expect(mutate).toThrow(TypeError);
		expect(f.proofs.consume(frozen, "attempt", owner)).toEqual(f.prepared);
		expect(f.proofs.consume(frozen, "attempt", owner)).toBeUndefined();
	});
	it.each([
		new Date(),
		new Map(),
		new Set(),
		new Uint8Array([1]),
		Object.create({ inherited: true }),
		Object.create(Array.prototype),
		Object.assign(new Array(3), { 0: 1, 2: 3 }),
	])("rejects mutable non-JSON input %j", (value) => {
		const f = capability();
		Object.assign(f.claim.input, { extra: value });
		expect(() => f.proofs.register(f.claim, f.prepared)).toThrow("INVALID_DISPATCH_CLAIM_SNAPSHOT");
	});
	it("rejects an accessor without invoking it", () => {
		const f = capability();
		const read = vi.fn(() => "changed");
		Object.defineProperty(f.claim.input, "extra", { enumerable: true, get: read });
		expect(() => f.proofs.register(f.claim, f.prepared)).toThrow("INVALID_DISPATCH_CLAIM_SNAPSHOT");
		expect(read).not.toHaveBeenCalled();
	});
});

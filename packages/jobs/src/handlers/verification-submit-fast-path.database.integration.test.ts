import { PrismaPg } from "@prisma/adapter-pg";
import { SeeapiSafetyAdapter, TestMediaSafetyAdapter, type ModerationSubmission } from "@repo/ai";
import {
	getImagePhaseOwner,
	prepareWorkflowOutboxDelivery,
	wakeImageModerationWithOwner,
	type ImagePhaseOwner,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parsePollingTickResult } from "../orchestration/contracts";
import { executeTask } from "../orchestration/executor";
import { verifyImageModerationCallbackUrl } from "../orchestration/image-moderation-callback-auth";
import {
	createDatabaseVerifyUploadDependencies,
	databaseVerifyUploadDependencies,
} from "../runtime";

type VerificationOptions = NonNullable<
	Parameters<typeof createDatabaseVerifyUploadDependencies>[1]
>;
const callbackEnvironment = {
	NEXT_PUBLIC_SAAS_URL: "https://verification-fixture.example",
	WORKFLOWS_DISPATCH_SECRET: "verification-fixture-secret-00000000000000",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_local: "whsec_local-fixture-key-00000000" }),
};

describe("verification submission fast path with real PostgreSQL", () => {
	let client: PrismaClient;
	let databaseReady = false;
	const assetIds: string[] = [];
	const jobIds: string[] = [];
	const providerNames: string[] = [];

	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			url.search ||
			url.hash ||
			(url.pathname !== "/scanless_phase_owner_migration_test" &&
				url.pathname !== "/ai_media_foundation_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
		await client.$queryRaw`SELECT 1`;
		databaseReady = true;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		if (!client) return;
		try {
			if (!databaseReady) return;
			const incidents = await client.moderationIncident.findMany({
				where: { provider: { in: providerNames } },
				select: { id: true },
			});
			await client.mediaWorkflowPhaseOwner.deleteMany({ where: { subjectId: { in: assetIds } } });
			await client.outboxEvent.deleteMany({
				where: { aggregateId: { in: [...assetIds, ...jobIds, ...incidents.map(({ id }) => id)] } },
			});
			// Evidence remains append-only; approved/error fixtures stay in this disposable database.
			await client.mediaAsset.deleteMany({
				where: {
					id: { in: assetIds },
					moderationResults: { none: {} },
					jobBindings: { none: {} },
				},
			});
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(
		input: {
			kind?: "INPUT" | "OUTPUT";
			callback?: boolean;
			status?: "queued" | "processing" | "succeeded" | "unknown";
			legacyAdapter?: boolean;
			provider?: "isolated";
		} = {},
	) {
		const assetId = crypto.randomUUID();
		const taskId = `moderation-${assetId}`;
		const provider = input.provider === "isolated" ? `fast-path-${assetId}` : "seeapi";
		assetIds.push(assetId);
		if (provider !== "seeapi") providerNames.push(provider);
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `fast-path-owner-${assetId}`,
				kind: input.kind ?? "OUTPUT",
				status: "VERIFYING",
				objectKey: `users/fast-path/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "a".repeat(64),
				finalizedAt: new Date(),
			},
		});
		let onPost: ((callbackUrl: string | undefined) => Promise<void>) | undefined;
		let getStatus: "processing" | "succeeded" = "processing";
		const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const post = init?.method === "POST";
			if (post) {
				if (typeof init?.body !== "string") throw new Error("EXPECTED_JSON_FIXTURE_BODY");
				const body = JSON.parse(init.body) as { callback_url?: string };
				await onPost?.(body.callback_url);
			}
			const status = post ? (input.status ?? "processing") : getStatus;
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter",
				endpoint: "image-moderation",
				provider: "seeapi",
				status,
				error: null,
				result:
					status === "succeeded"
						? { type: "json", data: { flagged: false, categories: { nsfw: [], special_care: [] } } }
						: null,
			});
		});
		const adapter = new SeeapiSafetyAdapter({ apiKey: "local-fixture", fetch: fetcher });
		const submit = vi.fn(
			async (...args: Parameters<typeof adapter.submitImage>): Promise<ModerationSubmission> => {
				const submitted = await adapter.submitImage(...args);
				if (!input.legacyAdapter) return submitted;
				const legacy = { ...submitted };
				delete legacy.nonterminalState;
				return legacy;
			},
		);
		const retrieve = vi.fn(adapter.retrieveImage.bind(adapter));
		const environment = input.callback === false ? {} : callbackEnvironment;
		const options: VerificationOptions = {
			environment,
			moderationProvider: provider,
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
				submitImage: submit,
				retrieveImage: retrieve,
			}),
			createSignedReadUrl: async () => "https://private.example/fast-path.png",
		};
		const phase = { kind: "verification", assetId, generation: 1 } as const;
		return {
			assetId,
			taskId,
			provider,
			phase,
			options,
			submit,
			retrieve,
			fetcher,
			read: () => client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
			dependencies: (overrides: VerificationOptions = {}) =>
				createDatabaseVerifyUploadDependencies(client, { ...options, ...overrides }),
			onPost: (callback: NonNullable<typeof onPost>) => {
				onPost = callback;
			},
			completeOnGet: () => {
				getStatus = "succeeded";
			},
		};
	}

	async function currentOwner(assetId: string): Promise<ImagePhaseOwner> {
		const owner = await getImagePhaseOwner(
			{ kind: "verification", assetId, generation: 1 },
			client,
		);
		if (!owner) throw new Error("MISSING_FIXTURE_PHASE_OWNER");
		return owner;
	}

	async function inputContinuationFixture() {
		const f = await fixture({ kind: "INPUT", status: "succeeded" });
		const asset = await f.read();
		const identity = {
			ownerType: "USER" as const,
			ownerId: asset.ownerId,
			submittedByUserId: asset.ownerId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "verification-clock-test",
			pricingVersion: "test",
			inputSnapshot: {},
			pricingSnapshot: {},
		};
		const job = await client.generationJob.create({
			data: {
				...identity,
				idempotencyKey: f.assetId,
				creditsReserved: 5n,
				status: "RESERVED",
				quote: { create: { ...identity, credits: 5n, costMicros: 10n, expiresAt: new Date() } },
				assets: { create: { assetId: f.assetId, role: "INPUT", assetChecksum: asset.checksum! } },
			},
		});
		jobIds.push(job.id);
		const deps = f.dependencies({
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: "fixture",
				metadata: {},
			}),
			readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		});
		return { ...f, job, deps };
	}

	it.each(["queued", "processing"] as const)(
		"persists authenticated %s as pending without an initial GET when callback delivery is configured",
		async (status) => {
			const f = await fixture({ status });
			const result = await f.dependencies().verify(f.assetId, { workflowId: `fast-${f.assetId}` });
			expect(result).toMatchObject({
				queryOnly: true,
				outboxCommitted: true,
				phaseOwner: { epoch: 1 },
			});
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
			expect(f.fetcher).toHaveBeenCalledOnce();
			expect(
				verifyImageModerationCallbackUrl(
					f.submit.mock.calls[0]![0].callbackUrl!,
					callbackEnvironment,
				),
			).toMatchObject({ assetId: f.assetId, generation: 1 });
			const asset = await f.read();
			expect(asset).toMatchObject({
				status: "VERIFYING",
				verificationProviderTaskId: f.taskId,
				verificationSubmissionUncertain: false,
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
			});
			expect(asset.verificationNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
			expect(
				await client.assetModerationResult.count({
					where: { assetId: f.assetId, status: "APPROVED" },
				}),
			).toBe(0);
			expect(
				await client.outboxEvent.findUniqueOrThrow({
					where: { dedupeKey: `media-asset-verify:${f.assetId}:g1:poll` },
				}),
			).toMatchObject({ status: "PENDING" });
		},
	);

	it.each([
		["no callback", { callback: false }],
		["legacy adapter", { legacyAdapter: true }],
	] as const)(
		"retains first retrieval and legacy no-owner behavior with %s",
		async (_name, options) => {
			const f = await fixture(options);
			await f.dependencies().verify(f.assetId);
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(await getImagePhaseOwner(f.phase, client)).toBeUndefined();
			expect(await f.read()).toMatchObject({
				status: "VERIFYING",
				verificationProviderTaskId: f.taskId,
				verificationSubmissionUncertain: false,
			});
		},
	);

	it.each([-30_000, 30_000])(
		"makes a pending image poll event immediately due on the database clock with host skew %i ms",
		async (skew) => {
			const f = await fixture();
			const [before] = await client.$queryRaw<Array<{ now: Date }>>`
				SELECT clock_timestamp() AS "now"`;
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(before!.now.getTime() + skew));
			const result = await f
				.dependencies()
				.verify(f.assetId, { workflowId: `poll-clock-${f.assetId}` });
			const event = await client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-asset-verify:${f.assetId}:g1:poll` },
			});
			expect(result).toMatchObject({ outputReviewEventId: event.id, queryOnly: true });
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
			expect((await f.read()).verificationNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
			const [stored] = await client.$queryRaw<Array<{ availableAt: Date; databaseNow: Date }>>`
				SELECT "availableAt", clock_timestamp() AS "databaseNow"
				FROM "outbox_event" WHERE "id" = ${event.id}`;
			expect.soft(stored!.availableAt.getTime()).toBeGreaterThanOrEqual(before!.now.getTime() - 1);
			expect
				.soft(stored!.availableAt.getTime())
				.toBeLessThanOrEqual(stored!.databaseNow.getTime() + 1);
			expect(
				await prepareWorkflowOutboxDelivery(
					{ eventId: event.id, workerId: `poll-clock-consumer-${f.assetId}` },
					client,
				),
			).toMatchObject({ event: { id: event.id, eventType: "MEDIA_ASSET_VERIFY", attempts: 1 } });
		},
	);

	it("retains a nonpending retry's explicit future due time instead of applying the immediate default", async () => {
		const f = await fixture({ status: "unknown", provider: "isolated" });
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
			SELECT clock_timestamp() AS "now"`;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(clock!.now.getTime() + 90_000));
		await f.dependencies().verify(f.assetId);
		const asset = await f.read();
		expect(asset.verificationSubmissionUncertain).toBe(true);
		const event = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `media-asset-verify:${f.assetId}:g1:a2` },
		});
		expect(event.availableAt).toEqual(asset.verificationNextAttemptAt);
		expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
		const prepared = await prepareWorkflowOutboxDelivery(
			{ eventId: event.id, workerId: `future-retry-consumer-${f.assetId}` },
			client,
		);
		expect(prepared.event).toBeNull();
		expect(prepared.retryAfterMs).toBeGreaterThan(85_000);
		expect(await client.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PENDING",
			attempts: 0,
			leaseToken: null,
		});
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).not.toHaveBeenCalled();
	});

	it("consumes a synchronous complete response after binding without any GET", async () => {
		const f = await fixture({ status: "succeeded" });
		await f.dependencies().verify(f.assetId, { workflowId: `completed-${f.assetId}` });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await f.read()).toMatchObject({
			status: "READY",
			verificationProviderTaskId: f.taskId,
			verificationSubmissionUncertain: false,
		});
		expect(
			await client.assetModerationResult.count({
				where: { assetId: f.assetId, status: "APPROVED" },
			}),
		).toBe(1);
	});

	it.each([-30_000, 30_000])(
		"makes the final input review dispatch immediately due on the database clock with host skew %i ms",
		async (skew) => {
			const f = await inputContinuationFixture();
			const [before] = await client.$queryRaw<Array<{ now: Date }>>`
				SELECT clock_timestamp() AS "now"`;
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(before!.now.getTime() + skew));
			const result = await f.deps.verify(f.assetId, { workflowId: `clock-${f.assetId}` });
			const event = await client.outboxEvent.findUniqueOrThrow({
				where: {
					dedupeKey: `generation-dispatch-after-verification:${f.job.id}:${f.assetId}:g1`,
				},
			});
			expect(result.verificationCommit).toEqual({
				assetId: f.assetId,
				generation: 1,
				status: "READY",
				eventIds: [event.id],
			});
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
			const [stored] = await client.$queryRaw<Array<{ availableAt: Date; databaseNow: Date }>>`
				SELECT "availableAt", clock_timestamp() AS "databaseNow"
				FROM "outbox_event" WHERE "id" = ${event.id}`;
			// This bracket proves the event was timestamped by PostgreSQL, including
			// a slow host clock that would otherwise still make an incorrect row due.
			expect.soft(stored!.availableAt.getTime()).toBeGreaterThanOrEqual(before!.now.getTime() - 1);
			expect
				.soft(stored!.availableAt.getTime())
				.toBeLessThanOrEqual(stored!.databaseNow.getTime() + 1);
			const prepared = await prepareWorkflowOutboxDelivery(
				{ eventId: event.id, workerId: `clock-consumer-${f.assetId}` },
				client,
			);
			expect(prepared).toMatchObject({
				event: { id: event.id, eventType: "GENERATION_DISPATCH", attempts: 1 },
			});
			expect(prepared.retryAfterMs).toBeUndefined();
		},
	);

	it("preserves an explicitly future dispatch when final review reuses its durable identity", async () => {
		const f = await inputContinuationFixture();
		const [clock] = await client.$queryRaw<Array<{ now: Date; due: Date }>>`
			SELECT clock_timestamp() AS "now", clock_timestamp() + INTERVAL '1 minute' AS "due"`;
		const existing = await client.outboxEvent.create({
			data: {
				eventType: "GENERATION_DISPATCH",
				aggregateType: "GENERATION_JOB",
				aggregateId: f.job.id,
				dedupeKey: `generation-dispatch-after-verification:${f.job.id}:${f.assetId}:g1`,
				payload: { jobId: f.job.id, version: f.job.version },
				availableAt: clock!.due,
			},
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(clock!.now.getTime() + 90_000));
		const result = await f.deps.verify(f.assetId, { workflowId: `future-${f.assetId}` });
		expect(result.verificationCommit?.eventIds).toEqual([existing.id]);
		const prepared = await prepareWorkflowOutboxDelivery(
			{ eventId: existing.id, workerId: `future-consumer-${f.assetId}` },
			client,
		);
		expect(prepared.event).toBeNull();
		expect(prepared.retryAfterMs).toBeGreaterThan(50_000);
		expect(prepared.retryAfterMs).toBeLessThanOrEqual(60_000);
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { id: existing.id } }),
		).toMatchObject({
			availableAt: existing.availableAt,
			status: "PENDING",
			attempts: 0,
			leaseToken: null,
		});
		expect(await client.outboxEvent.count({ where: { dedupeKey: existing.dedupeKey } })).toBe(1);
	});

	it("commits an early callback before query-only immediate continuation of the same task", async () => {
		const f = await fixture();
		let callbackStatus: string | undefined;
		f.onPost(async (callbackUrl) => {
			const identity = verifyImageModerationCallbackUrl(callbackUrl!, callbackEnvironment);
			if (!identity) throw new Error("MISSING_SIGNED_FIXTURE_CALLBACK");
			callbackStatus = (await wakeImageModerationWithOwner(identity, client)).status;
		});
		const deps = f.dependencies();
		vi.spyOn(databaseVerifyUploadDependencies, "verify").mockImplementation(deps.verify);
		const workflowId = `early-${f.assetId}`;
		const context = { runId: workflowId, workflowId, attempt: 1, maxAttempts: 1 };
		const first = await runWithDatabaseClient(client, async () =>
			parsePollingTickResult(
				await executeTask(
					{ taskId: "media-verify-upload", payload: { assetId: f.assetId } },
					context,
				),
			),
		);
		expect(callbackStatus).toBe("recorded");
		expect(first).toMatchObject({
			done: false,
			queryOnly: true,
			waitSeconds: 0,
			retryImmediately: true,
		});
		expect(f.retrieve).not.toHaveBeenCalled();
		const pending = await f.read();
		expect(pending.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		expect(pending.verificationNextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
		f.completeOnGet();
		const owner = await currentOwner(f.assetId);
		const second = await runWithDatabaseClient(client, async () =>
			parsePollingTickResult(
				await executeTask(
					{ taskId: "media-verify-upload", payload: { assetId: f.assetId, queryOnly: true } },
					{ ...context, phaseOwner: owner },
				),
			),
		);
		expect(second.done).toBe(true);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledOnce();
		expect(await f.read()).toMatchObject({ status: "READY", verificationProviderTaskId: f.taskId });
	});

	it.each(["foreign", "stale-epoch", "expired"] as const)(
		"does not begin a paid review after its %s owner fence changes",
		async (change) => {
			const f = await fixture();
			const deps = f.dependencies({
				createSignedReadUrl: async () => {
					const owner = await currentOwner(f.assetId);
					// Inject a concurrent ownership change after the runtime claim and before
					// the submission fence, independently of the still-live business lease.
					await client.mediaWorkflowPhaseOwner.update({
						where: { phaseKey: owner.phaseKey },
						data:
							change === "foreign"
								? { workflowId: "foreign-workflow" }
								: change === "stale-epoch"
									? { epoch: { increment: 1 } }
									: { leasedUntil: new Date(0) },
					});
					return "https://private.example/fenced.png";
				},
			});
			await expect(
				deps.verify(f.assetId, { workflowId: `original-${f.assetId}` }),
			).resolves.toMatchObject({ phaseOwnershipLost: true });
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.retrieve).not.toHaveBeenCalled();
			expect(await f.read()).toMatchObject({
				verificationSubmissionUncertain: false,
				verificationSubmissionToken: null,
				verificationProviderTaskId: null,
			});
		},
	);

	it("blocks a legacy no-owner submit when a live workflow owner appears after its claim", async () => {
		const f = await fixture({ callback: false });
		const deps = f.dependencies({
			createSignedReadUrl: async () => {
				// Exercise the no-context branch of the fused UPDATE after admission.
				await client.mediaWorkflowPhaseOwner.create({
					data: {
						phaseKey: crypto.randomUUID(),
						phaseKind: "verification",
						subjectId: f.assetId,
						generation: 1,
						workflowId: "new-workflow-owner",
						epoch: 1,
						leasedUntil: new Date(Date.now() + 600_000),
					},
				});
				return "https://private.example/legacy-fenced.png";
			},
		});
		await expect(deps.verify(f.assetId)).resolves.toMatchObject({ phaseOwnershipLost: true });
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await f.read()).toMatchObject({
			verificationSubmissionUncertain: false,
			verificationSubmissionToken: null,
			verificationProviderTaskId: null,
		});
	});

	it("rereads owner changes committed while submission waits for its advisory lock", async () => {
		const f = await fixture();
		let signalHeld!: () => void;
		const held = new Promise<void>((resolve) => {
			signalHeld = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holder: Promise<void> | undefined;
		let holderPid = 0;
		const deps = f.dependencies({
			createSignedReadUrl: async () => {
				const owner = await currentOwner(f.assetId);
				holder = client.$transaction(
					async (tx) => {
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.assetId}`}, 0))`;
						const [backend] = await tx.$queryRaw<
							Array<{ pid: number }>
						>`SELECT pg_backend_pid() AS pid`;
						holderPid = backend!.pid;
						await tx.mediaWorkflowPhaseOwner.update({
							where: { phaseKey: owner.phaseKey },
							data: { epoch: { increment: 1 } },
						});
						signalHeld();
						await released;
					},
					{ timeout: 10_000 },
				);
				await held;
				return "https://private.example/waited.png";
			},
		});
		const verification = deps.verify(f.assetId, { workflowId: `waiting-${f.assetId}` });
		await held;
		try {
			let blocked = false;
			for (let i = 0; i < 100; i++) {
				const [row] = await client.$queryRaw<
					Array<{ blocked: boolean }>
				>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${holderPid}::integer = ANY(pg_blocking_pids(pid))) AS blocked`;
				if (row?.blocked) {
					blocked = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(blocked).toBe(true);
		} finally {
			release();
			await holder;
		}
		await expect(verification).resolves.toMatchObject({ phaseOwnershipLost: true });
		expect(f.submit).not.toHaveBeenCalled();
		expect((await f.read()).verificationSubmissionToken).toBeNull();
	});

	it.each(["owner", "business-lease"] as const)(
		"persists late accepted task identity after losing the %s without another call",
		async (loss) => {
			const f = await fixture();
			const deps = f.dependencies({
				afterVideoSubmission: async () => {
					if (loss === "owner") {
						const owner = await currentOwner(f.assetId);
						await client.mediaWorkflowPhaseOwner.update({
							where: { phaseKey: owner.phaseKey },
							data: { epoch: { increment: 1 } },
						});
					} else {
						await client.mediaAsset.update({
							where: { id: f.assetId },
							data: { verificationLeasedUntil: new Date(0) },
						});
					}
				},
			});
			await expect(
				deps.verify(f.assetId, { workflowId: `late-${f.assetId}` }),
			).resolves.toMatchObject({ phaseOwnershipLost: true });
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
			expect(await f.read()).toMatchObject({
				status: "VERIFYING",
				verificationProviderTaskId: f.taskId,
				verificationSubmissionUncertain: false,
			});
			if (loss === "business-lease") {
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: { verificationNextAttemptAt: new Date(0) },
				});
				await deps.verify(f.assetId, {
					workflowId: `late-${f.assetId}`,
					phaseOwner: await currentOwner(f.assetId),
					queryOnly: true,
				});
				expect(f.submit).toHaveBeenCalledOnce();
				expect(f.retrieve).toHaveBeenCalledOnce();
			}
		},
	);

	it.each(["unknown-response", "idempotency-token"] as const)(
		"retains uncertainty without resubmission after %s",
		async (fault) => {
			const f = await fixture({
				status: fault === "unknown-response" ? "unknown" : "processing",
				provider: "isolated",
			});
			if (fault === "idempotency-token") {
				const submit = f.submit.getMockImplementation()!;
				f.submit.mockImplementation(async (...args) => {
					const result = await submit(...args);
					return {
						...result,
						idempotency: { ...result.idempotency, key: "wrong-submission-token" },
					};
				});
			}
			const deps = f.dependencies();
			await deps.verify(f.assetId);
			expect(await f.read()).toMatchObject({
				verificationSubmissionUncertain: true,
				verificationProviderTaskId: null,
			});
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data: { verificationNextAttemptAt: new Date(0) },
			});
			await deps.verify(f.assetId);
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
		},
	);
});

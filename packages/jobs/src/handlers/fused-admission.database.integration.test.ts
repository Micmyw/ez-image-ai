import { PrismaPg } from "@prisma/adapter-pg";
import { TestMediaSafetyAdapter } from "@repo/ai";
import {
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	prepareWorkflowOutboxDelivery,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	consumeFusedLegacyTaskAdmission,
	createFusedLegacyTaskAdmission,
} from "../orchestration/fused-legacy-task-admission";
import { unmanagedLegacyTask } from "../orchestration/legacy-task-ownership";
import { parseDispatchPayload, parseTaskRequest, taskDefinition } from "../orchestration/registry";
import { createDatabaseDispatchStore, createDatabaseVerifyUploadDependencies } from "../runtime";
import { executeTargetedEvent } from "./targeted-event-delivery";

describe("fused engine admission with PostgreSQL receipts", () => {
	let client: PrismaClient;
	const ownerId = `fused-admission-${crypto.randomUUID()}`;
	const eventIds: string[] = [];
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 4 }) });
		await client.$queryRaw`SELECT 1`;
	});
	afterAll(async () => {
		if (!client) return;
		try {
			await client.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
			await client.generationJob.deleteMany({ where: { ownerId } });
			await client.generationQuote.deleteMany({ where: { ownerId } });
			await client.mediaAsset.deleteMany({ where: { ownerId } });
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(kind: "INPUT" | "OUTPUT" | "DISPATCH", executionEngine = "legacy") {
		let aggregateId: string;
		if (kind === "DISPATCH") {
			const quote = await client.generationQuote.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: "nano-banana-2",
					catalogVersion: "test",
					pricingVersion: "test",
					credits: 5n,
					costMicros: 0n,
					inputSnapshot: {},
					pricingSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			const job = await client.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: crypto.randomUUID(),
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: 5n,
					inputSnapshot: {},
					pricingSnapshot: {},
					executionEngine,
				},
			});
			aggregateId = job.id;
		} else {
			const asset = await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind,
					status: "VERIFYING",
					objectKey: `test/fused-admission/${crypto.randomUUID()}.png`,
					mimeType: "image/png",
					byteSize: 16n,
					verificationEngine: executionEngine,
				},
			});
			aggregateId = asset.id;
		}
		const assetReview = kind !== "DISPATCH";
		const payload = assetReview ? { assetId: aggregateId } : { jobId: aggregateId, version: 0 };
		const event = await client.outboxEvent.create({
			data: {
				eventType: assetReview ? "MEDIA_ASSET_VERIFY" : "GENERATION_DISPATCH",
				aggregateType: assetReview ? "MEDIA_ASSET" : "GENERATION_JOB",
				aggregateId,
				dedupeKey: `fused-admission:${crypto.randomUUID()}`,
				payload,
			},
		});
		eventIds.push(event.id);
		const workerId = `workflow:${event.id}`;
		const prepared = await prepareWorkflowOutboxDelivery({ eventId: event.id, workerId }, client);
		expect(prepared.event).toBeTruthy();
		const request = parseTaskRequest({
			taskId: assetReview ? "media-verify-upload" : "media-dispatch-image-kie-nano-banana-2",
			payload,
			outboxReceipt: { eventId: event.id, workerId, leaseToken: prepared.event!.leaseToken },
		});
		const context = {
			runId: event.id,
			workflowId: event.id,
			attempt: 1,
			maxAttempts: taskDefinition(request.taskId).maxAttempts,
		};
		const scope = createFusedLegacyTaskAdmission(client, request, context);
		const changeEngine = () =>
			assetReview
				? client.mediaAsset.update({
						where: { id: aggregateId },
						data: { verificationEngine: "video-workflow-v1" },
					})
				: client.generationJob.update({
						where: { id: aggregateId },
						data: { executionEngine: "video-workflow-v1" },
					});
		const closeBusinessState = () =>
			assetReview
				? client.mediaAsset.update({ where: { id: aggregateId }, data: { status: "QUARANTINED" } })
				: client.generationJob.update({ where: { id: aggregateId }, data: { status: "CANCELED" } });
		const dependencies = {
			begin: scope.begin,
			complete: (input: Parameters<typeof completeWorkflowOutboxExecution>[0]) =>
				completeWorkflowOutboxExecution(input, client),
			fail: (input: Parameters<typeof failWorkflowOutboxExecution>[0]) =>
				failWorkflowOutboxExecution(input, client),
			defer: (input: Parameters<typeof deferWorkflowOutboxExecution>[0]) =>
				deferWorkflowOutboxExecution(input, client),
			recover: vi.fn(async () => ({ continuation: { eventIds: [] } })),
		};
		return {
			aggregateId,
			request,
			context,
			scope,
			assetReview,
			changeEngine,
			closeBusinessState,
			dependencies,
		};
	}

	it.each(["INPUT", "OUTPUT", "DISPATCH"] as const)(
		"observes %s in the begin SQL without an extra read",
		async (kind) => {
			const f = await fixture(kind);
			const query = vi.spyOn(client, "$queryRaw");
			try {
				const execute = vi.fn(async (task) => {
					expect(query).toHaveBeenCalledOnce();
					const proof = f.scope.proofFor(task);
					expect(consumeFusedLegacyTaskAdmission(proof, task, f.context, client)).toBe(true);
					expect(consumeFusedLegacyTaskAdmission(proof, task, f.context, client)).toBe(false);
					return { done: true, waitSeconds: 0, continuation: { eventIds: [] } };
				});
				expect(await executeTargetedEvent(f.request, { ...f.dependencies, execute })).toMatchObject(
					{ deliveryState: "completed" },
				);
				expect(execute).toHaveBeenCalledOnce();
			} finally {
				query.mockRestore();
			}
		},
	);

	it.each(["INPUT", "OUTPUT", "DISPATCH"] as const)(
		"retains the original gate for nonlegacy %s",
		async (kind) => {
			const f = await fixture(kind, "video-workflow-v1");
			await executeTargetedEvent(f.request, {
				...f.dependencies,
				execute: async (task) => {
					expect(f.scope.proofFor(task)).toBeUndefined();
					expect(await unmanagedLegacyTask(client, task.payload)).toMatchObject({
						outcome: "NOT_MANAGED",
					});
					return { done: true, waitSeconds: 0 };
				},
			});
		},
	);

	it.each(["INPUT", "OUTPUT", "DISPATCH"] as const)(
		"keeps %s engine identity immutable in PostgreSQL",
		async (kind) => {
			const f = await fixture(kind);
			await expect(f.changeEngine()).rejects.toThrow(/engine is immutable/);
		},
	);

	it.each(["INPUT", "OUTPUT", "DISPATCH"] as const)(
		"still rejects closed %s business state after a legacy observation",
		async (kind) => {
			const f = await fixture(kind);
			const submit = vi.fn(async () => {
				throw new Error("MUST_NOT_SUBMIT");
			});
			const review = createDatabaseVerifyUploadDependencies(client, {
				moderationProvider: "test",
				safety: Object.assign(new TestMediaSafetyAdapter("ALLOW"), { submitImage: submit }),
			});
			await executeTargetedEvent(f.request, {
				...f.dependencies,
				begin: async (input) => {
					const result = await f.scope.begin(input);
					await f.closeBusinessState();
					return result;
				},
				execute: async (task) => {
					expect(
						consumeFusedLegacyTaskAdmission(f.scope.proofFor(task), task, f.context, client),
					).toBe(true);
					if (f.assetReview)
						expect(await review.verify(f.aggregateId)).toMatchObject({ outboxCommitted: false });
					else
						expect(
							await createDatabaseDispatchStore(client).claimDispatch(
								parseDispatchPayload(task.taskId, task.payload),
							),
						).toBeNull();
					return { done: true, waitSeconds: 0 };
				},
			});
			expect(submit).not.toHaveBeenCalled();
			expect(await client.generationAttempt.count({ where: { jobId: f.aggregateId } })).toBe(0);
		},
	);

	it("does not treat a missing asset as a legacy proof", async () => {
		const f = await fixture("INPUT");
		await client.mediaAsset.delete({ where: { id: f.aggregateId } });
		await executeTargetedEvent(f.request, {
			...f.dependencies,
			execute: async (task) => {
				expect(f.scope.proofFor(task)).toBeUndefined();
				return { done: true, waitSeconds: 0 };
			},
		});
	});

	it("keeps a lost successful begin response held without replaying its handler", async () => {
		const f = await fixture("DISPATCH");
		const input = {
			...f.request.outboxReceipt!,
			timeoutSeconds: taskDefinition(f.request.taskId).timeoutSeconds,
		};
		await f.scope.begin(input);
		const replay = createFusedLegacyTaskAdmission(client, f.request, f.context);
		const execute = vi.fn();
		await expect(
			executeTargetedEvent(f.request, { ...f.dependencies, begin: replay.begin, execute }),
		).rejects.toThrow("OUTBOX_RECOVERY_REQUIRED");
		expect(execute).not.toHaveBeenCalled();
		expect(await beginWorkflowOutboxExecution(input, client)).toMatchObject({
			state: "recovery-required",
		});
	});
});

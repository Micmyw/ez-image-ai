import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_RULE_VERSION, TestMediaSafetyAdapter } from "@repo/ai";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabaseVerifyUploadDependencies } from "../runtime";

let client: PrismaClient;
const assetIds: string[] = [];
const providers: string[] = [];

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
	const url = new URL(connectionString);
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.port !== "55432" ||
		!/(^|[_-])test([_-]|$)/u.test(url.pathname.slice(1)) ||
		url.search ||
		url.hash
	)
		throw new Error("TEST_DATABASE_URL must name a local test database on port 55432");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
});

afterAll(async () => {
	if (!client) return;
	try {
		const incidents = await client.moderationIncident.findMany({
			where: { provider: { in: providers } },
			select: { id: true },
		});
		await client.outboxEvent.deleteMany({
			where: { aggregateId: { in: [...assetIds, ...incidents.map(({ id }) => id)] } },
		});
		// Retain append-only evidence and its assets in the disposable test database.
		// Only fixtures without evidence can be removed without disabling invariants.
		await client.mediaAsset.deleteMany({
			where: { id: { in: assetIds }, moderationResults: { none: {} } },
		});
	} finally {
		await client.$disconnect();
	}
});

async function fixture(verificationEngine = "legacy") {
	const assetId = crypto.randomUUID();
	const provider = `handoff-${assetId}`;
	const taskId = `task-${assetId}`;
	assetIds.push(assetId);
	providers.push(provider);
	await client.mediaAsset.create({
		data: {
			id: assetId,
			ownerType: "USER",
			ownerId: `handoff-owner-${assetId}`,
			kind: "OUTPUT",
			status: "VERIFYING",
			verificationEngine,
			objectKey: `users/handoff/assets/${assetId}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
	const submit = vi.fn(async (input: { idempotencyKey: string; ruleVersion: string }) => ({
		moderationTaskId: taskId,
		status: "QUEUED" as const,
		ruleVersion: input.ruleVersion,
		idempotency: { key: input.idempotencyKey, providerSupported: true, replayed: false },
	}));
	const retrieve = vi.fn(async () => ({
		decision: "REVIEW" as const,
		reasonCode: "IMAGE_PROCESSING",
		ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
	}));
	const options = {
		environment: {},
		moderationProvider: provider,
		safety: Object.assign(new TestMediaSafetyAdapter("ALLOW"), {
			submitImage: submit,
			retrieveImage: retrieve,
		}),
		createSignedReadUrl: async () => "https://private.example/handoff.png",
	};
	return { assetId, taskId, submit, retrieve, options };
}

describe("fenced verification submission and pending handoff", () => {
	it("avoids submission/binding pre-reads and reads a pending event only on a dedupe conflict", async () => {
		const f = await fixture();
		let phase = "claim";
		const preReads: string[] = [];
		let pollLookups = 0;
		const observed = client.$extends({
			query: {
				mediaAsset: {
					findFirst({ args, query }) {
						if (phase === "submission" || phase === "binding") preReads.push(phase);
						return query(args);
					},
				},
				outboxEvent: {
					findUniqueOrThrow({ args, query }) {
						if (args.where.dedupeKey === `media-asset-verify:${f.assetId}:g1:poll`) pollLookups++;
						return query(args);
					},
				},
			},
		});
		const originalSubmit = f.submit.getMockImplementation()!;
		f.submit.mockImplementation(async (input) => {
			phase = "binding";
			return originalSubmit(input);
		});
		f.retrieve.mockImplementation(async () => {
			phase = "pending";
			return {
				decision: "REVIEW",
				reasonCode: "IMAGE_PROCESSING",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			};
		});
		const deps = createDatabaseVerifyUploadDependencies(observed as unknown as PrismaClient, {
			...f.options,
			createSignedReadUrl: async () => {
				phase = "submission";
				return "https://private.example/handoff.png";
			},
		});
		const first = await deps.verify(f.assetId);
		const event = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `media-asset-verify:${f.assetId}:g1:poll` },
		});
		expect.soft(preReads).toEqual([]);
		expect.soft(pollLookups).toBe(0);
		expect(first).toMatchObject({
			outputReviewEventId: event.id,
			outboxCommitted: true,
			queryOnly: true,
		});
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		const second = await deps.verify(f.assetId, { queryOnly: true });
		expect(second).toMatchObject({
			outputReviewEventId: event.id,
			outboxCommitted: false,
			queryOnly: true,
		});
		expect(pollLookups).toBe(1);
		expect(await client.outboxEvent.count({ where: { dedupeKey: event.dedupeKey } })).toBe(1);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledTimes(2);
	});

	it.each([
		["generation", { verificationGeneration: 2 }],
		["lease token", { verificationLeaseToken: crypto.randomUUID() }],
		["expired lease", { verificationLeasedUntil: new Date(0) }],
		["existing task", { verificationProviderTaskId: "another-task" }],
		["uncertain acceptance", { verificationSubmissionUncertain: true }],
		["terminal state", { status: "QUARANTINED" }],
	] satisfies Array<[string, Prisma.MediaAssetUpdateInput]>)(
		"does not submit after losing the %s fence before submission",
		async (_field, data) => {
			const f = await fixture();
			const deps = createDatabaseVerifyUploadDependencies(client, {
				...f.options,
				createSignedReadUrl: async () => {
					await client.mediaAsset.update({ where: { id: f.assetId }, data });
					return "https://private.example/handoff.png";
				},
			});
			await deps.verify(f.assetId);
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.retrieve).not.toHaveBeenCalled();
			expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject(
				data,
			);
		},
	);

	it.each([
		["generation", { verificationGeneration: 2 }],
		["lease token", { verificationLeaseToken: crypto.randomUUID() }],
		["submission token", { verificationSubmissionToken: crypto.randomUUID() }],
		["different task", { verificationProviderTaskId: "another-task" }],
		["terminal state", { status: "QUARANTINED" }],
	] satisfies Array<[string, Prisma.MediaAssetUpdateInput]>)(
		"does not overwrite the %s fence when binding a submitted task",
		async (_field, data) => {
			const f = await fixture();
			const deps = createDatabaseVerifyUploadDependencies(client, {
				...f.options,
				afterVideoSubmission: async () => {
					await client.mediaAsset.update({ where: { id: f.assetId }, data });
				},
			});
			await deps.verify(f.assetId);
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).not.toHaveBeenCalled();
			const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
			if (_field === "lease token") {
				// Existing unknown-result recovery records the accepted task as evidence
				// and terminalizes the uncertainty without binding it to a lost lease.
				expect(asset).toMatchObject({
					status: "VERIFICATION_FAILED",
					verificationLeaseToken: null,
					verificationProviderTaskId: null,
					verificationSubmissionUncertain: true,
					verificationLastErrorCode: "VIDEO_SUBMISSION_RESULT_NOT_BOUND",
				});
			} else {
				expect(asset).toMatchObject(data);
			}
		},
	);

	it("does not submit or query an asset owned by another verification engine", async () => {
		const f = await fixture("video-workflow-v1");
		const deps = createDatabaseVerifyUploadDependencies(client, f.options);
		await deps.verify(f.assetId);
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			verificationEngine: "video-workflow-v1",
			verificationAttemptCount: 0,
			verificationProviderTaskId: null,
			verificationSubmissionUncertain: false,
		});
	});

	it("binds an expired lease for recovery without retrieving or submitting again", async () => {
		const f = await fixture();
		const deps = createDatabaseVerifyUploadDependencies(client, {
			...f.options,
			afterVideoSubmission: async () => {
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: { verificationLeasedUntil: new Date(0) },
				});
			},
		});
		await deps.verify(f.assetId);
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			verificationProviderTaskId: f.taskId,
			verificationSubmissionUncertain: false,
			status: "VERIFYING",
		});
		await deps.verify(f.assetId, { queryOnly: true });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledOnce();
	});

	it("retains an early matching task binding and its callback marker", async () => {
		const f = await fixture();
		const callbackAt = new Date("2026-10-21T00:00:00Z");
		const deps = createDatabaseVerifyUploadDependencies(client, {
			...f.options,
			afterVideoSubmission: async () => {
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: {
						verificationProviderTaskId: f.taskId,
						verificationCallbackReceivedAt: callbackAt,
					},
				});
			},
		});
		await deps.verify(f.assetId);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).toHaveBeenCalledOnce();
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			verificationProviderTaskId: f.taskId,
			verificationCallbackReceivedAt: callbackAt,
			verificationSubmissionUncertain: false,
		});
	});

	it.each(["new token", "existing token"])(
		"preserves submission metadata and update timestamps for a %s",
		async (state) => {
			const f = await fixture();
			const token = state === "existing token" ? crypto.randomUUID() : null;
			const callbackAt = new Date("2026-10-21T00:00:00Z");
			const read = () => client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } });
			let beforeSubmit: Awaited<ReturnType<typeof read>> | undefined;
			let beforeRetrieve: Awaited<ReturnType<typeof read>> | undefined;
			const originalSubmit = f.submit.getMockImplementation()!;
			const originalRetrieve = f.retrieve.getMockImplementation()!;
			f.submit.mockImplementation(async (input) => {
				beforeSubmit = await read();
				return originalSubmit(input);
			});
			f.retrieve.mockImplementation(async () => {
				beforeRetrieve = await read();
				return originalRetrieve();
			});
			const deps = createDatabaseVerifyUploadDependencies(client, {
				...f.options,
				createSignedReadUrl: async () => {
					await client.mediaAsset.update({
						where: { id: f.assetId },
						data: {
							verificationSubmissionToken: token,
							verificationCallbackReceivedAt: callbackAt,
							updatedAt: new Date(0),
						},
					});
					return "https://private.example/handoff.png";
				},
				afterVideoSubmission: async () => {
					await client.mediaAsset.update({
						where: { id: f.assetId },
						data: { updatedAt: new Date(0) },
					});
				},
			});
			await deps.verify(f.assetId);
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(beforeSubmit).toMatchObject({
				verificationSubmissionToken: token ?? expect.any(String),
				verificationCallbackReceivedAt: token ? callbackAt : null,
				verificationSubmissionUncertain: true,
				verificationSubmittedAt: expect.any(Date),
			});
			expect(beforeSubmit!.updatedAt.getTime()).toBeGreaterThan(0);
			expect(f.submit.mock.calls[0]![0].idempotencyKey).toBe(
				beforeSubmit!.verificationSubmissionToken,
			);
			expect(beforeRetrieve).toMatchObject({
				verificationProviderTaskId: f.taskId,
				verificationSubmissionToken: beforeSubmit!.verificationSubmissionToken,
				verificationCallbackReceivedAt: token ? callbackAt : null,
				verificationSubmissionUncertain: false,
			});
			expect(beforeRetrieve!.updatedAt.getTime()).toBeGreaterThan(0);
		},
	);

	it("does not submit again after an unknown provider acceptance", async () => {
		const f = await fixture();
		f.submit.mockRejectedValue(new Error("MODERATION_UNAVAILABLE"));
		const deps = createDatabaseVerifyUploadDependencies(client, f.options);
		await deps.verify(f.assetId);
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await deps.verify(f.assetId);
		await deps.verify(f.assetId, { queryOnly: true });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			verificationProviderTaskId: null,
			verificationSubmissionUncertain: true,
		});
	});
});

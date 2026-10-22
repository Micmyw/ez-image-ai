import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	SeeapiSafetyAdapter,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import { wakeImageModeration } from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
	runPolling,
	type DurableSteps,
	type InvokeTask,
} from "../../../../apps/workflows/src/orchestrator";
import { parsePollingTickResult, type PollingTickResult } from "../orchestration/contracts";
import { executeTask } from "../orchestration/executor";
import {
	createDatabaseVerifyUploadDependencies,
	databaseVerifyUploadDependencies,
} from "../runtime";

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const context = { attempt: 1, maxAttempts: 1, runId: "moderation-polling-database-test" };

describe("image moderation callbacks through real PostgreSQL and Workflow polling", () => {
	let client: PrismaClient;
	const assetIds: string[] = [];

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				url.pathname !== "/scanless_phase_owner_migration_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search !== "" ||
			url.hash !== ""
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		if (!client) return;
		try {
			await client.outboxEvent.deleteMany({ where: { aggregateId: { in: assetIds } } });
			// Evidence is append-only. Its assets remain in the explicitly disposable
			// integration database; never disable the production immutability trigger.
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(kind: "INPUT" | "OUTPUT", finalStatus: "processing" | "succeeded") {
		const assetId = crypto.randomUUID();
		assetIds.push(assetId);
		const taskId = `review_${assetId}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `moderation-poll-${assetId}`,
				kind,
				status: "VERIFYING",
				objectKey: `users/test/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
			},
		});
		const read = () => client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
		const snapshots: Array<Awaited<ReturnType<typeof read>>> = [];
		const callbackResults: string[] = [];
		let retrievalCount = 0;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const isSubmission = init?.method === "POST";
			if (!isSubmission) {
				retrievalCount++;
				const before = await read();
				snapshots.push(before);
				if (retrievalCount === 1) {
					callbackResults.push(
						await wakeImageModeration(
							{
								assetId,
								generation: before.verificationGeneration,
								submissionToken: before.verificationSubmissionToken!,
							},
							client,
						),
					);
					snapshots.push(await read());
				}
			}
			const status = !isSubmission && retrievalCount > 1 ? finalStatus : "processing";
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
		const submitImage = vi.fn(adapter.submitImage.bind(adapter));
		const retrieveImage = vi.fn(adapter.retrieveImage.bind(adapter));
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			environment: {},
			moderationProvider: "seeapi",
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), { submitImage, retrieveImage }),
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: "fixture-etag",
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			createSignedReadUrl: async () => "https://private.example/verified.png",
		});
		// Only external adapter wiring changes. Claim, commit, executor reads and
		// Workflow decisions all use their production implementations and real PG.
		vi.spyOn(databaseVerifyUploadDependencies, "verify").mockImplementation(dependencies.verify);
		const execute = async (queryOnly = false) =>
			runWithDatabaseClient(client, async () =>
				parsePollingTickResult(
					await executeTask(
						{
							taskId: "media-verify-upload",
							payload: { assetId, ...(queryOnly ? { queryOnly } : {}) },
						},
						context,
					),
				),
			);
		return {
			assetId,
			taskId,
			read,
			snapshots,
			callbackResults,
			submitImage,
			retrieveImage,
			execute,
		};
	}

	it.each(["INPUT", "OUTPUT"] as const)(
		"immediately queries a %s callback received during its first query without a Workflow sleep or second submission",
		async (kind) => {
			const f = await fixture(kind, "succeeded");
			const polls: PollingTickResult[] = [];
			const sleep = vi.fn(async () => {
				throw new Error("UNEXPECTED_WORKFLOW_SLEEP");
			});
			const step: DurableSteps = { do: async (_name, _config, callback) => callback(), sleep };
			const invoke = vi.fn<InvokeTask>(async (request, executionContext) => {
				const poll = parsePollingTickResult(await executeTask(request, executionContext));
				polls.push(poll);
				return { status: "ok", poll };
			});
			const result = await runWithDatabaseClient(client, () =>
				runPolling(
					{ taskId: "media-verify-upload", payload: { assetId: f.assetId } },
					context.runId,
					step,
					invoke,
				),
			);
			expect(result).toMatchObject({ status: "ok", poll: { done: true, waitSeconds: 0 } });
			expect(polls).toMatchObject([
				{ done: false, queryOnly: true, retryImmediately: true, waitSeconds: 0 },
				{ done: true, waitSeconds: 0 },
			]);
			expect(sleep).not.toHaveBeenCalled();
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(invoke.mock.calls[1]?.[0].payload).toEqual({ assetId: f.assetId, queryOnly: true });
			expect(f.submitImage).toHaveBeenCalledOnce();
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			for (const [input] of f.retrieveImage.mock.calls)
				expect(input.moderationTaskId).toBe(f.taskId);
			expect(f.callbackResults).toEqual(["recorded"]);
			const [beforeCallback, afterCallback, secondQuery] = f.snapshots;
			expect(beforeCallback!.verificationCallbackReceivedAt).toBeNull();
			expect(afterCallback!.verificationCallbackReceivedAt).toBeInstanceOf(Date);
			expect(afterCallback!.verificationLeaseToken).toBe(beforeCallback!.verificationLeaseToken);
			expect(afterCallback!.verificationLeasedUntil).toEqual(
				beforeCallback!.verificationLeasedUntil,
			);
			expect(secondQuery!.verificationLeaseToken).not.toBe(beforeCallback!.verificationLeaseToken);
			expect(secondQuery!.verificationCallbackReceivedAt).toEqual(
				afterCallback!.verificationCallbackReceivedAt,
			);
			expect(await f.read()).toMatchObject({
				status: "READY",
				verificationGeneration: 1,
				verificationAttemptCount: 2,
				verificationProviderTaskId: f.taskId,
				verificationSubmissionUncertain: false,
				verificationLeaseToken: null,
				verificationNextAttemptAt: null,
			});
			expect(
				await client.assetModerationResult.findMany({
					where: { assetId: f.assetId },
					orderBy: { attemptNumber: "asc" },
				}),
			).toMatchObject([
				{
					status: "PENDING",
					providerTaskId: f.taskId,
					verificationGeneration: 1,
					attemptNumber: 1,
				},
				{
					status: "APPROVED",
					providerTaskId: f.taskId,
					verificationGeneration: 1,
					attemptNumber: 2,
				},
			]);
		},
	);

	it.each(["INPUT", "OUTPUT"] as const)(
		"restores persisted backoff after a %s callback has already been consumed",
		async (kind) => {
			const f = await fixture(kind, "processing");
			expect(await f.execute()).toMatchObject({
				retryImmediately: true,
				waitSeconds: 0,
				queryOnly: true,
			});
			const second = await f.execute(true);
			expect(second.retryImmediately).toBeUndefined();
			expect(second.waitSeconds).toBeGreaterThanOrEqual(1);
			const asset = await f.read();
			expect(asset.verificationNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
			expect(
				await wakeImageModeration(
					{
						assetId: f.assetId,
						generation: 1,
						submissionToken: asset.verificationSubmissionToken!,
					},
					client,
				),
			).toBe("recorded");
			expect((await f.execute(true)).retryImmediately).toBeUndefined();
			expect((await f.read()).verificationNextAttemptAt).toEqual(asset.verificationNextAttemptAt);
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			expect(f.submitImage).toHaveBeenCalledOnce();
		},
	);

	it.each(["active lease", "uncertain submission"] as const)(
		"does not immediately poll or submit when a callback sees an %s",
		async (state) => {
			const f = await fixture("OUTPUT", "succeeded");
			const submissionToken = crypto.randomUUID();
			const leaseToken = state === "active lease" ? crypto.randomUUID() : null;
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data: {
					verificationGeneration: 1,
					verificationProvider: "seeapi",
					verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					verificationProviderTaskId: state === "active lease" ? f.taskId : null,
					verificationSubmissionToken: submissionToken,
					verificationSubmissionUncertain: state === "uncertain submission",
					verificationLeaseToken: leaseToken,
					verificationLeasedUntil: leaseToken ? new Date(Date.now() + 120_000) : null,
					verificationNextAttemptAt: new Date(0),
				},
			});
			expect(
				await wakeImageModeration({ assetId: f.assetId, generation: 1, submissionToken }, client),
			).toBe("recorded");
			const result = await f.execute(true);
			expect(result).toMatchObject({ done: false });
			expect(result.retryImmediately).toBeUndefined();
			expect(result.waitSeconds).toBeGreaterThanOrEqual(1);
			expect(f.retrieveImage).not.toHaveBeenCalled();
			expect(f.submitImage).not.toHaveBeenCalled();
			expect(await f.read()).toMatchObject({
				status: "VERIFYING",
				verificationLeaseToken: leaseToken,
				verificationSubmissionUncertain: state === "uncertain submission",
				verificationSubmissionToken: submissionToken,
			});
		},
	);
});

import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import {
	createCreditGrant,
	releaseCredits,
	reserveCreditsInTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { createVideoJobRecord, createVideoQuoteRecord } from "@repo/database/video-v1";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowBinding: () => undefined,
	getVideoWorkflowReadinessBindings: () => ({}),
}));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => ({ maximumInputBytes: 10_000_000 }),
}));
import { auth } from "@repo/auth";

import { videoV1Router } from "./router";

const ownerId = `video-receipt-test-${crypto.randomUUID()}`;
const ctx = { context: { headers: new Headers() } };
const limits = {
	ownerConcurrency: 1,
	globalConcurrency: 5,
	providerConcurrency: 5,
	maximumStorageBytes: 1_000_000_000n,
	maximumInputBytes: 10_000_000,
};
const price = {
	credits: 7n,
	pricingVersion: "ISOLATED_RECEIPT_TEST",
	providerCostMicros: 2n,
	moderationCostMicros: 1n,
	pricingBasis: "TEST_ONLY_NOT_A_RETAIL_PRICE",
};
const request = {
	productKey: "video-kling-3" as const,
	mode: "image-to-video" as const,
	prompt: "A sailboat crosses a blue lake",
	duration: 5,
	resolution: "720p" as const,
	aspectRatio: "9:16" as const,
	sound: false,
	inputAssetId: "historical-sealed-input",
};
const profiles = {
	visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
	textSafetyProfile: createVideoTextSafetyProfile(),
	audioSafetyPolicy: createVideoAudioSafetyPolicy(),
};
let client: PrismaClient;
let quoteId: string;
let jobId: string;
let accountId: string;
const idempotencyKey = crypto.randomUUID();

beforeAll(async () => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
	const url = new URL(connectionString);
	if (
		!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
	)
		throw new Error("UNSAFE_TEST_DATABASE");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: ownerId, role: "user", isAnonymous: false },
		session: { id: "test-session" },
	} as never);
	vi.stubEnv("VIDEO_V1_ENABLED", "false");
	vi.stubEnv("VIDEO_V1_ACCESS", "authenticated");
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	accountId = account.id;
	await createCreditGrant({ accountId, amount: 100n, referenceKey: `test:${ownerId}` }, client);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			verificationEngine: "video-workflow-v1",
			objectKey: `test/receipt/${ownerId}.png`,
			mimeType: "image/png",
			byteSize: 100n,
			width: 100,
			height: 100,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
	request.inputAssetId = asset.id;
	const base = await createVideoQuoteRecord(
		{
			ownerId,
			request: { ...request, aspectRatio: "source" },
			price,
			...profiles,
			maximumInputBytes: limits.maximumInputBytes,
		},
		client,
	);
	const {
		id: _id,
		createdAt: _createdAt,
		...fields
	} = await client.generationQuote.findUniqueOrThrow({ where: { id: base.quoteId } });
	// Insert a pre-change signed quote and accepted order. Never mutate an immutable row.
	const historical = {
		...fields,
		inputSnapshot: {
			...(fields.inputSnapshot as Record<string, unknown>),
			aspectRatio: request.aspectRatio,
		},
		expiresAt: new Date(Date.now() - 60_000),
	};
	const quote = await client.generationQuote.create({
		data: {
			...historical,
			inputSnapshot: historical.inputSnapshot as never,
			pricingSnapshot: fields.pricingSnapshot as never,
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(historical),
		},
	});
	quoteId = quote.id;
	jobId = await client.$transaction(async (tx) => {
		const job = await tx.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId,
				idempotencyKey,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: quote.credits,
				executionEngine: "video-workflow-v1",
				inputSnapshot: quote.inputSnapshot as never,
				pricingSnapshot: quote.pricingSnapshot as never,
			},
		});
		await reserveCreditsInTransaction(
			{ accountId, jobId: job.id, amount: quote.credits, referenceKey: `job:${job.id}:reserve` },
			tx,
		);
		await tx.videoExecution.create({
			data: {
				jobId: job.id,
				workflowInstanceId: `video-v1-${job.id}`,
				modelContractVersion: quote.catalogVersion,
				stage: "QUEUED",
				startState: "PENDING",
			},
		});
		return job.id;
	});
});
afterAll(async () => {
	vi.unstubAllEnvs();
	if (!client) return;
	const reservation = accountId
		? await client.creditReservation.findFirst({ where: { accountId, status: "ACTIVE" } })
		: null;
	if (reservation)
		await releaseCredits(
			{
				reservationId: reservation.id,
				amount: reservation.amount,
				referenceKey: `test-cleanup:${jobId}`,
			},
			client,
		);
	if (jobId) {
		await client.videoExecution.update({ where: { jobId }, data: { stage: "FAILED" } });
		await client.generationJob.update({
			where: { id: jobId },
			data: { status: "FAILED", terminalAt: new Date() },
		});
	}
	await client.$disconnect();
});

it("replays a historical Kling ratio through protected RPC and real DB without changing the receipt or reserving twice", async () => {
	const before = await client.generationJob.findUniqueOrThrow({ where: { id: jobId } });
	await runWithDatabaseClient(client, async () => {
		const receipt = { quoteId, idempotencyKey, request };
		await expect(call(videoV1Router.jobs.create, receipt, ctx)).resolves.toMatchObject({
			jobId,
			credits: "7",
			stage: "QUEUED",
		});
		await expect(call(videoV1Router.jobs.create, receipt, ctx)).resolves.toMatchObject({ jobId });
		await expect(call(videoV1Router.jobs.get, { jobId }, ctx)).resolves.toMatchObject({ jobId });
		await expect(
			call(
				videoV1Router.jobs.create,
				{ ...receipt, request: { ...request, aspectRatio: "16:9" } },
				ctx,
			),
		).rejects.toMatchObject({ code: "CONFLICT", message: "IDEMPOTENCY_CONFLICT" });
		await expect(call(videoV1Router.quote, request, ctx)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		vi.stubEnv("VIDEO_V1_ENABLED", "true");
		await expect(
			call(videoV1Router.jobs.create, { ...receipt, idempotencyKey: crypto.randomUUID() }, ctx),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message: "VIDEO_MODEL_OPTION_UNAVAILABLE" });
	});
	expect(await client.generationJob.count({ where: { ownerId } })).toBe(1);
	expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
	expect(
		(await client.generationJob.findUniqueOrThrow({ where: { id: jobId } })).inputSnapshot,
	).toEqual(before.inputSnapshot);
});

it("preserves direct database admission replay but rejects a new historical-ratio admission", async () => {
	const input = { ownerId, quoteId, idempotencyKey, request, price, ...profiles, limits };
	await expect(createVideoJobRecord(input, client)).resolves.toEqual({ jobId, replayed: true });
	await expect(
		createVideoJobRecord({ ...input, idempotencyKey: crypto.randomUUID() }, client),
	).rejects.toThrow();
	expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
});

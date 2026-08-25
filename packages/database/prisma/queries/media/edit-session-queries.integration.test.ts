import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "../../generated/client";
import { markMediaAssetDeletedTransaction } from "./assets";
import { createCreditGrant } from "./credits";
import {
	getImageEditSessionForOwner,
	listImageEditSessionsForOwner,
	renameImageEditSessionForOwner,
} from "./edit-sessions";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("image edit session queries", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("paginates one owner's sessions stably by updatedAt and id", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `pr5-page-owner-${suffix}`;
		const updatedAt = new Date("2026-08-25T01:00:00.000Z");
		const ids = [`pr5-page-${suffix}-a`, `pr5-page-${suffix}-b`, `pr5-page-${suffix}-c`];
		for (const id of ids) {
			await client.imageEditSession.create({
				data: { id, ownerType: "USER", ownerId, rootAssetId: `root-${id}`, updatedAt },
			});
		}
		await client.imageEditSession.create({
			data: {
				id: `pr5-page-${suffix}-foreign`,
				ownerType: "USER",
				ownerId: `other-${ownerId}`,
				rootAssetId: "foreign-root",
				updatedAt: new Date("2099-01-01T00:00:00.000Z"),
			},
		});

		const first = await listImageEditSessionsForOwner(
			{ ownerType: "USER", ownerId, take: 2 },
			client,
		);
		expect(first.items.map(({ id }) => id)).toEqual([ids[2], ids[1]]);
		expect(first.hasMore).toBe(true);
		expect(first.items.every((item) => item._count.jobs === 0)).toBe(true);

		const last = first.items.at(-1)!;
		const second = await listImageEditSessionsForOwner(
			{
				ownerType: "USER",
				ownerId,
				take: 2,
				cursor: { updatedAt: last.updatedAt, id: last.id },
			},
			client,
		);
		expect(second.items.map(({ id }) => id)).toEqual([ids[0]]);
		expect(second.hasMore).toBe(false);
	});

	it("gets and renames only the authenticated owner's session", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `pr5-rename-owner-${suffix}`;
		const session = await client.imageEditSession.create({
			data: { ownerType: "USER", ownerId, rootAssetId: `root-${suffix}` },
		});

		await expect(
			getImageEditSessionForOwner(
				{ ownerType: "USER", ownerId: `other-${ownerId}`, sessionId: session.id },
				client,
			),
		).resolves.toBeNull();
		await expect(
			renameImageEditSessionForOwner(
				{
					ownerType: "USER",
					ownerId: `other-${ownerId}`,
					sessionId: session.id,
					title: "Stolen title",
				},
				client,
			),
		).resolves.toBeNull();
		await expect(
			renameImageEditSessionForOwner(
				{
					ownerType: "USER",
					ownerId,
					sessionId: session.id,
					title: "Product hero refinements",
				},
				client,
			),
		).resolves.toMatchObject({ id: session.id, title: "Product hero refinements" });
		await expect(
			getImageEditSessionForOwner({ ownerType: "USER", ownerId, sessionId: session.id }, client),
		).resolves.toMatchObject({ id: session.id, title: "Product hero refinements" });
	});

	it("does not expose cross-owner or non-edit jobs through a user's session", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `pr5-session-owner-${suffix}`;
		const foreignOwnerId = `pr5-session-foreign-${suffix}`;
		const session = await client.imageEditSession.create({
			data: { ownerType: "USER", ownerId, rootAssetId: `root-${suffix}` },
		});
		const foreignQuote = await createQuote(client, foreignOwnerId, `foreign-${suffix}`);
		await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: foreignOwnerId,
				submittedByUserId: foreignOwnerId,
				quoteId: foreignQuote.id,
				idempotencyKey: `pr5-foreign-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "pr5-catalog",
				pricingVersion: "pr5-pricing",
				creditsReserved: 4n,
				inputSnapshot: foreignQuote.inputSnapshot as Prisma.InputJsonValue,
				pricingSnapshot: {},
				editSessionId: session.id,
			},
		});
		const nonEditQuote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "image-fast",
				catalogVersion: "pr5-catalog",
				pricingVersion: "pr5-pricing",
				credits: 4n,
				costMicros: 0n,
				inputSnapshot: { kind: "text-to-image", prompt: `private non-edit prompt ${suffix}` },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60 * 60_000),
			},
		});
		await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: nonEditQuote.id,
				idempotencyKey: `pr5-non-edit-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "pr5-catalog",
				pricingVersion: "pr5-pricing",
				creditsReserved: 4n,
				inputSnapshot: nonEditQuote.inputSnapshot as Prisma.InputJsonValue,
				pricingSnapshot: {},
				editSessionId: session.id,
			},
		});

		const listed = await listImageEditSessionsForOwner(
			{ ownerType: "USER", ownerId, take: 20 },
			client,
		);
		const detail = await getImageEditSessionForOwner(
			{ ownerType: "USER", ownerId, sessionId: session.id },
			client,
		);

		expect.soft(listed.items.find(({ id }) => id === session.id)?._count.jobs).toBe(0);
		expect(detail?.jobs).toEqual([]);
	});

	it("keeps a deleted output in the timeline without changing its ledger or deleting the job", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `pr5-deleted-owner-${suffix}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 20n,
				referenceKey: `pr5-deleted-grant-${suffix}`,
			},
			client,
		);
		const session = await client.imageEditSession.create({
			data: { ownerType: "USER", ownerId, rootAssetId: `root-${suffix}` },
		});
		const quote = await createQuote(client, ownerId, suffix);
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `pr5-deleted-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "pr5-catalog",
				pricingVersion: "pr5-pricing",
				creditsReserved: 4n,
				inputSnapshot: quote.inputSnapshot as Prisma.InputJsonValue,
				pricingSnapshot: {},
				status: "SUCCEEDED",
				terminalAt: new Date(),
				editSessionId: session.id,
			},
		});
		const output = await createReadyOutput(client, ownerId, suffix);
		await client.generationJobAsset.create({
			data: {
				jobId: job.id,
				assetId: output.id,
				assetChecksum: output.checksum!,
				role: "OUTPUT",
				position: 0,
			},
		});
		const ledgerCount = await client.creditLedgerEntry.count({ where: { accountId: account.id } });

		await markMediaAssetDeletedTransaction({ assetId: output.id, ownerId }, client);

		expect(await client.creditLedgerEntry.count({ where: { accountId: account.id } })).toBe(
			ledgerCount,
		);
		const timeline = await getImageEditSessionForOwner(
			{ ownerType: "USER", ownerId, sessionId: session.id },
			client,
		);
		expect(timeline).toMatchObject({
			id: session.id,
			jobs: [
				{
					id: job.id,
					assets: [
						{
							role: "OUTPUT",
							asset: { id: output.id, status: "DELETED", deletedAt: expect.any(Date) },
						},
					],
				},
			],
		});
		expect(await client.generationJob.findUnique({ where: { id: job.id } })).not.toBeNull();
		expect(await client.generationQuote.findUnique({ where: { id: quote.id } })).not.toBeNull();
	});

	it("uses SET NULL rather than cascading jobs when a session row is removed", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `pr5-set-null-owner-${suffix}`;
		const session = await client.imageEditSession.create({
			data: { ownerType: "USER", ownerId, rootAssetId: `root-${suffix}` },
		});
		const quote = await createQuote(client, ownerId, `set-null-${suffix}`);
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `pr5-set-null-job-${suffix}`,
				productKey: "image-fast",
				catalogVersion: "pr5-catalog",
				pricingVersion: "pr5-pricing",
				creditsReserved: 4n,
				inputSnapshot: quote.inputSnapshot as Prisma.InputJsonValue,
				pricingSnapshot: {},
				editSessionId: session.id,
			},
		});

		await client.imageEditSession.delete({ where: { id: session.id } });

		await expect(client.generationJob.findUnique({ where: { id: job.id } })).resolves.toMatchObject(
			{
				id: job.id,
				editSessionId: null,
			},
		);
		await expect(
			client.generationQuote.findUnique({ where: { id: quote.id } }),
		).resolves.toMatchObject({
			id: quote.id,
		});
	});
});

async function createQuote(client: PrismaClient, ownerId: string, suffix: string) {
	return client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "pr5-catalog",
			pricingVersion: "pr5-pricing",
			credits: 4n,
			costMicros: 0n,
			inputSnapshot: {
				kind: "image-to-image",
				prompt: `private prompt ${suffix}`,
				sourceAssetId: `root-${suffix}`,
			},
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60 * 60_000),
		},
	});
}

async function createReadyOutput(client: PrismaClient, ownerId: string, suffix: string) {
	const checksum = crypto.randomUUID().replaceAll("-", "").repeat(2);
	const validUntil = new Date(Date.now() + 60 * 60_000);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/pr5-query-${suffix}`,
			mimeType: "image/png",
			byteSize: 128n,
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: "pr5-query-rule",
			verificationPolicyVersion: "pr5-query-policy",
			verificationValidUntil: validUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "OUTPUT",
			provider: "test",
			ruleVersion: "pr5-query-rule",
			policyVersion: "pr5-query-policy",
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil,
		},
	});
	return client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
}

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target the disposable PR 5 database");
	}
	return value;
}

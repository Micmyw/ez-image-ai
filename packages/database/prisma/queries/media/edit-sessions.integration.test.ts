import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEXT_RULE_VERSION = "pr5-text-rule-v1";
const ASSET_RULE_VERSION = "pr5-asset-rule-v1";
const ASSET_POLICY_VERSION = "pr5-asset-policy-v1";

describe("image edit session PostgreSQL transaction", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("commits the root session with the existing job transaction and rolls it all back on failure", async () => {
		const successful = await createRootFixture(client, { credits: 20n });
		const created = await createRootEdit(client, successful);
		const sessions = await client.imageEditSession.findMany({
			where: { ownerType: "USER", ownerId: successful.ownerId },
		});
		const storedJob = await client.generationJob.findUnique({
			where: { id: created.job.id },
			include: { assets: true, reservation: true },
		});
		const outboxCount = await client.outboxEvent.count({
			where: { aggregateType: "GENERATION_JOB", aggregateId: created.job.id },
		});

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			ownerType: "USER",
			ownerId: successful.ownerId,
			rootAssetId: successful.assetId,
			title: null,
		});
		expect(storedJob).toMatchObject({
			editSessionId: sessions[0]?.id,
			parentJobId: null,
			reservation: { status: "ACTIVE", amount: 4n },
			assets: [{ assetId: successful.assetId, role: "INPUT", position: 0 }],
		});
		expect(outboxCount).toBe(1);

		const insufficient = await createRootFixture(client, { credits: 0n });
		const outboxBeforeFailure = await client.outboxEvent.count();
		const ledgerBeforeFailure = await client.creditLedgerEntry.count();
		await expect(createRootEdit(client, insufficient)).rejects.toThrow(/credit/i);
		expect(
			await client.imageEditSession.count({
				where: { ownerType: "USER", ownerId: insufficient.ownerId },
			}),
		).toBe(0);
		expect(
			await client.generationJob.count({
				where: { ownerType: "USER", ownerId: insufficient.ownerId },
			}),
		).toBe(0);
		expect(await client.outboxEvent.count()).toBe(outboxBeforeFailure);
		expect(await client.creditLedgerEntry.count()).toBe(ledgerBeforeFailure);
	});

	it("hides a foreign root and distinguishes an owned asset that is not ready", async () => {
		const caller = await createRootFixture(client, { credits: 20n });
		const foreign = await createReadyImageAsset(client, `foreign-${crypto.randomUUID()}`, "INPUT");
		const foreignQuote = await createApprovedQuote(client, caller.ownerId, foreign.id);

		await expect(
			createRootEdit(client, {
				...caller,
				assetId: foreign.id,
				quoteId: foreignQuote.id,
				idempotencyKey: `foreign-root-${crypto.randomUUID()}`,
			}),
		).rejects.toThrow("NOT_FOUND");

		const notReadyAsset = await createReadyImageAsset(client, caller.ownerId, "INPUT");
		await client.mediaAsset.update({
			where: { id: notReadyAsset.id },
			data: { status: "VERIFYING" },
		});
		const notReadyQuote = await createApprovedQuote(client, caller.ownerId, notReadyAsset.id);

		await expect(
			createRootEdit(client, {
				...caller,
				assetId: notReadyAsset.id,
				quoteId: notReadyQuote.id,
				idempotencyKey: `not-ready-root-${crypto.randomUUID()}`,
			}),
		).rejects.toThrow("ASSET_NOT_READY");
	});

	it("replays one root confirmation without creating a second session or job", async () => {
		const fixture = await createRootFixture(client, { credits: 20n });
		const first = await createRootEdit(client, fixture);
		const replay = await createRootEdit(client, fixture);

		expect(replay).toMatchObject({
			replayed: true,
			job: { id: first.job.id },
		});
		expect(await client.imageEditSession.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
	});

	it("retries a failed root as another root version in the existing session", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const original = await createRootEdit(client, fixture);
		await client.generationJob.update({
			where: { id: original.job.id },
			data: { status: "FAILED", terminalAt: new Date() },
		});
		const session = await client.imageEditSession.findFirstOrThrow({
			where: { ownerType: "USER", ownerId: fixture.ownerId },
		});
		const quote = await createApprovedQuote(
			client,
			fixture.ownerId,
			fixture.assetId,
			"retry the failed root",
			{
				kind: "ROOT_RETRY",
				editSessionId: session.id,
				rootAssetId: fixture.assetId,
			},
		);
		const retryInput = {
			ownerType: "USER" as const,
			ownerId: fixture.ownerId,
			submittedByUserId: fixture.ownerId,
			quoteId: quote.id,
			idempotencyKey: `pr5-root-retry-${crypto.randomUUID()}`,
			inputAssetIds: [fixture.assetId],
			expectedModerationRuleVersion: TEXT_RULE_VERSION,
			expectedAssetModerationRuleVersion: ASSET_RULE_VERSION,
			expectedAssetModerationPolicyVersion: ASSET_POLICY_VERSION,
			edit: {
				kind: "ROOT_RETRY" as const,
				editSessionId: session.id,
				rootAssetId: fixture.assetId,
			},
		};

		const retried = await createGenerationJobTransaction(retryInput as never, client);
		const replay = await createGenerationJobTransaction(retryInput as never, client);
		const stored = await client.generationJob.findUniqueOrThrow({
			where: { id: retried.job.id },
			include: { reservation: true },
		});

		expect(replay).toMatchObject({ replayed: true, job: { id: retried.job.id } });
		expect(stored).toMatchObject({
			editSessionId: session.id,
			parentJobId: null,
			reservation: { status: "ACTIVE", amount: 4n },
		});
		expect(stored.inputSnapshot).toEqual({
			kind: "image-to-image",
			prompt: "retry the failed root",
			sourceAssetId: fixture.assetId,
		});
		expect(await client.imageEditSession.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: fixture.ownerId } })).toBe(2);
		expect(
			await client.outboxEvent.count({
				where: { aggregateType: "GENERATION_JOB", aggregateId: retried.job.id },
			}),
		).toBe(1);
	});

	it("normalizes concurrent root confirmation replay to one session and one job", async () => {
		const fixture = await createRootFixture(client, { credits: 20n });
		const results = await Promise.all([
			createRootEdit(client, fixture),
			createRootEdit(client, fixture),
		]);

		expect(new Set(results.map(({ job }) => job.id))).toHaveProperty("size", 1);
		expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
		expect(await client.imageEditSession.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
	});

	it("keeps three rounds and an older-version branch in one audited session", async () => {
		const rootFixture = await createRootFixture(client, { credits: 100n });
		const root = await createRootEdit(client, rootFixture);
		const rootOutput = await completeWithApprovedOutput(client, root.job.id, rootFixture.ownerId);
		const rootSession = await client.imageEditSession.findFirstOrThrow({
			where: { ownerId: rootFixture.ownerId },
		});
		await client.imageEditSession.update({
			where: { id: rootSession.id },
			data: { updatedAt: new Date("2020-01-01T00:00:00.000Z") },
		});

		const childOne = await createChildFixture(client, {
			ownerId: rootFixture.ownerId,
			parentJobId: root.job.id,
			sourceAssetId: rootOutput.id,
			prompt: "second version prompt",
		});
		const createdChildOne = await createChildEdit(client, childOne);
		const childOneOutput = await completeWithApprovedOutput(
			client,
			createdChildOne.job.id,
			rootFixture.ownerId,
		);
		const childTwo = await createChildFixture(client, {
			ownerId: rootFixture.ownerId,
			parentJobId: createdChildOne.job.id,
			sourceAssetId: childOneOutput.id,
			prompt: "third version prompt",
		});
		const createdChildTwo = await createChildEdit(client, childTwo);

		const branch = await createChildFixture(client, {
			ownerId: rootFixture.ownerId,
			parentJobId: root.job.id,
			sourceAssetId: rootOutput.id,
			prompt: "branch from the first result",
		});
		const createdBranch = await createChildEdit(client, branch);
		const jobIds = [
			root.job.id,
			createdChildOne.job.id,
			createdChildTwo.job.id,
			createdBranch.job.id,
		];
		const session = await client.imageEditSession.findUniqueOrThrow({
			where: { id: rootSession.id },
			include: {
				jobs: {
					where: { id: { in: jobIds } },
					include: { assets: true, reservation: true },
				},
			},
		});
		const byId = new Map(session.jobs.map((job) => [job.id, job]));

		expect(session.updatedAt.getTime()).toBeGreaterThan(
			new Date("2020-01-01T00:00:00.000Z").getTime(),
		);
		expect(session.jobs).toHaveLength(4);
		expect(byId.get(root.job.id)).toMatchObject({
			editSessionId: session.id,
			parentJobId: null,
		});
		expect(byId.get(createdChildOne.job.id)).toMatchObject({
			editSessionId: session.id,
			parentJobId: root.job.id,
			assets: expect.arrayContaining([
				expect.objectContaining({ role: "INPUT", assetId: rootOutput.id }),
			]),
		});
		expect(byId.get(createdChildTwo.job.id)).toMatchObject({
			editSessionId: session.id,
			parentJobId: createdChildOne.job.id,
			assets: expect.arrayContaining([
				expect.objectContaining({ role: "INPUT", assetId: childOneOutput.id }),
			]),
		});
		expect(byId.get(createdBranch.job.id)).toMatchObject({
			editSessionId: session.id,
			parentJobId: root.job.id,
			assets: expect.arrayContaining([
				expect.objectContaining({ role: "INPUT", assetId: rootOutput.id }),
			]),
		});
		expect(new Set(session.jobs.map(({ quoteId }) => quoteId))).toHaveProperty("size", 4);
		expect(new Set(session.jobs.map(({ idempotencyKey }) => idempotencyKey))).toHaveProperty(
			"size",
			4,
		);
		expect(session.jobs.every(({ reservation }) => reservation?.status === "ACTIVE")).toBe(true);
		expect(
			await client.outboxEvent.count({
				where: { aggregateType: "GENERATION_JOB", aggregateId: { in: jobIds } },
			}),
		).toBe(4);
	});

	it("normalizes concurrent child confirmation replay without duplicating a version", async () => {
		const rootFixture = await createRootFixture(client, { credits: 40n });
		const root = await createRootEdit(client, rootFixture);
		const rootOutput = await completeWithApprovedOutput(client, root.job.id, rootFixture.ownerId);
		const child = await createChildFixture(client, {
			ownerId: rootFixture.ownerId,
			parentJobId: root.job.id,
			sourceAssetId: rootOutput.id,
			prompt: "one child confirmation",
		});

		const results = await Promise.all([
			createChildEdit(client, child),
			createChildEdit(client, child),
		]);
		const session = await client.imageEditSession.findFirstOrThrow({
			where: { ownerId: rootFixture.ownerId },
			include: { jobs: true },
		});

		expect(new Set(results.map(({ job }) => job.id))).toHaveProperty("size", 1);
		expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
		expect(session.jobs).toHaveLength(2);
		expect(session.jobs.filter(({ parentJobId }) => parentJobId === root.job.id)).toHaveLength(1);
	});

	it("rejects a child session binding that differs from the quote-frozen context", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await completeWithApprovedOutput(client, parent.job.id, fixture.ownerId);
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt: "keep the quoted session binding",
		});

		await expect(
			createChildEdit(client, {
				...child,
				editSessionId: `session-replaced-${crypto.randomUUID()}`,
			}),
		).rejects.toThrow("NOT_FOUND");
		expect(await client.generationJob.count({ where: { ownerId: fixture.ownerId } })).toBe(1);
	});

	it("keeps frozen edit metadata private to the quote instead of the provider job input", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await completeWithApprovedOutput(client, parent.job.id, fixture.ownerId);
		const prompt = "do not expose the server edit context";
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt,
		});
		const created = await createChildEdit(client, child);
		const [quote, job] = await Promise.all([
			client.generationQuote.findUniqueOrThrow({ where: { id: child.quoteId } }),
			client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } }),
		]);

		expect(quote.inputSnapshot).toMatchObject({
			editContext: {
				kind: "CHILD",
				parentJobId: parent.job.id,
				editSessionId: child.editSessionId,
				sourceAssetId: output.id,
			},
		});
		expect(job.inputSnapshot).toEqual({
			kind: "image-to-image",
			prompt,
			sourceAssetId: output.id,
		});
	});

	it("rejects a failed parent even when it still has an approved output", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await completeWithApprovedOutput(client, parent.job.id, fixture.ownerId);
		await client.generationJob.update({
			where: { id: parent.job.id },
			data: { status: "FAILED" },
		});
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt: "must not edit a failed version",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});

	it("rejects a parent that does not own the selected output binding", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		await client.generationJob.update({
			where: { id: parent.job.id },
			data: { status: "SUCCEEDED", terminalAt: new Date() },
		});
		const unrelated = await createReadyImageAsset(client, fixture.ownerId, "OUTPUT");
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: unrelated.id,
			prompt: "must use the selected parent output",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});

	it("rejects a parent output whose latest moderation result is not approved", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await createRejectedImageAsset(client, fixture.ownerId);
		await bindOutputToJob(client, parent.job.id, output.id, output.checksum!);
		await client.generationJob.update({
			where: { id: parent.job.id },
			data: { status: "SUCCEEDED", terminalAt: new Date() },
		});
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt: "must not reuse an unapproved output",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});

	it("rejects a deleted parent output with a non-disclosing error", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await completeWithApprovedOutput(client, parent.job.id, fixture.ownerId);
		await client.mediaAsset.update({
			where: { id: output.id },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt: "must not reuse a deleted output",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});

	it("rejects a non-image output from public edit-session flow", async () => {
		const fixture = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, fixture);
		const output = await createReadyImageAsset(client, fixture.ownerId, "OUTPUT", "video/mp4");
		await bindOutputToJob(client, parent.job.id, output.id, output.checksum!);
		await client.generationJob.update({
			where: { id: parent.job.id },
			data: { status: "SUCCEEDED", terminalAt: new Date() },
		});
		const child = await createChildFixture(client, {
			ownerId: fixture.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: output.id,
			prompt: "must remain image-only",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});

	it("does not let one user attach a child to another user's session", async () => {
		const owner = await createRootFixture(client, { credits: 40n });
		const parent = await createRootEdit(client, owner);
		await completeWithApprovedOutput(client, parent.job.id, owner.ownerId);
		const attacker = await createRootFixture(client, { credits: 40n });
		const child = await createChildFixture(client, {
			ownerId: attacker.ownerId,
			parentJobId: parent.job.id,
			sourceAssetId: attacker.assetId,
			prompt: "must not cross tenant boundaries",
		});

		await expect(createChildEdit(client, child)).rejects.toThrow("NOT_FOUND");
	});
});

interface RootFixture {
	ownerId: string;
	assetId: string;
	quoteId: string;
	idempotencyKey: string;
}

interface ChildFixture {
	ownerId: string;
	parentJobId: string;
	editSessionId: string;
	sourceAssetId: string;
	quoteId: string;
	idempotencyKey: string;
}

async function createRootFixture(
	client: PrismaClient,
	input: { credits: bigint },
): Promise<RootFixture> {
	const suffix = crypto.randomUUID();
	const ownerId = `pr5-root-${suffix}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	if (input.credits > 0n) {
		await createCreditGrant(
			{
				accountId: account.id,
				amount: input.credits,
				referenceKey: `pr5-root-grant-${suffix}`,
			},
			client,
		);
	}
	const asset = await createReadyImageAsset(client, ownerId, "INPUT");
	const quote = await createApprovedQuote(client, ownerId, asset.id);
	return {
		ownerId,
		assetId: asset.id,
		quoteId: quote.id,
		idempotencyKey: `pr5-root-confirm-${suffix}`,
	};
}

async function createRootEdit(client: PrismaClient, fixture: RootFixture) {
	return createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId: fixture.ownerId,
			submittedByUserId: fixture.ownerId,
			quoteId: fixture.quoteId,
			idempotencyKey: fixture.idempotencyKey,
			inputAssetIds: [fixture.assetId],
			expectedModerationRuleVersion: TEXT_RULE_VERSION,
			expectedAssetModerationRuleVersion: ASSET_RULE_VERSION,
			expectedAssetModerationPolicyVersion: ASSET_POLICY_VERSION,
			edit: { kind: "ROOT", rootAssetId: fixture.assetId },
		} as Parameters<typeof createGenerationJobTransaction>[0],
		client,
	);
}

async function createChildFixture(
	client: PrismaClient,
	input: { ownerId: string; parentJobId: string; sourceAssetId: string; prompt: string },
): Promise<ChildFixture> {
	const parent = await client.generationJob.findUniqueOrThrow({
		where: { id: input.parentJobId },
		select: { editSessionId: true },
	});
	if (!parent.editSessionId) throw new Error("Test parent has no edit session");
	const quote = await createApprovedQuote(
		client,
		input.ownerId,
		input.sourceAssetId,
		input.prompt,
		{
			kind: "CHILD",
			parentJobId: input.parentJobId,
			editSessionId: parent.editSessionId,
			sourceAssetId: input.sourceAssetId,
		},
	);
	return {
		...input,
		editSessionId: parent.editSessionId,
		quoteId: quote.id,
		idempotencyKey: `pr5-child-confirm-${crypto.randomUUID()}`,
	};
}

async function createChildEdit(client: PrismaClient, fixture: ChildFixture) {
	return createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId: fixture.ownerId,
			submittedByUserId: fixture.ownerId,
			quoteId: fixture.quoteId,
			idempotencyKey: fixture.idempotencyKey,
			inputAssetIds: [fixture.sourceAssetId],
			expectedModerationRuleVersion: TEXT_RULE_VERSION,
			expectedAssetModerationRuleVersion: ASSET_RULE_VERSION,
			expectedAssetModerationPolicyVersion: ASSET_POLICY_VERSION,
			edit: {
				kind: "CHILD",
				parentJobId: fixture.parentJobId,
				editSessionId: fixture.editSessionId,
				sourceAssetId: fixture.sourceAssetId,
			},
		} as Parameters<typeof createGenerationJobTransaction>[0],
		client,
	);
}

async function completeWithApprovedOutput(client: PrismaClient, jobId: string, ownerId: string) {
	const output = await createReadyImageAsset(client, ownerId, "OUTPUT");
	await bindOutputToJob(client, jobId, output.id, output.checksum!);
	await client.generationJob.update({
		where: { id: jobId },
		data: { status: "SUCCEEDED", terminalAt: new Date() },
	});
	return output;
}

async function createApprovedQuote(
	client: PrismaClient,
	ownerId: string,
	sourceAssetId: string,
	prompt = `edit ${crypto.randomUUID()}`,
	editContext?:
		| {
				kind: "CHILD";
				parentJobId: string;
				editSessionId: string;
				sourceAssetId: string;
		  }
		| {
				kind: "ROOT_RETRY";
				editSessionId: string;
				rootAssetId: string;
		  },
) {
	const input = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "pr5-catalog-v1",
		pricingVersion: "pr5-pricing-v1",
		credits: 4n,
		costMicros: 0n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt,
			sourceAssetId,
			...(editContext ? { editContext } : {}),
		},
		pricingSnapshot: {},
		expiresAt: new Date(Date.now() + 60 * 60_000),
	};
	return createModeratedGenerationQuoteTransaction(
		{
			...input,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: TEXT_RULE_VERSION,
				reasonCode: "TEST_ALLOW",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(input),
			},
		},
		client,
	);
}

async function createReadyImageAsset(
	client: PrismaClient,
	ownerId: string,
	kind: "INPUT" | "OUTPUT",
	mimeType = "image/png",
) {
	const suffix = crypto.randomUUID();
	const checksum = suffix.replaceAll("-", "").repeat(2);
	const validUntil = new Date(Date.now() + 60 * 60_000);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind,
			status: "VERIFYING",
			objectKey: `users/${ownerId}/pr5/${suffix}`,
			mimeType,
			byteSize: 128n,
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: ASSET_RULE_VERSION,
			verificationPolicyVersion: ASSET_POLICY_VERSION,
			verificationValidUntil: validUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: kind,
			provider: "test",
			ruleVersion: ASSET_RULE_VERSION,
			policyVersion: ASSET_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil,
		},
	});
	return client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
}

async function createRejectedImageAsset(client: PrismaClient, ownerId: string) {
	const suffix = crypto.randomUUID();
	const checksum = suffix.replaceAll("-", "").repeat(2);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/pr5/rejected-${suffix}`,
			mimeType: "image/png",
			byteSize: 128n,
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: ASSET_RULE_VERSION,
			verificationPolicyVersion: ASSET_POLICY_VERSION,
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
			ruleVersion: ASSET_RULE_VERSION,
			policyVersion: ASSET_POLICY_VERSION,
			status: "REJECTED",
			reasonCode: "TEST_REJECT",
			categories: {},
			rawEnvelope: {},
		},
	});
	return client.mediaAsset.update({
		where: { id: asset.id },
		data: { status: "QUARANTINED" },
	});
}

async function bindOutputToJob(
	client: PrismaClient,
	jobId: string,
	assetId: string,
	assetChecksum: string,
) {
	await client.generationJobAsset.create({
		data: { jobId, assetId, assetChecksum, role: "OUTPUT", position: 0 },
	});
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

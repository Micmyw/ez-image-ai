import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { getAdminPromptContent, listAdminPromptContent } from "./admin-prompt-content";

/** Shared local database: own exact fixture identities only, never truncate or reset it. */
const prefix = `admin-prompt-${crypto.randomUUID()}`;
const adminId = `${prefix}-admin`;
const ownerId = `${prefix}-owner`;
const email = `${prefix}@example.test`;
const at = new Date("2026-11-14T00:00:00.000Z");
const from = new Date(at.getTime() - 1000);
const to = new Date(at.getTime() + 1000);
const accountJobId = `${prefix}-job-a`;
const guestJobId = `${prefix}-job-b`;
// A cross-table ID collision checks that the cursor also contains the record kind.
const blockedId = accountJobId;
const successfulJobId = `${prefix}-job-c`;
const jobIds = [accountJobId, guestJobId, successfulJobId];
const quoteIds = jobIds.map((id) => `${id}-quote`);
const attemptId = `${prefix}-attempt`;
const taskId = `${prefix}-task`;
const allowedAuditId = `${prefix}-allowed`;
const unrelatedAuditId = `${prefix}-unrelated`;

function safeLocalDatabase(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	if (value === process.env.DATABASE_URL)
		throw new Error("TEST_DATABASE_URL must be separate from DATABASE_URL");
	const parsed = new URL(value);
	if (
		!["postgresql:", "postgres:"].includes(parsed.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		!/^\/[a-z0-9_-]*test[a-z0-9_-]*$/i.test(parsed.pathname)
	)
		throw new Error("TEST_DATABASE_URL must target a loopback database whose name contains test");
	return value;
}

describe("asset-independent administrator prompt SQL", () => {
	let client: PrismaClient;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: safeLocalDatabase(process.env.TEST_DATABASE_URL),
			}),
		});
		await client.user.createMany({
			data: [adminId, ownerId].map((id) => ({
				id,
				name: "Administrator prompt test",
				email: id === ownerId ? email : `${id}@example.test`,
				emailVerified: false,
				isAnonymous: false,
				role: id === adminId ? "admin" : "user",
				createdAt: at,
				updatedAt: at,
			})),
		});
		for (const [index, id] of jobIds.entries()) {
			const inputSnapshot = {
				kind: "text-to-image",
				prompt:
					index === 0
						? "A red balloon 100%_ literal https://private.example/source?token=secret"
						: `Saved prompt ${index}`,
			};
			await client.generationQuote.create({
				data: {
					id: quoteIds[index],
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: "image-minimax-h3",
					catalogVersion: "admin-prompt-test",
					pricingVersion: "admin-prompt-test",
					credits: 5n,
					costMicros: 0n,
					inputSnapshot,
					pricingSnapshot: {},
					createdAt: at,
					expiresAt: new Date(at.getTime() + 60_000),
				},
			});
			await client.generationJob.create({
				data: {
					id,
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quoteIds[index]!,
					idempotencyKey: id,
					productKey: "image-minimax-h3",
					catalogVersion: "admin-prompt-test",
					pricingVersion: "admin-prompt-test",
					creditsReserved: 5n,
					inputSnapshot,
					pricingSnapshot: {},
					status: index === 2 ? "SUCCEEDED" : "FAILED",
					serviceClass: index === 1 ? "GUEST_SLOW" : "STANDARD",
					failureCode: index === 2 ? null : "PROVIDER_FAILED",
					createdAt: at,
				},
			});
		}
		await client.generationAttempt.create({
			data: {
				id: attemptId,
				jobId: accountJobId,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "test-model",
				providerTaskId: taskId,
				status: "FAILED",
				requestSnapshot: {},
				responseSnapshot: { rawPrivate: "do-not-return" },
				errorSnapshot: {
					code: "PROVIDER_TEMPORARY",
					providerDiagnostic: {
						version: 1,
						attemptId,
						provider: "kie",
						providerTaskId: taskId,
						source: "CALLBACK_DIAGNOSTIC",
						observedAt: at.toISOString(),
						message: "Model timeout https://private.example/task?signature=secret",
					},
				},
				createdAt: at,
			},
		});
		await client.auditLog.createMany({
			data: [
				{
					id: allowedAuditId,
					actorUserId: ownerId,
					action: "MEDIA_TEXT_MODERATION_ALLOWED",
					targetType: "GENERATION_QUOTE",
					targetId: quoteIds[0]!,
					metadata: {},
					after: {
						provider: "waffo",
						decision: "ALLOW",
						ruleVersion: "waffo-test",
						evidence: {
							waffo: {
								action: "allow",
								semanticStatus: "scored",
								matchedCategories: [],
								requestId: "request-own",
							},
						},
					},
					createdAt: at,
				},
				{
					id: unrelatedAuditId,
					actorUserId: ownerId,
					action: "MEDIA_TEXT_MODERATION_ALLOWED",
					targetType: "GENERATION_QUOTE",
					targetId: quoteIds[1]!,
					metadata: {},
					after: {
						provider: "waffo",
						decision: "ALLOW",
						evidence: { waffo: { requestId: "request-unrelated" } },
					},
					createdAt: at,
				},
				{
					id: blockedId,
					actorUserId: ownerId,
					action: "MEDIA_TEXT_MODERATION_BLOCKED",
					targetType: "GENERATION_QUOTE_REQUEST",
					targetId: `${prefix}-fingerprint`,
					metadata: {
						audience: "GUEST",
						sourceAssetId: null,
						prompt: "Saved blocked request",
						productKey: "image-minimax-h3",
					},
					after: {
						provider: "waffo",
						decision: "REJECT",
						reasonCode: "WAFFO_RESTRICTED_CONTENT",
						ruleVersion: "waffo-test",
						evidence: {
							waffo: {
								action: "block",
								semanticStatus: "scored",
								matchedCategories: ["adult_nsfw"],
							},
						},
					},
					createdAt: at,
				},
			],
		});
	});

	afterAll(async () => {
		if (!client) return;
		try {
			await client.generationAttempt.deleteMany({ where: { id: attemptId } });
			await client.generationJob.deleteMany({ where: { id: { in: jobIds } } });
			await client.generationQuote.deleteMany({ where: { id: { in: quoteIds } } });
			await client.auditLog.deleteMany({
				where: {
					OR: [
						{ id: { in: [allowedAuditId, unrelatedAuditId, blockedId] } },
						{ actorUserId: adminId },
					],
				},
			});
			await client.user.deleteMany({ where: { id: { in: [adminId, ownerId] } } });
			expect(await client.generationJob.count({ where: { id: { in: jobIds } } })).toBe(0);
			expect(await client.generationQuote.count({ where: { id: { in: quoteIds } } })).toBe(0);
			expect(
				await client.auditLog.count({
					where: {
						OR: [
							{ id: { in: [allowedAuditId, unrelatedAuditId, blockedId] } },
							{ actorUserId: adminId },
						],
					},
				}),
			).toBe(0);
			expect(await client.user.count({ where: { id: { in: [adminId, ownerId] } } })).toBe(0);
		} finally {
			await client.$disconnect();
		}
	});

	it("paginates no-asset failures and source-free blocked requests at the same timestamp", async () => {
		expect(await client.generationJobAsset.count({ where: { jobId: { in: jobIds } } })).toBe(0);
		const first = await listAdminPromptContent({ limit: 1, ownerId, from, to }, adminId, client);
		expect(first.items.map((row) => [row.recordKind, row.id])).toEqual([["JOB", guestJobId]]);
		const second = await listAdminPromptContent(
			{ limit: 1, ownerId, from, to, before: first.nextCursor! },
			adminId,
			client,
		);
		expect(second.items.map((row) => [row.recordKind, row.id])).toEqual([["JOB", accountJobId]]);
		const third = await listAdminPromptContent(
			{ limit: 1, ownerId, from, to, before: second.nextCursor! },
			adminId,
			client,
		);
		expect(third.items.map((row) => [row.recordKind, row.id])).toEqual([
			["BLOCKED_REQUEST", blockedId],
		]);
		expect(third.nextCursor).toBeNull();
		expect(JSON.stringify([...first.items, ...second.items, ...third.items])).not.toMatch(
			/A red balloon|Saved blocked request/,
		);
	});

	it("applies audience, account, job, literal text, outcome and time filters in PostgreSQL", async () => {
		const search = (filters = {}) =>
			listAdminPromptContent({ limit: 25, ownerId, from, to, ...filters }, adminId, client);
		expect((await search({ audience: "GUEST" })).items.map((row) => row.recordKind)).toEqual([
			"JOB",
			"BLOCKED_REQUEST",
		]);
		expect((await search({ audience: "ACCOUNT" })).items.map((row) => row.id)).toEqual([
			accountJobId,
		]);
		expect((await search({ email: email.toUpperCase() })).items).toHaveLength(3);
		expect((await search({ jobId: accountJobId })).items.map((row) => row.id)).toEqual([
			accountJobId,
		]);
		expect((await search({ text: "100%_" })).items.map((row) => row.id)).toEqual([accountJobId]);
		expect((await search({ text: "%' OR 1=1 --" })).items).toHaveLength(0);
		expect((await search({ outcome: "ALL" })).items).toHaveLength(4);
		expect((await search({ from: new Date(at.getTime() + 1) })).items).toHaveLength(0);
	});

	it("returns saved prompt and matching quote evidence without inventing provider authentication", async () => {
		const job = await getAdminPromptContent(
			{ recordKind: "JOB", id: accountJobId },
			adminId,
			client,
		);
		expect(job.prompt).toBe("A red balloon 100%_ literal [redacted URL]");
		expect(job.promptReviews.map((review) => review.id)).toEqual([allowedAuditId]);
		expect(job.promptReviews[0]).toMatchObject({
			requestId: "request-own",
			evidenceSource: "PERSISTED_AUDIT",
		});
		expect(job.attempts).toMatchObject([
			{
				errorMessage: "Model timeout [redacted URL]",
				messageSource: "CALLBACK_DIAGNOSTIC",
				terminalStatus: null,
				verifiedAt: null,
				evidenceSource: "STORED_DIAGNOSTIC",
			},
		]);
		const blocked = await getAdminPromptContent(
			{ recordKind: "BLOCKED_REQUEST", id: blockedId },
			adminId,
			client,
		);
		expect(blocked).toMatchObject({
			audience: "GUEST",
			audienceBasis: "RECORDED",
			prompt: "Saved blocked request",
			jobId: null,
			attempts: [],
			promptReviews: [{ action: "block", categories: ["adult_nsfw"] }],
		});
		expect(JSON.stringify(job)).not.toMatch(
			/private\.example|rawPrivate|do-not-return|request-unrelated/,
		);
	});

	it("audits successful private reads without duplicating prompt fragments or email filters", async () => {
		await listAdminPromptContent(
			{ limit: 1, from, to, ownerId, email, text: "balloon" },
			adminId,
			client,
		);
		const audits = await client.auditLog.findMany({ where: { actorUserId: adminId } });
		expect(audits.some((row) => row.action === "MEDIA_CUSTOMER_PROMPTS_LISTED")).toBe(true);
		expect(audits.some((row) => row.action === "MEDIA_CUSTOMER_PROMPT_VIEWED")).toBe(true);
		expect(JSON.stringify(audits.map((row) => row.metadata))).not.toContain(email);
		expect(JSON.stringify(audits.map((row) => row.metadata))).not.toContain("balloon");
	});
});

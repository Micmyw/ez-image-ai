import { describe, expect, it, vi } from "vitest";

import {
	buildAdminPromptContentQuery,
	getAdminPromptContent,
	listAdminPromptContent,
} from "./admin-prompt-content";
import type { MediaDatabaseClient } from "./types";

const at = new Date("2026-11-14T00:00:00Z");
function fixture() {
	const mocks = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		generationJob: { findUnique: vi.fn().mockResolvedValue(null) },
		user: {
			findUnique: vi.fn().mockResolvedValue({ email: "customer@example.test", isAnonymous: false }),
		},
		auditLog: {
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockResolvedValue([]),
			create: vi.fn().mockResolvedValue({}),
		},
	};
	return { mocks, client: mocks as unknown as MediaDatabaseClient };
}
const job = () => ({
	id: "job-no-assets",
	ownerType: "USER",
	ownerId: "customer",
	submittedByUserId: "customer",
	productKey: "image-minimax-h3",
	status: "FAILED",
	failureCode: "PROVIDER_FAILED",
	failureMessage: "Timeout at https://private.test/?signature=secret",
	inputSnapshot: {
		prompt: "A red balloon https://private.test/original?token=secret",
		unrelated: "never-return",
	},
	quoteId: "own-quote",
	createdAt: at,
	serviceClass: "STANDARD",
	guestTrialId: null,
	attempts: [],
});

describe("asset-independent administrator prompt content", () => {
	it("finds text-only failed jobs and scopes Waffo audits to the exact persisted quote", async () => {
		const { mocks, client } = fixture();
		mocks.generationJob.findUnique.mockResolvedValue(job());
		mocks.auditLog.findMany.mockResolvedValue([
			{
				id: "waffo-audit",
				createdAt: at,
				after: {
					provider: "waffo",
					decision: "ALLOW",
					reasonCode: "WAFFO_PROMPT_ALLOWED",
					ruleVersion: "text-rule-v1",
					evidence: {
						waffo: {
							action: "allow",
							semanticStatus: "scored",
							matchedCategories: [],
							requestId: "waffo-id",
						},
						secret: "never-return",
					},
				},
			},
		]);
		const data = await getAdminPromptContent(
			{ recordKind: "JOB", id: "job-no-assets" },
			"admin",
			client,
		);
		expect(data).toMatchObject({
			audience: "ACCOUNT",
			audienceBasis: "JOB_RECORD",
			jobId: "job-no-assets",
			promptSource: "JOB_INPUT_SNAPSHOT",
			prompt: "A red balloon [redacted URL]",
			attempts: [],
			promptReviews: [
				{
					id: "waffo-audit",
					provider: "waffo",
					requestId: "waffo-id",
					evidenceSource: "PERSISTED_AUDIT",
				},
			],
		});
		expect(mocks.auditLog.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					action: "MEDIA_TEXT_MODERATION_ALLOWED",
					targetType: "GENERATION_QUOTE",
					targetId: "own-quote",
				},
				take: 20,
			}),
		);
		expect(mocks.auditLog.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					actorUserId: "admin",
					action: "MEDIA_CUSTOMER_PROMPT_VIEWED",
				}),
			}),
		);
		expect(JSON.stringify(data)).not.toMatch(
			/private\.test|never-return|inputSnapshot|responseSnapshot/,
		);
	});
	it("shows a source-free Waffo rejection and preserves recorded guest provenance after account promotion", async () => {
		const { mocks, client } = fixture();
		mocks.auditLog.findFirst.mockResolvedValue({
			id: "blocked",
			actorUserId: "customer",
			createdAt: at,
			metadata: {
				schemaVersion: 1,
				prompt: "User's saved text",
				productKey: "image-minimax-h3",
				sourceAssetId: null,
				audience: "GUEST",
			},
			after: {
				provider: "waffo",
				decision: "REJECT",
				reasonCode: "WAFFO_RESTRICTED_CONTENT",
				evidence: {
					waffo: { action: "block", semanticStatus: "scored", matchedCategories: ["adult_nsfw"] },
				},
			},
		});
		const data = await getAdminPromptContent(
			{ recordKind: "BLOCKED_REQUEST", id: "blocked" },
			"admin",
			client,
		);
		expect(data).toMatchObject({
			audience: "GUEST",
			audienceBasis: "RECORDED",
			jobId: null,
			prompt: "User's saved text",
			promptReviews: [{ decision: "REJECT", categories: ["adult_nsfw"] }],
			attempts: [],
		});
		expect(mocks.generationJob.findUnique).not.toHaveBeenCalled();
		expect(mocks.auditLog.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "blocked",
					action: "MEDIA_TEXT_MODERATION_BLOCKED",
					targetType: "GENERATION_QUOTE_REQUEST",
				},
			}),
		);
	});
	it("keeps missing prompt, actor and historical messages unknown instead of reconstructing them", async () => {
		const { mocks, client } = fixture();
		mocks.auditLog.findFirst.mockResolvedValue({
			id: "old",
			actorUserId: null,
			createdAt: at,
			metadata: {},
			after: null,
		});
		expect(
			await getAdminPromptContent({ recordKind: "BLOCKED_REQUEST", id: "old" }, "admin", client),
		).toMatchObject({
			audience: "UNKNOWN",
			audienceBasis: "UNKNOWN",
			ownerId: null,
			accountEmail: null,
			prompt: null,
			promptReviews: [],
			attempts: [],
		});
		expect(mocks.user.findUnique).not.toHaveBeenCalled();
	});
	it("keeps list filters parameterized and never copies prompt fragments or emails into read audits", async () => {
		const { mocks, client } = fixture();
		const filter = {
			limit: 25,
			text: "100%_' OR 1=1 --",
			email: "customer@example.test",
			ownerId: "customer",
			from: at,
			to: new Date(at.getTime() + 1000),
		};
		const query = buildAdminPromptContentQuery(filter);
		expect(query.statement).not.toContain(filter.text);
		expect(query.parameters).toContain("%100\\%\\_' OR 1=1 --%");
		expect(query.statement).not.toContain("media_asset");
		await listAdminPromptContent(filter, "admin", client);
		const metadata = mocks.auditLog.create.mock.calls[0]![0].data.metadata;
		expect(metadata).toMatchObject({ textFilter: true, emailFilter: true });
		expect(JSON.stringify(metadata)).not.toMatch(/customer@example|100%|OR 1=1/);
	});
	it("does not return private content when read auditing fails and bounds time windows", async () => {
		const { mocks, client } = fixture();
		mocks.generationJob.findUnique.mockResolvedValue(job());
		mocks.auditLog.create.mockRejectedValue(new Error("audit unavailable"));
		await expect(
			getAdminPromptContent({ recordKind: "JOB", id: "job-no-assets" }, "admin", client),
		).rejects.toThrow("audit unavailable");
		expect(() =>
			buildAdminPromptContentQuery({
				limit: 50,
				from: at,
				to: new Date(at.getTime() + 91 * 24 * 60 * 60_000),
			}),
		).toThrow("ADMIN_PROMPT_RANGE_INVALID");
	});
});

import { describe, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => vi.fn());
vi.mock("./moderation-operations", () => ({ recordTextModerationOutcome: observation }));

import { recordBlockedPromptAttempt } from "./blocked-prompt";
import type { MediaTransactionClient } from "./types";

describe("blocked text prompt persistence", () => {
	it("stores only validated server-observed guest browser identity", async () => {
		const create = vi.fn();
		const client = {
			$transaction: async (work: (tx: unknown) => Promise<unknown>) =>
				work({ auditLog: { create } }),
		} as unknown as MediaTransactionClient;
		for (const audience of ["GUEST", "ACCOUNT"] as const) {
			await recordBlockedPromptAttempt(
				{
					decision: "REJECT",
					provider: "seeapi",
					ruleVersion: "v1",
					reasonCode: "BLOCKED",
					inputFingerprint: "fingerprint",
				},
				{
					userId: "owner",
					audience,
					browserSubjectHash: "a".repeat(64),
					prompt: "prompt",
					productKey: "model",
					sourceAssetId: "asset",
				},
				client,
			);
			const metadata = create.mock.calls.at(-1)?.[0].data.metadata;
			if (audience === "GUEST")
				expect(metadata).toMatchObject({
					guestBrowserIdentityVersion: 1,
					browserSubjectHash: "a".repeat(64),
				});
			else expect(metadata).not.toHaveProperty("browserSubjectHash");
		}
	});
	it.each([undefined, "GUEST", "ACCOUNT"] as const)(
		"records original text and actor with audience %s in the same transaction as the moderation outcome",
		async (audience) => {
			const create = vi.fn();
			const tx = { auditLog: { create } };
			const transaction = vi.fn(async (work) => work(tx));
			const client = { $transaction: transaction } as unknown as MediaTransactionClient;
			const moderation = {
				decision: "REJECT" as const,
				provider: "waffo",
				ruleVersion: "v1",
				reasonCode: "TEST_BLOCKED",
				inputFingerprint: "fingerprint",
			};
			const context = {
				userId: "owner",
				audience,
				prompt: "original private text",
				productKey: "model",
				sourceAssetId: "asset",
			};
			await recordBlockedPromptAttempt(moderation, context, client);
			expect(observation).toHaveBeenCalledWith(
				{ targetType: "TEXT_ATTEMPT", targetId: "fingerprint", moderation },
				tx,
			);
			expect(create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					actorUserId: "owner",
					after: moderation,
					metadata: {
						schemaVersion: 1,
						...(audience ? { audience } : {}),
						prompt: context.prompt,
						productKey: "model",
						sourceAssetId: "asset",
					},
				}),
			});
			expect(transaction).toHaveBeenCalledOnce();
		},
	);
});

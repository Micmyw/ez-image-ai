import { describe, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => vi.fn());
vi.mock("./moderation-operations", () => ({ recordTextModerationOutcome: observation }));

import { recordBlockedPromptAttempt } from "./blocked-prompt";
import type { MediaTransactionClient } from "./types";

describe("blocked text prompt persistence", () => {
	it("records original text and actor in the same transaction as the moderation outcome", async () => {
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
					prompt: context.prompt,
					productKey: "model",
					sourceAssetId: "asset",
				},
			}),
		});
		expect(transaction).toHaveBeenCalledOnce();
	});
});

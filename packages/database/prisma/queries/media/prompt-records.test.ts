import { describe, expect, it, vi } from "vitest";

import { getAssetPromptRecords, saveReferencePromptRecord } from "./prompt-records";
import type { MediaDatabaseClient } from "./types";

const input = {
	ownerId: "owner-a",
	assetId: "asset-a",
	productKey: "image-nano-banana-2-lite",
	prompt: "把背景换成森林",
	captureId: "capture-a",
};

function fixture(found = true) {
	const records = new Map<string, unknown>();
	const findFirst = vi.fn(async () => (found ? { id: input.assetId } : null));
	const upsert = vi.fn(async ({ create }) => {
		if (!records.has(create.id)) records.set(create.id, create);
		return records.get(create.id);
	});
	const client = {
		mediaAsset: { findFirst },
		auditLog: { upsert },
	} as unknown as MediaDatabaseClient;
	return { client, findFirst, upsert, records };
}

describe("private reference prompt capture", () => {
	it("stores a failed review's draft without requiring an approved asset or creating a job", async () => {
		const f = fixture();
		await saveReferencePromptRecord(input, f.client);
		expect(f.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: input.assetId,
					ownerType: "USER",
					ownerId: input.ownerId,
					deletedAt: null,
				}),
			}),
		);
		expect(f.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ status: { not: "DELETED" } }) }),
		);
		expect(f.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					actorUserId: input.ownerId,
					targetId: input.assetId,
					metadata: expect.objectContaining({ prompt: input.prompt, source: "REFERENCE_DRAFT" }),
				}),
				update: {},
			}),
		);
	});
	it("does not record missing, deleted or other-owner assets", async () => {
		const f = fixture(false);
		await expect(saveReferencePromptRecord(input, f.client)).rejects.toThrow("NOT_FOUND");
		expect(f.upsert).not.toHaveBeenCalled();
	});
	it("deduplicates an uncertain save and refuses changed content under the same capture ID", async () => {
		const f = fixture();
		const first = await saveReferencePromptRecord(input, f.client);
		expect(await saveReferencePromptRecord(input, f.client)).toEqual(first);
		await expect(
			saveReferencePromptRecord({ ...input, prompt: "changed" }, f.client),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(f.records.size).toBe(1);
	});
	it("keeps unsubmitted drafts and real job prompts separate", async () => {
		const client = {
			auditLog: {
				findMany: vi.fn(async () => [
					{
						id: "draft",
						createdAt: new Date("2026-11-13"),
						metadata: { source: "REFERENCE_DRAFT", prompt: "unsent", productKey: "model" },
					},
				]),
			},
			generationJobAsset: {
				findMany: vi.fn(async () => [
					{
						job: {
							id: "job",
							inputSnapshot: {
								prompt: "actually submitted",
								temporaryReference: { token: "private" },
							},
							productKey: "model",
							createdAt: new Date("2026-11-12"),
						},
					},
				]),
			},
		} as unknown as MediaDatabaseClient;
		const records = await getAssetPromptRecords("asset", client);
		expect(records.map(({ prompt, source }) => ({ prompt, source }))).toEqual([
			{ prompt: "unsent", source: "REFERENCE_DRAFT" },
			{ prompt: "actually submitted", source: "GENERATION_JOB" },
		]);
		expect(JSON.stringify(records)).not.toContain("private");
	});
});

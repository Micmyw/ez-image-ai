import { describe, expect, it, vi } from "vitest";

import { createJobDispatcher } from "./client";
import { OutboxDeliveryPendingError } from "./contracts";
const id = `job-${"a".repeat(64)}`;

describe("Outbox completion receipts", () => {
	it("keeps accepted work pending until the same Workflow completes", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ accepted: true, id, completed: false }, { status: 202 }),
			)
			.mockResolvedValueOnce(
				Response.json({ accepted: true, id, completed: true }, { status: 202 }),
			);
		const dispatch = createJobDispatcher({
			url: "https://jobs.example/internal/dispatch",
			secret: "test-only-32-character-shared-secret",
			fetch: fetcher,
		});
		const options = { idempotencyKey: "outbox:event:attempt:1", requireCompletion: true };
		await expect(
			dispatch("media-finalize-generation", { jobId: "j", version: 0 }, options),
		).rejects.toBeInstanceOf(OutboxDeliveryPendingError);
		await expect(
			dispatch("media-finalize-generation", { jobId: "j", version: 0 }, options),
		).resolves.toBeUndefined();
		expect(fetcher.mock.calls[0]?.[1]?.body).toEqual(fetcher.mock.calls[1]?.[1]?.body);
	});
	it("does not treat a proxy response as a durable receipt", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("ok"))
			.mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }));
		const dispatch = createJobDispatcher({
			url: "https://jobs.example/internal/dispatch",
			secret: "test-only-32-character-shared-secret",
			fetch: fetcher,
		});
		await expect(dispatch("media-finalize-generation", {})).rejects.toThrow(
			"WORKFLOWS_DISPATCH_REJECTED",
		);
		await expect(dispatch("media-finalize-generation", {})).rejects.toThrow(
			"WORKFLOWS_DISPATCH_UNCONFIRMED",
		);
	});
});

import { describe, expect, it, vi } from "vitest";

import { recoverMediaVerifications } from "./recover-media-verifications";

describe("recoverMediaVerifications", () => {
	it("requeues only bounded expired or due verification leases", async () => {
		const trigger = vi.fn(async () => undefined);
		const result = await recoverMediaVerifications(
			{ limit: 2 },
			{
				listCandidates: async () => [
					{ assetId: "asset-1", allowQuarantinedReverification: false },
					{ assetId: "asset-2", allowQuarantinedReverification: true },
				],
				trigger,
			},
		);

		expect(result).toEqual({ recovered: 2 });
		expect(trigger.mock.calls).toEqual([
			[{ assetId: "asset-1", allowQuarantinedReverification: false }],
			[{ assetId: "asset-2", allowQuarantinedReverification: true }],
		]);
	});

	it("continues dispatching other assets when one Trigger call fails", async () => {
		const trigger = vi
			.fn<
				(candidate: { assetId: string; allowQuarantinedReverification: boolean }) => Promise<void>
			>()
			.mockRejectedValueOnce(new Error("temporary Trigger failure"))
			.mockResolvedValueOnce(undefined);

		await expect(
			recoverMediaVerifications(
				{ limit: 10 },
				{
					listCandidates: async () => [
						{ assetId: "asset-1", allowQuarantinedReverification: false },
						{ assetId: "asset-2", allowQuarantinedReverification: false },
					],
					trigger,
				},
			),
		).resolves.toEqual({ recovered: 1 });
		expect(trigger).toHaveBeenCalledTimes(2);
	});
});

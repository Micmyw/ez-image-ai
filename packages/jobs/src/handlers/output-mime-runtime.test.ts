import { Readable } from "node:stream";

import { TestMediaSafetyAdapter } from "@repo/ai";
import { inspectRemoteMedia } from "@repo/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "../contracts";

const boundary = vi.hoisted(() => ({ claim: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	...(await vi.importActual<typeof import("@repo/database")>("@repo/database")),
	claimGenerationOutputTransferTransaction: boundary.claim,
}));

import { createFinalizationDependencies } from "../runtime";

describe("provider output format detection", () => {
	beforeEach(() => {
		boundary.claim.mockReset().mockResolvedValue({
			outcome: "COMPLETED",
			asset: { id: "stored-output", status: "READY" },
		});
	});

	it.each([
		["JPEG", "ffd8ffe000104a46494600010100000100", "image/jpeg"],
		["PNG", "89504e470d0a1a0a0000000d494844520000", "image/png"],
	] as const)(
		"uses detected %s bytes before claiming the immutable output key",
		async (_, hex, mime) => {
			const claim = {
				jobId: "test-job",
				ownerId: "test-owner",
				mediaKind: "image",
			} as FinalizationClaim;
			const dependencies = createFinalizationDependencies(process.env, {
				database: { mediaAsset: { findUnique: async () => null } } as never,
				store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
				safety: new TestMediaSafetyAdapter("ALLOW"),
				storage: {
					inspectRemoteMedia: (url, options) =>
						inspectRemoteMedia(url, {
							...options,
							resolve: async () => [{ address: "8.8.8.8", family: 4 }],
							request: async () => ({
								status: 200,
								headers: { "content-type": "application/octet-stream" },
								stream: Readable.from([Buffer.from(hex, "hex")]),
							}),
						}),
				},
			});
			await expect(
				dependencies.persistCandidate(claim, {
					key: "candidate-1",
					output: {
						kind: "remote-url",
						url: "https://replicate.delivery/output.png",
						trust: "untrusted-transfer-candidate",
					},
				}),
			).resolves.toMatchObject({ approved: true });
			expect(boundary.claim).toHaveBeenCalledWith(
				expect.objectContaining({ mimeType: mime }),
				expect.anything(),
			);
		},
	);
});

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const counts = { jobRead: 0, assetRead: 0, sign: 0 };
	const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	return {
		counts,
		delay,
		job: {} as any,
		asset: {} as any,
		queries: [] as any[],
		timings: [] as Array<{ stage: string; stageMs: number }>,
	};
});
vi.mock("@repo/auth", () => ({
	auth: {
		api: { getSession: async () => ({ user: { id: "sim-user" }, session: { id: "sim-session" } }) },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn((_message: string, timing: { stage: string; stageMs: number }) => {
			fixture.timings.push({ stage: timing.stage, stageMs: timing.stageMs });
		}),
	},
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: async () => {
		fixture.counts.sign++;
		await fixture.delay(10);
		return "https://simulation.invalid/image";
	},
}));
vi.mock("@repo/database/client", () => {
	const db = {
		generationJob: {
			findFirst: async (query: unknown) => {
				fixture.counts.jobRead++;
				fixture.queries.push(query);
				await fixture.delay(40);
				return fixture.job;
			},
		},
		mediaAsset: {
			findFirst: async () => {
				fixture.counts.assetRead++;
				await fixture.delay(40);
				return fixture.asset;
			},
		},
	};
	return { db, getDatabaseClient: () => db };
});
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import { getAssetAccessUrl } from "./get-asset-access-url";
import { getJob } from "./get-job";

describe("fixed-delay status delivery simulation", () => {
	it("measures actual procedure wall time with identical query/signing/transport delays", async () => {
		const boundary = currentMediaAssetVerificationBoundary();
		const validUntil = new Date(Date.now() + 600_000);
		fixture.asset = {
			id: "sim-output",
			ownerType: "USER",
			ownerId: "sim-user",
			kind: "OUTPUT",
			status: "READY",
			objectKey: "private/sim-output",
			mimeType: "image/png",
			byteSize: 128n,
			width: 16,
			height: 16,
			durationMillis: null,
			deletedAt: null,
			deleteAfter: null,
			createdAt: new Date(0),
			updatedAt: new Date(),
			checksum: "a".repeat(64),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: boundary.provider,
			verificationProviderTaskId: "see-sim",
			verificationRuleVersion: boundary.ruleVersion,
			verificationPolicyVersion: boundary.policyVersion,
			verificationValidUntil: validUntil,
			moderationResults: [
				{
					id: "audit",
					status: "APPROVED",
					assetChecksum: "a".repeat(64),
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "OUTPUT",
					provider: boundary.provider,
					providerTaskId: "see-sim",
					ruleVersion: boundary.ruleVersion,
					policyVersion: boundary.policyVersion,
					validUntil,
					createdAt: new Date(),
				},
			],
		};
		fixture.job = {
			id: "sim-job",
			ownerType: "USER",
			ownerId: "sim-user",
			status: "FINALIZING",
			version: 4,
			creditsReserved: 17n,
			productKey: "image-gpt-image-2",
			failureCode: null,
			inputSnapshot: {
				kind: "text-to-image",
				prompt: "simulated landscape",
				skuKey: "gpt-image-2-4k",
				aspectRatio: "4:5",
			},
			createdAt: new Date(0),
			updatedAt: new Date(),
			reservation: { status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n },
			_count: { attempts: 0 },
			attempts: [{ progress: 100, status: "SUCCEEDED", uncertainSubmission: false }],
			assets: [{ role: "OUTPUT", position: 0, asset: fixture.asset }],
		};
		const samples = [];
		for (let run = 0; run < 5; run++) {
			fixture.counts.jobRead = fixture.counts.assetRead = fixture.counts.sign = 0;
			fixture.timings = [];
			const start = performance.now();
			await fixture.delay(30); // Fixed loopback transport boundary, not measured Internet latency.
			const statusStarted = performance.now();
			const state = await call(
				getJob,
				{ jobId: "sim-job" },
				{ context: { headers: new Headers(), requestId: `sim-${run}` } },
			);
			const statusProcedureMs = performance.now() - statusStarted;
			const statusResponseMs = performance.now() - start;
			let url = (state.assets[0] as { preview?: { url: string } }).preview?.url;
			let requests = 1;
			if (!url) {
				requests++;
				await fixture.delay(30);
				url = (
					await call(
						getAssetAccessUrl,
						{ assetId: "sim-output", disposition: "inline" },
						{ context: { headers: new Headers() } },
					)
				).url;
			}
			expect(url).toBe("https://simulation.invalid/image");
			samples.push({
				readyToImageRequestMs: performance.now() - start,
				statusProcedureMs,
				statusResponseMs,
				stageTimings: [...fixture.timings],
				signingMs: fixture.timings
					.filter(({ stage }) => stage === "asset.sign" || stage === "status.sign")
					.reduce((sum, { stageMs }) => sum + stageMs, 0),
				requests,
				...fixture.counts,
			});
		}
		if (process.env.FLOW_SIMULATION_PHASE) {
			const directory = resolve(process.cwd(), "../../.cache/generation-batch1");
			mkdirSync(directory, { recursive: true });
			const filename = resolve(directory, `preview-${process.env.FLOW_SIMULATION_PHASE}.json`);
			if (process.env.FLOW_SIMULATION_PHASE.startsWith("before") && existsSync(filename))
				throw new Error("Saved baseline is immutable; choose a fresh evidence name");
			writeFileSync(
				filename,
				JSON.stringify(
					{
						clock: "wall",
						scope:
							"real getJob and getAssetAccessUrl with isolated delayed storage/database boundaries; image load measured separately",
						sourceMode:
							process.env.FLOW_STATUS_BASELINE === "1"
								? "saved timing-only source"
								: "current checkout",
						delaysMs: { dataAccess: 40, sign: 10, request: 30 },
						samples,
						query: fixture.queries[0],
						unmeasured: ["SQL server time", "connection wait", "Internet latency", "browser paint"],
					},
					null,
					2,
				),
			);
		}
	});
});

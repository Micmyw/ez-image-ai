import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isExplicitVideoVerificationTarget } from "../../../../../tests/load/video-verification-target";
import { PrismaClient } from "../../generated/client";
import { getOwnedMediaAssetReadState } from "./assets";
import { getOwnedGenerationJobStatus } from "./job-status";

let client: PrismaClient;
const statements: string[] = [];
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (
		url.hostname !== "127.0.0.1" ||
		(url.port !== "55432" && !isExplicitVideoVerificationTarget(url)) ||
		!/test/.test(url.pathname)
	)
		throw new Error("Unsafe database");
	client = new PrismaClient({
		adapter: new PrismaPg({ connectionString: url.toString() }),
		log: [{ emit: "event", level: "query" }],
	});
	(client as any).$on("query", (event: { query: string }) => statements.push(event.query));
});
afterAll(() => client?.$disconnect());

describe("job status database projection", () => {
	it("reads only required columns; includes current evidence and enforces owner scope", async () => {
		const id = crypto.randomUUID();
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				submittedByUserId: id,
				productKey: "image-fast",
				catalogVersion: "v1",
				pricingVersion: "v1",
				credits: 4n,
				costMicros: 1n,
				inputSnapshot: { kind: "text-to-image", prompt: "test" },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				submittedByUserId: id,
				quoteId: quote.id,
				idempotencyKey: id,
				productKey: "image-fast",
				catalogVersion: "v1",
				pricingVersion: "v1",
				creditsReserved: 4n,
				inputSnapshot: quote.inputSnapshot!,
				pricingSnapshot: { providerPrivateData: "x".repeat(16384) },
			},
		});
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				kind: "OUTPUT",
				objectKey: `private/${id}`,
				mimeType: "image/png",
				byteSize: 128n,
				checksum: "a".repeat(64),
				sourceUrl: "https://private.invalid/output",
			},
		});
		await client.generationJobAsset.create({
			data: { jobId: job.id, assetId: asset.id, assetChecksum: "a".repeat(64), role: "OUTPUT" },
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				status: "PENDING",
				verificationGeneration: 0,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: "v1",
				policyVersion: "v1",
				reasonCode: "IMAGE_PROCESSING",
				categories: {},
				rawEnvelope: { secret: "x".repeat(16384) },
			},
		});
		statements.length = 0;
		const started = performance.now();
		const current = await getOwnedGenerationJobStatus(job.id, id, client);
		const after = {
			queryCount: statements.length,
			wallMs: performance.now() - started,
			payloadBytes: jsonSize(current),
			assetColumns: Object.keys(current!.assets[0].asset).length,
		};
		expect(current?.assets[0].asset.moderationResults[0].status).toBe("PENDING");
		expect(current).not.toHaveProperty("pricingSnapshot");
		expect(current?.assets[0].asset).not.toHaveProperty("sourceUrl");
		expect(statements.join("\n")).not.toContain('"rawEnvelope"');
		expect(statements.join("\n")).not.toContain('"outputTransferToken"');
		expect(await getOwnedGenerationJobStatus(job.id, "other-user", client)).toBeNull();
		// Optional comparison uses the saved, timing-only baseline query, not a checkout reset.
		if (process.env.FLOW_SIMULATION_PHASE) {
			const directory = resolve(process.cwd(), "../../.cache/generation-batch1");
			const baseline = JSON.parse(
				readFileSync(resolve(directory, "preview-before.json"), "utf8"),
			).query;
			const oldRead = async () => {
				const prior: any = await client.generationJob.findFirst({
					...baseline,
					where: { id: job.id, ownerType: "USER", ownerId: id },
				});
				const access = await getOwnedMediaAssetReadState(
					{
						assetId: asset.id,
						ownerId: id,
						verification: {
							provider: "test",
							ruleVersion: "v1",
							policyVersion: "v1",
							now: new Date(),
						},
					},
					client,
				);
				return {
					payloadBytes: jsonSize(prior) + jsonSize(access),
					assetColumns: Object.keys(prior.assets[0].asset).length,
				};
			};
			const newRead = async () => {
				const state = await getOwnedGenerationJobStatus(job.id, id, client);
				return {
					payloadBytes: jsonSize(state),
					assetColumns: Object.keys(state!.assets[0].asset).length,
				};
			};
			// Warm both compiled queries before alternating their order on the same connection pool.
			await oldRead();
			await newRead();
			const samples: Array<{
				path: string;
				queryCount: number;
				wallMs: number;
				payloadBytes: number;
				assetColumns: number;
			}> = [];
			for (let index = 0; index < 10; index++) {
				for (const path of index % 2 ? ["after", "before"] : ["before", "after"]) {
					statements.length = 0;
					const start = performance.now();
					const metrics = await (path === "before" ? oldRead() : newRead());
					samples.push({
						path,
						queryCount: statements.length,
						wallMs: performance.now() - start,
						...metrics,
					});
				}
			}
			const before = samples.find((sample) => sample.path === "before")!;
			expect(after.payloadBytes).toBeLessThan(before.payloadBytes);
			expect(after.queryCount).toBeLessThan(before.queryCount);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				resolve(directory, "status-database-comparison.json"),
				JSON.stringify(
					{
						scope:
							"real isolated PostgreSQL projection plus legacy access lookup; single synthetic fixture, 10 alternating warmed samples per path; not production capacity evidence",
						before,
						after,
						samples,
						unmeasured: ["SQL server execution time", "connection wait", "Cloudflare latency"],
					},
					null,
					2,
				),
			);
		}
	});
});

function jsonSize(value: unknown) {
	return Buffer.byteLength(
		JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
	);
}

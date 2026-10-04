import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "../../generated/client";

const runId = `video-snapshot-${crypto.randomUUID()}`;
const fixtureJobs: string[] = [];
const fixtureQuotes: string[] = [];
let client: PrismaClient;

function inputSnapshot() {
	return {
		schemaVersion: 1,
		mode: "image-to-video",
		prompt: "A sailboat crosses the lake",
		duration: 5,
		sound: false,
		aspectRatio: "16:9",
		requestFingerprint: "a".repeat(64),
		inputIdentity: { assetId: "isolated-asset", checksum: "b".repeat(64), byteSize: 1000 },
		modelContractVersion: "isolated-model-contract",
		visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
	};
}

beforeAll(() => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	const standardTest =
		url.port === "55432" &&
		(url.pathname === "/ai_media_foundation_test" ||
			/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname));
	const videoTest =
		url.port === "55439" &&
		raw === process.env.VIDEO_VERIFICATION_DATABASE_URL &&
		url.pathname === "/ezpic_video_v1_final_test";
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || (!standardTest && !videoTest))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 4 }) });
});
afterAll(async () => {
	if (!client) return;
	try {
		await client.generationJob.deleteMany({ where: { id: { in: fixtureJobs } } });
		await client.generationQuote.deleteMany({ where: { id: { in: fixtureQuotes } } });
	} finally {
		await client.$disconnect();
	}
});

async function fixture(
	engine = "video-workflow-v1",
	snapshot: Prisma.InputJsonValue = inputSnapshot(),
) {
	const ownerId = `${runId}-${crypto.randomUUID()}`;
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "isolated-video-snapshot",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 1n,
			costMicros: 0n,
			inputSnapshot: snapshot,
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	fixtureQuotes.push(quote.id);
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			productKey: quote.productKey,
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 1n,
			inputSnapshot: snapshot,
			pricingSnapshot: {},
			executionEngine: engine,
			// Terminal fixtures never occupy another suite's provider-capacity slots.
			status: "FAILED",
			terminalAt: new Date(),
			failureCode: "ISOLATED_TEST_FIXTURE",
		},
	});
	fixtureJobs.push(job.id);
	return job;
}

describe("video job immutable accepted input snapshot", () => {
	it("installs the video-only trigger and preserves the existing engine fence", async () => {
		const rows = await client.$queryRaw<Array<{ tgname: string; tgenabled: string }>>`
			SELECT tgname::text, tgenabled::text FROM pg_trigger
			WHERE tgrelid = 'generation_job'::regclass AND tgname IN
			('generation_job_video_input_snapshot_immutable', 'generation_job_execution_engine_immutable')`;
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.tgenabled === "O")).toBe(true);
	});

	it.each([
		[
			"provider",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({
				...snapshot,
				visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5),
			}),
		],
		[
			"profile removal",
			(snapshot: ReturnType<typeof inputSnapshot>) => {
				const { visualSafetyProfile: _profile, ...without } = snapshot;
				return without;
			},
		],
		[
			"profile settings",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({
				...snapshot,
				visualSafetyProfile: { ...snapshot.visualSafetyProfile, unexpectedOverride: true },
			}),
		],
		[
			"prompt",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({
				...snapshot,
				prompt: "A different unreviewed prompt",
			}),
		],
		["duration", (snapshot: ReturnType<typeof inputSnapshot>) => ({ ...snapshot, duration: 10 })],
		[
			"audio choice",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({ ...snapshot, sound: true }),
		],
		[
			"asset checksum",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({
				...snapshot,
				inputIdentity: { ...snapshot.inputIdentity, checksum: "c".repeat(64) },
			}),
		],
		[
			"model contract",
			(snapshot: ReturnType<typeof inputSnapshot>) => ({
				...snapshot,
				modelContractVersion: "other-model-contract",
			}),
		],
	])("rejects changes to %s and retains the original content", async (_label, change) => {
		const snapshot = inputSnapshot();
		const job = await fixture("video-workflow-v1", snapshot);
		await expect(
			client.generationJob.update({
				where: { id: job.id },
				data: { inputSnapshot: change(snapshot) },
			}),
		).rejects.toThrow("Video generation input snapshot is immutable");
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: job.id } })).inputSnapshot,
		).toEqual(snapshot);
	});

	it("also rejects JSON null and raw-SQL nested content rewrites", async () => {
		const job = await fixture();
		await expect(
			client.generationJob.update({
				where: { id: job.id },
				data: { inputSnapshot: Prisma.JsonNull },
			}),
		).rejects.toThrow("Video generation input snapshot is immutable");
		await expect(
			client.$executeRaw`UPDATE "generation_job" SET "inputSnapshot" = jsonb_set("inputSnapshot", '{prompt}', '"changed through SQL"'::jsonb) WHERE id = ${job.id}`,
		).rejects.toThrow("Video generation input snapshot is immutable");
	});

	it("preserves historic snapshots without a visual profile and forbids backfilling them in place", async () => {
		const historic = { schemaVersion: 1, prompt: "Historic input", duration: 5, sound: false };
		const job = await fixture("video-workflow-v1", historic);
		await expect(
			client.generationJob.update({
				where: { id: job.id },
				data: {
					inputSnapshot: {
						...historic,
						visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
					},
				},
			}),
		).rejects.toThrow("Video generation input snapshot is immutable");
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: job.id } })).inputSnapshot,
		).toEqual(historic);
	});

	it("allows normal lifecycle changes and a semantically identical JSON rewrite", async () => {
		const snapshot = inputSnapshot();
		const job = await fixture("video-workflow-v1", snapshot);
		const reversedKeys = Object.fromEntries(Object.entries(snapshot).reverse());
		await expect(
			client.generationJob.update({
				where: { id: job.id },
				data: {
					status: "CANCELED",
					failureCode: "ISOLATED_TEST_CANCELED",
					inputSnapshot: reversedKeys,
				},
			}),
		).resolves.toMatchObject({ status: "CANCELED", inputSnapshot: snapshot });
	});

	it("does not change legacy image snapshot behavior", async () => {
		const job = await fixture("legacy", { prompt: "Existing image" });
		await expect(
			client.generationJob.update({
				where: { id: job.id },
				data: { inputSnapshot: { prompt: "Legacy image update" } },
			}),
		).resolves.toMatchObject({ inputSnapshot: { prompt: "Legacy image update" } });
	});

	it("cannot bypass snapshot protection by switching execution ownership in the same update", async () => {
		const video = await fixture();
		await expect(
			client.generationJob.update({
				where: { id: video.id },
				data: { executionEngine: "legacy", inputSnapshot: { prompt: "bypass" } },
			}),
		).rejects.toThrow("Generation execution engine is immutable");
		const image = await fixture("legacy", { prompt: "image" });
		await expect(
			client.generationJob.update({
				where: { id: image.id },
				data: { executionEngine: "video-workflow-v1", inputSnapshot: inputSnapshot() },
			}),
		).rejects.toThrow("Generation execution engine is immutable");
	});

	it("rolls back a mixed bulk update rather than partially changing legacy and video snapshots", async () => {
		const video = await fixture();
		const image = await fixture("legacy", { prompt: "image" });
		await expect(
			client.generationJob.updateMany({
				where: { id: { in: [image.id, video.id] } },
				data: { inputSnapshot: { prompt: "bulk rewrite" } },
			}),
		).rejects.toThrow("Video generation input snapshot is immutable");
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: image.id } })).inputSnapshot,
		).toEqual({ prompt: "image" });
		expect(
			(await client.generationJob.findUniqueOrThrow({ where: { id: video.id } })).inputSnapshot,
		).toEqual(video.inputSnapshot);
	});
});

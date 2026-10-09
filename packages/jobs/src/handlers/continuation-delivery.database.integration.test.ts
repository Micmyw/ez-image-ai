import { PrismaPg } from "@prisma/adapter-pg";
import { claimOutboxBatch, completeOutboxEvent, deferOutboxEvent } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, expect, it } from "vitest";

let database: PrismaClient;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "");
	const explicitImageTarget =
		process.env.MEDIA_IMAGE_TEST_DATABASE_URL === url.href &&
		url.port !== "5432" &&
		Boolean(url.port);
	if (
		url.hostname !== "127.0.0.1" ||
		(url.port !== "55432" && !explicitImageTarget) ||
		!url.pathname.includes("test")
	)
		throw new Error("USE_DISPOSABLE_DATABASE");
	database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
});
afterAll(async () => database?.$disconnect());

it.each([
	"JOB_CREATED",
	"GENERATION_DISPATCH",
	"GENERATION_FINALIZE",
	"GENERATION_FINALIZE_RETRY",
	"GENERATION_SETTLE",
	"MEDIA_ASSET_VERIFY",
	"MEDIA_ASSET_MODERATION_REQUESTED",
])(
	"shares the %s claim and lease across direct delivery, scan, lost response and old payload recovery",
	async (eventType) => {
		const now = new Date("1890-01-01T00:00:00Z");
		const event = await database.outboxEvent.create({
			data: {
				eventType,
				aggregateType: eventType.startsWith("MEDIA") ? "MEDIA_ASSET" : "GENERATION_JOB",
				aggregateId: crypto.randomUUID(),
				dedupeKey: `direct:${crypto.randomUUID()}`,
				payload: {},
				availableAt: now,
			},
		});
		const claim = { limit: 1, leaseSeconds: 10, now };
		try {
			const [direct, scan] = await Promise.all([
				claimOutboxBatch({ ...claim, workerId: "direct", eventIds: [event.id] }, database),
				claimOutboxBatch({ ...claim, workerId: "scan" }, database),
			]);
			expect(direct.length + scan.length).toBe(1);
			const first = [...direct, ...scan][0]!;
			expect(first.id).toBe(event.id);
			const workerId = direct.length ? "direct" : "scan";
			// Acceptance response loss must retain the delivery number, with no ACK.
			expect(
				await deferOutboxEvent(
					{
						id: event.id,
						workerId,
						leaseToken: first.leaseToken,
						retryAt: new Date(now.getTime() + 1000),
						now,
					},
					database,
				),
			).toEqual({ applied: true });
			expect(
				await claimOutboxBatch({ ...claim, workerId: "early", eventIds: [event.id] }, database),
			).toEqual([]);
			const [retry] = await claimOutboxBatch(
				{ ...claim, now: new Date(now.getTime() + 1001), workerId: "retry", eventIds: [event.id] },
				database,
			);
			expect(retry!.attempts).toBe(first.attempts);
			expect(
				(await completeOutboxEvent(event.id, workerId, first.leaseToken, database)).count,
			).toBe(0);
			// Process death before ACK: only expired lease can be reclaimed by scanning.
			const [recovered] = await claimOutboxBatch(
				{ ...claim, now: new Date(now.getTime() + 11002), workerId: "recovery" },
				database,
			);
			expect(recovered!.id).toBe(event.id);
			expect(
				(await completeOutboxEvent(event.id, "retry", retry!.leaseToken, database)).count,
			).toBe(0);
			expect(
				(await completeOutboxEvent(event.id, "recovery", recovered!.leaseToken, database)).count,
			).toBe(1);
		} finally {
			await database.outboxEvent.delete({ where: { id: event.id } });
		}
	},
);

it("rejects unrelated maintenance and contradictory payload identities in targeted claims", async () => {
	const now = new Date("1890-01-01T00:00:00Z");
	const rows = await Promise.all(
		["MEDIA_OBJECT_DELETE", "GENERATION_FINALIZE"].map((eventType) =>
			database.outboxEvent.create({
				data: {
					eventType,
					aggregateType: "GENERATION_JOB",
					aggregateId: "original",
					dedupeKey: crypto.randomUUID(),
					payload: { jobId: "another-job" },
					availableAt: now,
				},
			}),
		),
	);
	try {
		expect(
			await claimOutboxBatch(
				{ workerId: "target", eventIds: rows.map((e) => e.id), now, limit: 10, leaseSeconds: 10 },
				database,
			),
		).toEqual([]);
	} finally {
		await database.outboxEvent.deleteMany({ where: { id: { in: rows.map((e) => e.id) } } });
	}
});

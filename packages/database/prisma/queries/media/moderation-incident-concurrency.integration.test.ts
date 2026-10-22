import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import { recordModerationOutcome, recordTextModerationOutcome } from "./moderation-operations";
import {
	createModeratedGenerationQuote,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";
import type { MediaDatabaseClient } from "./types";

let client: PrismaClient;

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (
		!connectionString ||
		connectionString === process.env.DATABASE_URL ||
		!localSqlMetricsEnabled(connectionString, "true")
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 12 }) });
});

afterAll(() => client?.$disconnect());

function quoteInput(provider: string, startedAt = new Date(), failures = 0) {
	const quoteId = crypto.randomUUID();
	const ownerId = crypto.randomUUID();
	const quote = {
		quoteId,
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "test",
		pricingVersion: "test",
		credits: 4n,
		inputSnapshot: { kind: "text-to-image", prompt: "A local fixture landscape" },
		expiresAt: new Date(Date.now() + 60_000),
	};
	return {
		...quote,
		moderation: {
			provider,
			decision: "ALLOW" as const,
			ruleVersion: "test",
			reasonCode: "ALLOWED",
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
			retry: {
				failures,
				lastErrorCode: failures ? "MODERATION_TIMEOUT" : "",
				startedAt: startedAt.toISOString(),
				lastFailureAt: startedAt.toISOString(),
			},
		},
	};
}

function uniqueProvider() {
	return `incident-lock-${crypto.randomUUID()}`;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function heldQuote(input: ReturnType<typeof quoteInput>) {
	const reached = deferred<void>();
	const release = deferred<void>();
	const completed = client.$transaction(
		async (tx) => {
			const quote = await createModeratedGenerationQuote(input, tx);
			reached.resolve();
			await release.promise;
			return quote;
		},
		{ timeout: 10_000 },
	);
	void completed.catch(reached.reject);
	return { reached: reached.promise, release: release.resolve, completed };
}

async function failure(
	provider: string,
	tx: MediaDatabaseClient,
	lastFailureAt = new Date(),
	failures = 4,
) {
	await recordModerationOutcome(
		{
			targetType: "TEXT_ATTEMPT",
			targetId: crypto.randomUUID(),
			provider,
			stage: "TEXT",
			epoch: "test",
			failures,
			lastErrorCode: "MODERATION_TIMEOUT",
			startedAt: lastFailureAt,
			lastFailureAt,
			status: "BLOCKED",
		},
		tx,
	);
}

function blockedWriter(operation: (tx: MediaDatabaseClient) => Promise<unknown>) {
	const backend = deferred<number>();
	const completed = client.$transaction(
		async (tx) => {
			const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			backend.resolve(row!.pid);
			await operation(tx);
		},
		{ timeout: 10_000 },
	);
	void completed.catch(backend.reject);
	return { backend: backend.promise, completed };
}

async function waitForExclusiveWaiter(pid: number) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const [lock] = await client.$queryRaw<Array<{ waiting: boolean }>>`
					SELECT EXISTS (
						SELECT 1 FROM pg_locks
						WHERE pid = ${pid} AND locktype = 'advisory'
						AND mode = 'ExclusiveLock' AND NOT granted
					) AS waiting`;
		if (lock?.waiting) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("EXPECTED_EXCLUSIVE_INCIDENT_LOCK_WAITER");
}

async function incidentAlerts(incidentId: string) {
	return client.outboxEvent.findMany({
		where: { eventType: "MODERATION_INCIDENT_ALERT", aggregateId: incidentId },
		select: { dedupeKey: true },
		orderBy: { dedupeKey: "asc" },
	});
}

describe("fresh quote incident concurrency", () => {
	it("lets distinct owners finish zero-failure moderation while another fresh quote remains uncommitted", async () => {
		const provider = uniqueProvider();
		const first = heldQuote(quoteInput(provider));
		let second: Promise<unknown> | undefined;
		try {
			await bounded(first.reached, "FIRST_QUOTE_NOT_READY");
			second = client.$transaction((tx) =>
				createModeratedGenerationQuote(quoteInput(provider), tx),
			);
			await bounded(second, "FRESH_SUCCESS_WAS_SERIALIZED_BEHIND_ANOTHER_OWNER");
			expect(await client.moderationIncident.count({ where: { provider } })).toBe(0);
			expect(await client.moderationReview.count({ where: { provider } })).toBe(0);
		} finally {
			first.release();
			await Promise.allSettled([first.completed, ...(second ? [second] : [])]);
		}
	});

	it("keeps failure recording exclusive until every shared successful transaction has committed", async () => {
		const provider = uniqueProvider();
		const first = heldQuote(quoteInput(provider));
		const second = heldQuote(quoteInput(provider));
		let writer: ReturnType<typeof blockedWriter> | undefined;
		try {
			await bounded(Promise.all([first.reached, second.reached]), "SHARED_SUCCESSES_NOT_READY");
			writer = blockedWriter((tx) => failure(provider, tx));
			const pid = await writer.backend;
			await waitForExclusiveWaiter(pid);
			first.release();
			await first.completed;
			await waitForExclusiveWaiter(pid);
			second.release();
			await writer.completed;
			expect(
				await client.moderationIncident.findUnique({ where: { activeKey: `${provider}:TEXT` } }),
			).toMatchObject({ status: "OPEN", failureCount: 4 });
		} finally {
			first.release();
			second.release();
			await Promise.allSettled([
				first.completed,
				second.completed,
				...(writer ? [writer.completed] : []),
			]);
		}
	});

	it("recovers an existing incident once across concurrent successful owners", async () => {
		const provider = uniqueProvider();
		const failedAt = new Date(Date.now() - 1_000);
		await client.$transaction((tx) => failure(provider, tx, failedAt));
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${provider}:TEXT` },
		});
		await Promise.all(
			Array.from({ length: 8 }, () =>
				client.$transaction((tx) => createModeratedGenerationQuote(quoteInput(provider), tx)),
			),
		);
		expect(
			await client.moderationIncident.findUnique({ where: { id: incident.id } }),
		).toMatchObject({ status: "RECOVERED", activeKey: null });
		expect(await incidentAlerts(incident.id)).toEqual([
			{ dedupeKey: `moderation-incident:${incident.id}:OPEN` },
			{ dedupeKey: `moderation-incident:${incident.id}:RECOVERED` },
		]);
		expect(await client.moderationReview.count({ where: { provider } })).toBe(0);
	});

	it("does not let a fresh but older successful request close a newer failure", async () => {
		const provider = uniqueProvider();
		const failedAt = new Date();
		await client.$transaction((tx) => failure(provider, tx, failedAt));
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${provider}:TEXT` },
		});
		await client.$transaction((tx) =>
			createModeratedGenerationQuote(quoteInput(provider, new Date(failedAt.getTime() - 1)), tx),
		);
		expect(
			await client.moderationIncident.findUnique({ where: { id: incident.id } }),
		).toMatchObject({ status: "OPEN", activeKey: `${provider}:TEXT` });
		expect(await incidentAlerts(incident.id)).toEqual([
			{ dedupeKey: `moderation-incident:${incident.id}:OPEN` },
		]);
	});

	it("keeps a failure arriving during successful recovery as a new open incident", async () => {
		const provider = uniqueProvider();
		await client.$transaction((tx) => failure(provider, tx, new Date(Date.now() - 1_000)));
		const original = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${provider}:TEXT` },
		});
		const success = heldQuote(quoteInput(provider));
		let writer: ReturnType<typeof blockedWriter> | undefined;
		try {
			await bounded(success.reached, "RECOVERY_NOT_READY");
			writer = blockedWriter((tx) => failure(provider, tx));
			await waitForExclusiveWaiter(await writer.backend);
			success.release();
			await Promise.all([success.completed, writer.completed]);
			const current = await client.moderationIncident.findUniqueOrThrow({
				where: { activeKey: `${provider}:TEXT` },
			});
			expect(current.id).not.toBe(original.id);
			expect(current).toMatchObject({ status: "OPEN", failureCount: 4 });
			expect(
				await client.moderationIncident.findUnique({ where: { id: original.id } }),
			).toMatchObject({ status: "RECOVERED", activeKey: null });
			expect(await incidentAlerts(original.id)).toHaveLength(2);
			expect(await incidentAlerts(current.id)).toEqual([
				{ dedupeKey: `moderation-incident:${current.id}:OPEN` },
			]);
		} finally {
			success.release();
			await Promise.allSettled([success.completed, ...(writer ? [writer.completed] : [])]);
		}
	});

	it("retains exclusive locking and failure accounting for a new quote that retried", async () => {
		const provider = uniqueProvider();
		const success = heldQuote(quoteInput(provider));
		const retried = quoteInput(provider, new Date(), 1);
		let writer: ReturnType<typeof blockedWriter> | undefined;
		try {
			await bounded(success.reached, "FIRST_QUOTE_NOT_READY");
			writer = blockedWriter((tx) => createModeratedGenerationQuote(retried, tx));
			await waitForExclusiveWaiter(await writer.backend);
			success.release();
			await writer.completed;
			expect(
				await client.moderationReview.findUnique({
					where: { targetType_targetId: { targetType: "QUOTE", targetId: retried.quoteId } },
				}),
			).toMatchObject({ status: "APPROVED", failureCount: 1, observedFailures: 1 });
		} finally {
			success.release();
			await Promise.allSettled([success.completed, ...(writer ? [writer.completed] : [])]);
		}
	});

	it("keeps the historical outcome entry exclusive even for a zero-failure success", async () => {
		const provider = uniqueProvider();
		const original = quoteInput(provider);
		await client.$transaction((tx) => createModeratedGenerationQuote(original, tx));
		const success = heldQuote(quoteInput(provider));
		let writer: ReturnType<typeof blockedWriter> | undefined;
		try {
			await bounded(success.reached, "FRESH_QUOTE_NOT_READY");
			writer = blockedWriter((tx) =>
				recordTextModerationOutcome(
					{ targetType: "QUOTE", targetId: original.quoteId, moderation: original.moderation },
					tx,
				),
			);
			await waitForExclusiveWaiter(await writer.backend);
			success.release();
			await writer.completed;
		} finally {
			success.release();
			await Promise.allSettled([success.completed, ...(writer ? [writer.completed] : [])]);
		}
	});

	it("rolls back incident recovery and its notice together with the fresh quote", async () => {
		const provider = uniqueProvider();
		await client.$transaction((tx) => failure(provider, tx, new Date(Date.now() - 1_000)));
		const incident = await client.moderationIncident.findUniqueOrThrow({
			where: { activeKey: `${provider}:TEXT` },
		});
		const input = quoteInput(provider);
		await expect(
			client.$transaction(async (tx) => {
				await createModeratedGenerationQuote(input, tx);
				throw new Error("ROLLBACK_FIXTURE");
			}),
		).rejects.toThrow("ROLLBACK_FIXTURE");
		expect(await client.generationQuote.findUnique({ where: { id: input.quoteId } })).toBeNull();
		expect(
			await client.moderationIncident.findUnique({ where: { id: incident.id } }),
		).toMatchObject({ status: "OPEN", activeKey: `${provider}:TEXT` });
		expect(await incidentAlerts(incident.id)).toEqual([
			{ dedupeKey: `moderation-incident:${incident.id}:OPEN` },
		]);
	});
});

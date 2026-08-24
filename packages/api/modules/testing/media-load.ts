import { createHash, timingSafeEqual } from "node:crypto";

import {
	getCatalogEntry,
	quoteCatalogInput,
	type MediaProviderAdapter,
	type NormalizedResult,
	type ProviderKey,
	type ProviderSubmission,
	type ProviderTaskSnapshot,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { createCreditGrant, createGenerationJobTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { fingerprintGenerationQuoteSecurityPayload } from "@repo/database/media-quotes";
import { createDatabaseDispatchStore, dispatchGeneration } from "@repo/jobs";
import type { Context } from "hono";
import { z } from "zod";

import { maximumMediaStorageBytes } from "../media/lib/storage-limits";

const LOAD_BODY_LIMIT_BYTES = 4 * 1024;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
const DEFAULT_CONCURRENCY_LIMIT = 64;
const DEFAULT_CREDIT_GRANT = 100_000n;
const TOKEN_MINIMUM_LENGTH = 43;
const TOKEN_MAXIMUM_LENGTH = 256;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOAD_TEST_MODERATION_RULE_VERSION = "TEST_ALLOW_CONTROLLED_LOAD_V1";

export const MEDIA_LOAD_MODES = ["fast", "long", "uncertain", "provider-fail"] as const;

export type MediaLoadMode = (typeof MEDIA_LOAD_MODES)[number];

const requestSchema = z.object({
	mode: z.enum(MEDIA_LOAD_MODES),
	idempotencyKey: z.string().min(12).max(180),
	prompt: z.string().min(1).max(256).optional(),
});

interface LoadTestEnvironment extends Record<string, string | undefined> {
	NODE_ENV?: string;
	DATABASE_URL?: string;
	LOAD_TEST_DATABASE_URL?: string;
	LOAD_TESTING_ENABLED?: string;
	LOAD_AUTH_TOKEN?: string;
	LOAD_TEST_RUN_ID?: string;
	LOAD_TEST_RATE_LIMIT_PER_MINUTE?: string;
	LOAD_TEST_CONCURRENCY_LIMIT?: string;
	LOAD_TEST_CREDIT_GRANT?: string;
	LOAD_TEST_REMOTE_DATABASE_ENABLED?: string;
	LOAD_TEST_DATABASE_NAME_CONFIRMATION?: string;
}

export interface LoadTestConfiguration {
	authToken: string;
	runId: string;
	ownerId: string;
	rateLimitPerMinute: number;
	concurrencyLimit: number;
	creditGrant: bigint;
}

interface MediaLoadRequest {
	mode: MediaLoadMode;
	idempotencyKey: string;
}

interface MediaLoadResult {
	jobId: string;
	idempotencyKey: string;
	mode: MediaLoadMode;
	status: string;
	replayed: boolean;
	internalQueueMs: number;
}

interface HandlerDependencies {
	environment(): LoadTestEnvironment;
	execute(input: MediaLoadRequest, configuration: LoadTestConfiguration): Promise<MediaLoadResult>;
	now(): number;
}

interface RateWindow {
	startedAt: number;
	requests: number;
}

export class LoadTestConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LoadTestConflictError";
	}
}

export function resolveLoadTestConfiguration(
	environment: LoadTestEnvironment,
): LoadTestConfiguration | null {
	if (environment.LOAD_TESTING_ENABLED !== "true" || environment.NODE_ENV === "production") {
		return null;
	}
	const authToken = environment.LOAD_AUTH_TOKEN;
	if (!isHighEntropyToken(authToken)) return null;
	const runId = environment.LOAD_TEST_RUN_ID;
	if (!runId || !/^[a-z0-9][a-z0-9-]{5,47}$/i.test(runId)) return null;
	if (!isExplicitLoadDatabase(environment)) return null;

	const rateLimitPerMinute = boundedInteger(
		environment.LOAD_TEST_RATE_LIMIT_PER_MINUTE,
		DEFAULT_RATE_LIMIT_PER_MINUTE,
		1,
		10_000,
	);
	const concurrencyLimit = boundedInteger(
		environment.LOAD_TEST_CONCURRENCY_LIMIT,
		DEFAULT_CONCURRENCY_LIMIT,
		1,
		1_000,
	);
	const creditGrant = boundedBigInt(
		environment.LOAD_TEST_CREDIT_GRANT,
		DEFAULT_CREDIT_GRANT,
		4n,
		10_000_000n,
	);
	if (rateLimitPerMinute === null || concurrencyLimit === null || creditGrant === null) return null;

	return {
		authToken,
		runId,
		ownerId: `load-test:${runId}`,
		rateLimitPerMinute,
		concurrencyLimit,
		creditGrant,
	};
}

export function createMediaLoadTestHandler(
	dependencies: Partial<HandlerDependencies> = {},
): (context: Context) => Promise<Response> {
	const resolvedDependencies: HandlerDependencies = {
		environment: () => process.env,
		execute: executeMediaLoadRequest,
		now: Date.now,
		...dependencies,
	};
	const rateWindows = new Map<string, RateWindow>();
	let activeRequests = 0;

	return async function mediaLoadTestHandler(context: Context): Promise<Response> {
		const configuration = resolveLoadTestConfiguration(resolvedDependencies.environment());
		if (!configuration) return unavailable(context);
		if (
			!constantTimeTokenMatches(
				readBearerToken(context.req.header("authorization")),
				configuration.authToken,
			)
		) {
			return context.json({ code: "UNAUTHORIZED" }, 401, noStoreHeaders());
		}

		const now = resolvedDependencies.now();
		const rateWindow = rateWindows.get(configuration.runId);
		if (!rateWindow || now - rateWindow.startedAt >= 60_000) {
			rateWindows.set(configuration.runId, { startedAt: now, requests: 1 });
		} else if (rateWindow.requests >= configuration.rateLimitPerMinute) {
			return context.json({ code: "LOAD_RATE_LIMITED" }, 429, retryHeaders(60));
		} else {
			rateWindow.requests += 1;
		}
		if (activeRequests >= configuration.concurrencyLimit) {
			return context.json({ code: "LOAD_CONCURRENCY_LIMITED" }, 429, retryHeaders(1));
		}

		activeRequests += 1;
		try {
			const rawBody = await readBoundedBody(context.req.raw, LOAD_BODY_LIMIT_BYTES);
			if (!rawBody.ok) return context.json({ code: "PAYLOAD_TOO_LARGE" }, 413, noStoreHeaders());
			const parsed = parseRequest(rawBody.value);
			if (!parsed.success)
				return context.json({ code: "INVALID_LOAD_REQUEST" }, 400, noStoreHeaders());
			if (!parsed.data.idempotencyKey.startsWith(`k6:${configuration.runId}:`)) {
				return context.json({ code: "INVALID_LOAD_RUN" }, 400, noStoreHeaders());
			}

			const result = await resolvedDependencies.execute(parsed.data, configuration);
			return context.json(result, result.replayed ? 200 : 202, {
				...noStoreHeaders(),
				"X-Internal-Queue-Ms": String(result.internalQueueMs),
			});
		} catch (error) {
			if (error instanceof LoadTestConflictError) {
				return context.json({ code: "LOAD_IDEMPOTENCY_CONFLICT" }, 409, noStoreHeaders());
			}
			return context.json({ code: "LOAD_REQUEST_FAILED" }, 500, noStoreHeaders());
		} finally {
			activeRequests -= 1;
		}
	};
}

export const mediaLoadTestHandler = createMediaLoadTestHandler();

export async function executeMediaLoadRequest(
	input: MediaLoadRequest,
	configuration: LoadTestConfiguration,
): Promise<MediaLoadResult> {
	const account = await db.creditAccount.upsert({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId: configuration.ownerId } },
		create: { ownerType: "USER", ownerId: configuration.ownerId },
		update: {},
	});
	await createCreditGrant(
		{
			accountId: account.id,
			amount: configuration.creditGrant,
			referenceKey: `load-test:${configuration.runId}:grant`,
			metadata: { source: "controlled-load-test", runId: configuration.runId },
		},
		db,
	);

	const modelInput = {
		kind: "text-to-image" as const,
		prompt: `Controlled load fixture [${input.mode}]`,
	};
	const productKey = "image-fast" as const;
	const quoted = quoteCatalogInput({ productKey, input: modelInput });
	const route = getCatalogEntry(productKey).routes[0];
	if (!route) throw new Error("LOAD_CATALOG_ROUTE_MISSING");
	const quoteId = `loadq_${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}`;
	const expiresAt = new Date(Date.now() + 60 * 60_000);
	const quoteSecurityPayload = {
		ownerType: "USER" as const,
		ownerId: configuration.ownerId,
		submittedByUserId: configuration.ownerId,
		productKey,
		catalogVersion: quoted.catalogVersion,
		pricingVersion: quoted.pricingVersion,
		credits: BigInt(quoted.credits),
		costMicros: BigInt(route.providerCostMicros),
		inputSnapshot: modelInput,
		pricingSnapshot: { credits: quoted.credits, source: "controlled-load-test" },
		expiresAt,
	};
	const quote = await db.generationQuote.upsert({
		where: { id: quoteId },
		create: {
			id: quoteId,
			...quoteSecurityPayload,
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: LOAD_TEST_MODERATION_RULE_VERSION,
			moderationReasonCode: "TEST_ALLOW_CONTROLLED_LOAD",
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteSecurityPayload),
		},
		update: {},
	});
	if (
		quote.ownerId !== configuration.ownerId ||
		quote.productKey !== productKey ||
		JSON.stringify(quote.inputSnapshot) !== JSON.stringify(modelInput)
	) {
		throw new LoadTestConflictError(
			"The idempotency key was already used with another load command",
		);
	}

	const createdAt = Date.now();
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId: configuration.ownerId,
			submittedByUserId: configuration.ownerId,
			quoteId: quote.id,
			idempotencyKey: input.idempotencyKey,
			inputAssetIds: [],
			expectedModerationRuleVersion: LOAD_TEST_MODERATION_RULE_VERSION,
			maximumDailyCostMicros: BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros),
			maximumStorageBytes: maximumMediaStorageBytes(),
		},
		db,
	);
	if (!created.replayed) {
		await dispatchGeneration(
			{ jobId: created.job.id, version: created.job.version },
			{
				store: createDatabaseDispatchStore(db),
				getProvider: (provider) => new ControlledLoadProvider(provider, input.mode),
				isGenerationEnabled: () => true,
			},
		);
	}
	const [job, attempt] = await Promise.all([
		db.generationJob.findUniqueOrThrow({ where: { id: created.job.id } }),
		db.generationAttempt.findFirst({
			where: { jobId: created.job.id },
			orderBy: { attemptNumber: "asc" },
		}),
	]);
	const internalQueueMs = attempt
		? Math.max(0, attempt.createdAt.getTime() - job.createdAt.getTime())
		: Math.max(0, Date.now() - createdAt);
	return {
		jobId: job.id,
		idempotencyKey: input.idempotencyKey,
		mode: input.mode,
		status: job.status,
		replayed: created.replayed,
		internalQueueMs,
	};
}

class ControlledLoadProvider implements MediaProviderAdapter {
	constructor(
		readonly provider: ProviderKey,
		private readonly mode: MediaLoadMode,
	) {}

	async submit(input: Parameters<MediaProviderAdapter["submit"]>[0]): Promise<ProviderSubmission> {
		if (this.mode === "uncertain") throw new Error("Controlled uncertain submission");
		if (this.mode === "provider-fail") {
			return {
				status: "FAILED",
				failure: {
					code: "CONTROLLED_PROVIDER_FAILURE",
					message: "Controlled load-test failure",
					retryable: false,
				},
				idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
				outcome: "rejected",
				reconciliation: { submissionToken: input.attemptId },
			};
		}
		const providerTaskId = `load-test-${input.attemptId}`;
		if (this.mode === "long") {
			return {
				providerTaskId,
				status: "QUEUED",
				idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
				outcome: "accepted",
				reconciliation: { submissionToken: input.attemptId },
			};
		}
		const snapshot = successfulSnapshot(providerTaskId);
		return {
			providerTaskId,
			status: "SUCCEEDED",
			snapshot,
			idempotency: { key: input.attemptId, providerSupported: true, replayed: false },
			outcome: "accepted",
			reconciliation: { submissionToken: input.attemptId },
		};
	}

	async retrieve(input: { providerTaskId: string }): Promise<ProviderTaskSnapshot> {
		return successfulSnapshot(input.providerTaskId);
	}

	async normalizeResult(_snapshot: ProviderTaskSnapshot): Promise<NormalizedResult> {
		return {
			outputs: [
				{
					kind: "inline-base64",
					mimeType: "image/png",
					data: CONTROLLED_INLINE_PNG_BASE64,
					trust: "untrusted-transfer-candidate",
				},
			],
			progress: 100,
			providerCostMicros: 0,
			failure: null,
			retryable: false,
			providerCharged: false,
		};
	}
}

const CONTROLLED_INLINE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function successfulSnapshot(providerTaskId: string): ProviderTaskSnapshot {
	return { providerTaskId, status: "SUCCEEDED", progress: 100, raw: { controlled: true } };
}

function isExplicitLoadDatabase(environment: LoadTestEnvironment): boolean {
	if (
		!environment.DATABASE_URL ||
		environment.LOAD_TEST_DATABASE_URL !== environment.DATABASE_URL
	) {
		return false;
	}
	let database: URL;
	try {
		database = new URL(environment.DATABASE_URL);
	} catch {
		return false;
	}
	if (!["postgres:", "postgresql:"].includes(database.protocol)) return false;
	const databaseName = decodeURIComponent(database.pathname.slice(1));
	if (!/(^|[_-])(test|testing|load|staging)([_-]|$)/i.test(databaseName)) return false;
	if (LOOPBACK_HOSTS.has(database.hostname)) return true;
	return (
		environment.LOAD_TEST_REMOTE_DATABASE_ENABLED === "true" &&
		environment.LOAD_TEST_DATABASE_NAME_CONFIRMATION === databaseName
	);
}

function isHighEntropyToken(value: string | undefined): value is string {
	if (!value || value.length < TOKEN_MINIMUM_LENGTH || value.length > TOKEN_MAXIMUM_LENGTH)
		return false;
	if (!/^[\x21-\x7e]+$/.test(value)) return false;
	return new Set(value).size >= 12;
}

function constantTimeTokenMatches(provided: string, expected: string): boolean {
	const actualDigest = createHash("sha256").update(provided).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(actualDigest, expectedDigest);
}

function readBearerToken(value: string | undefined): string {
	const match = /^Bearer ([\x21-\x7e]+)$/.exec(value ?? "");
	return match?.[1] ?? "";
}

async function readBoundedBody(
	request: Request,
	maximumBytes: number,
): Promise<{ ok: true; value: string } | { ok: false }> {
	const declaredBytes = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) return { ok: false };
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > maximumBytes) return { ok: false };
	return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

function parseRequest(value: string) {
	try {
		return requestSchema.safeParse(JSON.parse(value));
	} catch {
		return requestSchema.safeParse(null);
	}
}

function boundedInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number | null {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedBigInt(
	value: string | undefined,
	fallback: bigint,
	minimum: bigint,
	maximum: bigint,
): bigint | null {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value)) return null;
	const parsed = BigInt(value);
	return parsed >= minimum && parsed <= maximum ? parsed : null;
}

function unavailable(context: Context): Response {
	return context.json({ code: "NOT_FOUND" }, 404, noStoreHeaders());
}

function noStoreHeaders(): Record<string, string> {
	return { "Cache-Control": "no-store, max-age=0" };
}

function retryHeaders(seconds: number): Record<string, string> {
	return { ...noStoreHeaders(), "Retry-After": String(seconds) };
}

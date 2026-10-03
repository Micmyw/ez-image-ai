/** Isolated LOCAL integration driver. Never imported by an app or deployment entry.
 * PostgreSQL, S3 and final Worker artifact are real. Only external supplier HTTP
 * responses (including their DNS/CDN) are fixtures. All other egress is rejected.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = path.join(root, "apps/workflows");
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const parsedDb = new URL(databaseUrl);
assert.equal(parsedDb.hostname, "127.0.0.1");
assert.equal(parsedDb.port, "55432");
assert.match(parsedDb.pathname, /scanless_[a-z0-9_]*test$/);
const secret = "scanless-local-only-32-character-secret";
const origin = "http://127.0.0.1:9560";
const delay = Number(process.env.SCANLESS_REVIEW_DELAY_MS ?? 3500);
const label = process.env.SCANLESS_LABEL ?? "new-idle-delayed";
const maintenanceBusy = process.env.SCANLESS_MAINTENANCE_BUSY === "true";
const output = path.resolve(process.env.SCANLESS_ARTIFACT ?? path.join(app, "dist-workers"));
const env = {
	RESEND_API_KEY: "re_isolated_fixture",
	NODE_ENV: "production",
	DATABASE_URL: databaseUrl,
	BETTER_AUTH_SECRET: secret,
	NEXT_PUBLIC_SAAS_URL: origin,
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_RECOVERY_PROVIDERS: "kie",
	KIE_API_KEY: "isolated-fixture",
	SEEAPI_API_KEY: "isolated-fixture",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_TEXT_WAFFO_ENABLED: "true",
	MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
	S3_ENDPOINT: "http://127.0.0.1:9540",
	S3_REGION: "us-east-1",
	S3_ACCESS_KEY_ID: "scanless",
	S3_SECRET_ACCESS_KEY: "scanless-local-only",
	MEDIA_BUCKET_NAME: "scanless-private",
	WORKFLOWS_DISPATCH_URL: "http://127.0.0.1:9561/internal/dispatch",
	WORKFLOWS_DISPATCH_SECRET: secret,
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};
Object.assign(process.env, env);
// The application URL must be HTTPS in production; the private loopback dispatcher
// is used by this local driver only. Keep the Worker itself in production mode.
process.env.NODE_ENV = "test";
const nativeFetch = globalThis.fetch;
const observations: Array<Record<string, unknown>> = [];
const mark = (stage: string, data: Record<string, unknown> = {}) =>
	observations.push({ stage, at: Date.now(), ...data });
const reviews = new Map<string, { readyAt: number; role: string }>();
const generations = new Map<string, { readyAt: number }>();
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
	"base64",
);
let callbackHandler: (request: Request) => Promise<Response>;
const outputBytes = Number(process.env.SCANLESS_OUTPUT_BYTES ?? png.length);
assert(
	Number.isSafeInteger(outputBytes) && outputBytes >= png.length && outputBytes <= 10 * 1024 * 1024,
);
const outputPng = Buffer.alloc(outputBytes);
png.copy(outputPng);
let occupyMaintenance: () => Promise<void> = async () => undefined;
const timers = new Set<ReturnType<typeof setTimeout>>();
const pending = new Set<Promise<void>>();
const backgroundErrors: unknown[] = [];
function schedule(operation: () => Promise<void>, milliseconds: number) {
	const timer = setTimeout(() => {
		timers.delete(timer);
		const task = operation()
			.catch((error) => {
				backgroundErrors.push(error);
				console.error(error);
			})
			.finally(() => pending.delete(task));
		pending.add(task);
	}, milliseconds);
	timers.add(timer);
}
async function supplier(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.hostname === "cloudflare-dns.com")
		return Response.json({
			Status: 0,
			Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [],
		});
	if (url.hostname === "tempfile.aiquickdraw.com") {
		mark("supplier.output.download");
		return new Response(outputPng, {
			headers: { "Content-Type": "image/png", "Content-Length": String(outputPng.length) },
		});
	}
	if (url.hostname === "api.waffo.ai") {
		mark("waffo.start");
		await new Promise((r) => setTimeout(r, 100));
		mark("waffo.end");
		return Response.json({
			data: {
				action: "allow",
				reasonCode: "allowed",
				requestId: randomUUID(),
				semanticStatus: "scored",
				matchedCategories: [],
			},
		});
	}
	if (url.hostname === "api.seeapi.com") {
		let id: string;
		if (request.method === "POST") {
			const body = (await request.json()) as { input: { image_url: string } };
			// Assert that the review can really read the exact private S3 object.
			const asset = await nativeFetch(body.input.image_url);
			assert(asset.ok);
			id = randomUUID();
			const role = body.input.image_url.includes("temporary") ? "input" : "output";
			assert.deepEqual(Buffer.from(await asset.arrayBuffer()), role === "input" ? png : outputPng);
			reviews.set(id, { role, readyAt: Date.now() + delay });
			mark("seeapi.submit", { id, role, readyAt: reviews.get(id)!.readyAt });
		} else id = url.pathname.split("/").at(-1)!;
		const task = reviews.get(id)!;
		assert(task);
		const done = Date.now() >= task.readyAt;
		if (request.method !== "POST")
			mark("seeapi.query", { id, role: task.role, done, readyAt: task.readyAt });
		return Response.json({
			id,
			object: "inference",
			model: "nsfw-filter",
			endpoint: "image-moderation",
			provider: "seeapi",
			status: done ? "succeeded" : "processing",
			error: null,
			result: done
				? { type: "json", data: { flagged: false, categories: { nsfw: [], special_care: [] } } }
				: null,
		});
	}
	if (url.hostname === "api.kie.ai") {
		if (request.method === "POST") {
			const body = (await request.json()) as {
				callBackUrl?: string;
				input?: { image_urls?: string[] };
			};
			for (const imageUrl of body.input?.image_urls ?? []) {
				const asset = await nativeFetch(imageUrl);
				assert(asset.ok);
				assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
			}
			const id = randomUUID();
			const readyAt = Date.now() + 1500;
			generations.set(id, { readyAt });
			mark("kie.accepted", { id, readyAt });
			if (maintenanceBusy) schedule(occupyMaintenance, 1200);
			if (body.callBackUrl) {
				schedule(
					async () => {
						mark("kie.completed", { id });
						const response = await callbackHandler(
							new Request(body.callBackUrl!, {
								method: "POST",
								body: JSON.stringify({ data: { taskId: id } }),
							}),
						);
						mark("kie.callback.returned", { status: response.status });
					},
					Math.max(0, readyAt - Date.now()),
				);
			}
			return Response.json({ code: 200, data: { taskId: id } });
		}
		const id = url.searchParams.get("taskId")!;
		const task = generations.get(id)!;
		assert(task);
		const done = Date.now() >= task.readyAt;
		mark("kie.query", { id, done });
		return Response.json({
			code: 200,
			data: {
				taskId: id,
				state: done ? "success" : "waiting",
				resultJson: done
					? JSON.stringify({ resultUrls: ["https://tempfile.aiquickdraw.com/scanless.png"] })
					: null,
			},
		});
	}
	throw new Error(`UNAPPROVED_EGRESS:${url.hostname}`);
}
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.hostname === "127.0.0.1" && ["9540", "9560", "9561"].includes(url.port))
		return nativeFetch(request);
	return supplier(request);
};
const cleanup: Array<() => void | Promise<void>> = [];
let server: ReturnType<typeof createServer> | undefined;
let browser:
	| {
			close(): Promise<void>;
			newPage(): Promise<{
				goto(url: string): Promise<unknown>;
				click(selector: string): Promise<void>;
			}>;
	  }
	| undefined;
try {
	const wr = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
	const { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
	const wasm = (await readdir(output)).filter((f) => f.endsWith(".wasm"));
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port: 9561,
			workers: [
				{
					name: "driver",
					compatibilityDate: "2026-09-10",
					modules: true,
					script: `export default { fetch(request, env) { if (new URL(request.url).pathname === '/internal/execute') return env.EXECUTOR.get(env.EXECUTOR.idFromName('jobs-maintenance')).fetch(request); return env.ENTRY.fetch(request); } };`,
					durableObjects: {
						EXECUTOR: { className: "WorkerJobs", scriptName: "jobs", useSQLite: true },
					},
					serviceBindings: { ENTRY: "jobs" },
				},
				{
					name: "jobs",
					compatibilityDate: "2026-09-10",
					compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
					modulesRoot: output,
					modules: [
						{ type: "ESModule", path: path.join(output, "workers.js") },
						...wasm.map((f) => ({ type: "CompiledWasm", path: path.join(output, f) })),
					],
					durableObjects: { JOBS_EXECUTOR: { className: "WorkerJobs", useSQLite: true } },
					workflows: { JOBS: { name: "isolated-scanless-jobs", className: "JobsWorkflow" } },
					hyperdrives: { HYPERDRIVE: databaseUrl },
					bindings: {
						...env,
						NEXT_PUBLIC_SAAS_URL: "https://isolated.invalid",
						WORKFLOWS_DISPATCH_URL: "https://isolated.invalid/internal/dispatch",
						EZPIC_RUNTIME: "workers",
						EZPIC_DATABASE_BINDING: "hyperdrive",
					},
					outboundService: async (request: Request) => {
						const url = new URL(request.url);
						if (url.hostname === "127.0.0.1" && url.port === "9540") {
							try {
								const response = await nativeFetch(request.url, {
									method: request.method,
									headers: Object.fromEntries(request.headers),
									...(["GET", "HEAD"].includes(request.method)
										? {}
										: { body: Buffer.from(await request.arrayBuffer()) }),
								});
								mark("storage.http", {
									method: request.method,
									path: url.pathname,
									status: response.status,
								});
								return response;
							} catch (e) {
								console.error("local-storage-error", String(e));
								throw e;
							}
						}
						return supplier(request);
					},
				},
			],
		}),
	);
	cleanup.push(() => runtime.dispose());
	const { db } = await import("@repo/database/client");
	cleanup.push(() => db.$disconnect());
	const { logger } = await import("../../../packages/logs/index");
	const logInfo = logger.info.bind(logger);
	logger.info = ((message: unknown, details: Record<string, unknown>) => {
		if (message === "media.flow.timing") mark("flow.timing", details);
		else logInfo(message, details);
	}) as typeof logger.info;
	cleanup.push(() => {
		logger.info = logInfo;
	});
	const database = await import("@repo/database");
	const storage = await import("@repo/storage");
	const { temporaryReferenceObjectKey } = await import("@repo/config");
	const { signTemporaryReference } =
		await import("../../../packages/api/modules/media/lib/temporary-reference-token");
	const { submitGeneration } =
		await import("../../../packages/api/modules/media/procedures/submit-generation");
	const { getJob } = await import("../../../packages/api/modules/media/procedures/get-job");
	const { call } = createRequire(path.join(root, "packages/api/package.json"))("@orpc/server");
	const { createKieCallbackHandler } =
		await import("../../../packages/api/modules/media/webhooks/kie-callback");
	callbackHandler = createKieCallbackHandler();
	const { S3Client, CreateBucketCommand, ListObjectsV2Command } = createRequire(
		path.join(root, "packages/storage/package.json"),
	)("@aws-sdk/client-s3");
	const s3 = new S3Client({
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		forcePathStyle: true,
		credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
	});
	cleanup.push(() => s3.destroy());
	await runtime.ready;
	await s3
		.send(new CreateBucketCommand({ Bucket: env.MEDIA_BUCKET_NAME }))
		.catch((e: { name: string }) => {
			if (!e.name.includes("BucketAlready")) throw e;
		});
	const ownerId = randomUUID();
	const now = new Date();
	if (maintenanceBusy) {
		// Real unrelated maintenance work waits on one deliberately held PostgreSQL row.
		// No scheduler sleeps/results or global tables are mocked or locked.
		const quote = await db.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: "contention-fixture",
				submittedByUserId: "contention-fixture",
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "fixture",
				pricingVersion: "fixture",
				credits: 1n,
				costMicros: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 86400000),
			},
		});
		const job = await db.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: "contention-fixture",
				submittedByUserId: "contention-fixture",
				quoteId: quote.id,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				inputSnapshot: {},
				pricingSnapshot: {},
				creditsReserved: 1n,
				idempotencyKey: randomUUID(),
				status: "PROVIDER_RUNNING",
			},
		});
		const attempt = await db.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "nano-banana-2-lite",
				providerTaskId: "contention-only",
				status: "RUNNING",
				requestSnapshot: {},
			},
		});
		const account = await db.creditAccount.create({
			data: { ownerType: "USER", ownerId: "contention-fixture" },
		});
		await db.creditReservation.create({
			data: { accountId: account.id, jobId: job.id, amount: 1n },
		});
		await db.outboxEvent.create({
			data: {
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				eventType: "GENERATION_CANCEL_REQUESTED",
				dedupeKey: `generation-cancel:${job.id}`,
				payload: { jobId: job.id },
				status: "PROCESSED",
			},
		});
		occupyMaintenance = async () => {
			const { Client } = createRequire(path.join(root, "packages/database/package.json"))("pg");
			const lock = new Client({ connectionString: databaseUrl });
			await lock.connect();
			try {
				await lock.query("BEGIN");
				await lock.query("SELECT id FROM generation_attempt WHERE id=$1 FOR UPDATE", [attempt.id]);
				mark("maintenance.locked");
				const body = JSON.stringify({
					request: { taskId: "media-cancel-generation", payload: { jobId: job.id, version: 0 } },
					context: { attempt: 1, maxAttempts: 5, runId: "controlled-maintenance" },
				});
				const timestamp = String(Date.now());
				const signature = createHmac("sha256", secret)
					.update(`POST\n/internal/execute\n${timestamp}\n${body}`)
					.digest("hex");
				const execution = nativeFetch("http://127.0.0.1:9561/internal/execute", {
					method: "POST",
					body,
					headers: { "x-jobs-timestamp": timestamp, "x-jobs-signature": signature },
				});
				await new Promise((r) => setTimeout(r, 3500));
				await lock.query("ROLLBACK");
				const response = await execution;
				mark("maintenance.released", { status: response.status });
				await response.arrayBuffer();
			} finally {
				await lock.end();
			}
		};
	}
	await db.user.create({
		data: {
			id: ownerId,
			email: `${ownerId}@scanless.invalid`,
			name: "Local integration",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	const account = await db.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await database.createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `fixture:${ownerId}` },
		db,
	);
	const plan = await db.billingPlan.create({
		data: {
			provider: "fixture",
			providerPriceId: ownerId,
			name: "creator",
			creditsPerPeriod: 700n,
			priceMicros: 19000000n,
			currency: "USD",
			metadata: { planId: "creator" },
		},
	});
	const end = new Date(now.getTime() + 86400000);
	const subscription = await db.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "fixture",
			providerSubscriptionId: ownerId,
			planId: plan.id,
			status: "ACTIVE",
			currentPeriodStart: now,
			currentPeriodEnd: end,
		},
	});
	await db.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: now,
			endsAt: end,
			status: "ACTIVE",
			paidAmount: plan.priceMicros,
			creditAmount: plan.creditsPerPeriod,
			providerInvoicePaymentId: ownerId,
		},
	});
	const token = randomUUID();
	await db.session.create({
		data: {
			id: randomUUID(),
			userId: ownerId,
			token,
			expiresAt: end,
			createdAt: now,
			updatedAt: now,
		},
	});
	const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
	const reference = {
		v: 1 as const,
		ownerId,
		assetId: randomUUID(),
		contentType: "image/png" as const,
		bytes: png.length,
		checksum: "",
		createdAt: now.toISOString(),
		expiresAt: end.toISOString(),
	};
	const reservation = await database.reserveTemporaryReference(
		{
			ownerId,
			assetId: reference.assetId,
			bytes: png.length,
			expiresAt: end,
			maximumBytes: 10000000n,
		},
		db,
	);
	const written = await storage.putTemporaryReferenceObject({
		bucket: "media",
		key: temporaryReferenceObjectKey(reference),
		contentType: "image/png",
		contentLength: png.length,
		body: new Response(png).body!,
	});
	reference.checksum = written.sha256;
	await database.finalizeStorageUsageReservation(reservation.id, "COMMITTED", db);
	const input = {
		productKey: "image-nano-banana-2-lite" as const,
		input: {
			kind: "image-to-image" as const,
			prompt: "A blue mountain landscape",
			sourceAssetId: reference.assetId,
			skuKey: "nano-banana-2-lite-1k" as const,
			aspectRatio: "auto" as const,
		},
		temporaryReferenceToken: signTemporaryReference(reference),
		expectedCredits: "5",
		idempotencyKey: randomUUID(),
	};
	let jobId: string | undefined;
	let resolveVisible: (value: Record<string, unknown>) => void;
	const visible = new Promise<Record<string, unknown>>((resolve) => {
		resolveVisible = resolve;
	});
	server = createServer(async (req, res) => {
		try {
			let body: unknown;
			if (req.url === "/start") {
				mark("click");
				const result = await call(submitGeneration, input, {
					context: { headers: new Headers({ cookie }), requestId: randomUUID() },
				});
				jobId = result.job.id;
				mark("admission.returned", { jobId });
				body = result;
			} else if (req.url === "/status") {
				body = await call(
					getJob,
					{ jobId },
					{ context: { headers: new Headers({ cookie }), requestId: randomUUID() } },
				);
			} else if (req.url === "/visible") {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				const data = JSON.parse(Buffer.concat(chunks).toString());
				mark("browser.visible", data);
				resolveVisible(data);
				body = { ok: true };
			} else {
				res.setHeader("Content-Type", "text/html");
				res.end(
					`<button id="start">Generate fixture</button><img id="image"><script>start.onclick=async()=>{const click=Date.now();await fetch('/start',{method:'POST'});for(;;){const state=await(await fetch('/status')).json();const asset=state.assets?.[0];if(asset?.preview?.url){const received=Date.now();image.src=asset.preview.url;await image.decode();const decoded=Date.now();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await fetch('/visible',{method:'POST',body:JSON.stringify({click,received,decoded,visible:Date.now()})});break;}await new Promise(r=>setTimeout(r,250));}}</script>`,
				);
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(body));
		} catch (error) {
			console.error(error);
			resolveVisible({ error: String(error), timeout: true });
			res.statusCode = 500;
			res.end(JSON.stringify({ error: String(error) }));
		}
	});
	await new Promise<void>((r) => server!.listen(9560, "127.0.0.1", r));
	const { chromium } = createRequire(path.join(root, "apps/saas/package.json"))("@playwright/test");
	browser = await chromium.launch({ headless: true });
	const page = await browser!.newPage();
	await page.goto(origin);
	await page.click("#start");
	const timeout = setTimeout(() => resolveVisible({ timeout: true }), 90000);
	timers.add(timeout);
	const browserTimes = await visible;
	clearTimeout(timeout);
	timers.delete(timeout);
	assert(!browserTimes.timeout, "NO_VISIBLE_OUTPUT_WITH_SCANNER_DISABLED");
	// Settlement runs independently after READY; wait only for the accounting assertion.
	for (let i = 0; i < 60; i++) {
		if ((await db.generationJob.findUniqueOrThrow({ where: { id: jobId } })).status === "SUCCEEDED")
			break;
		await new Promise((r) => setTimeout(r, 250));
	}
	const job = await db.generationJob.findUniqueOrThrow({
		where: { id: jobId },
		include: { attempts: true, reservation: true, assets: { include: { asset: true } } },
	});
	assert.equal(job.attempts.length, 1);
	assert.equal(generations.size, 1);
	assert.equal(job.status, "SUCCEEDED");
	assert.equal(reviews.size, 2);
	const ledger = await db.creditLedgerEntry.findMany({
		where: { reservationId: job.reservation!.id },
		select: { type: true, amount: true, referenceKey: true },
		orderBy: { createdAt: "asc" },
	});
	assert.equal(ledger.filter((entry) => entry.type === "RESERVE").length, 1);
	assert.equal(ledger.filter((entry) => entry.type === "SETTLE").length, 1);
	assert.equal(job.reservation!.settledAmount, 5n);
	await Promise.all(pending);
	assert.equal(backgroundErrors.length, 0, "BACKGROUND_FIXTURE_FAILURE");
	if (maintenanceBusy)
		assert(
			observations.some((o) => o.stage === "maintenance.released" && o.status === 200),
			"MAINTENANCE_DID_NOT_RUN",
		);
	const objects = await s3.send(
		new ListObjectsV2Command({ Bucket: env.MEDIA_BUCKET_NAME, Prefix: `users/${ownerId}/` }),
	);
	const asset = job.assets.find((a) => a.role === "OUTPUT")!.asset;
	const report = {
		label,
		outputBytes,
		artifactSha256: createHash("sha256")
			.update(await readFile(path.join(output, "workers.js")))
			.digest("hex"),
		ledger: ledger.map((entry) => ({ ...entry, amount: entry.amount.toString() })),
		maintenanceBusy,
		environment:
			"local workerd Workflow + WorkerJobs + PostgreSQL + MinIO; supplier HTTP only fixed-time fixtures",
		scanner: "not scheduled",
		browserTimes,
		observations,
		job: {
			id: jobId,
			status: job.status,
			attempts: job.attempts.length,
			settlement: String(job.reservation?.settledAmount),
			finalizationAttempts: job.finalizationRetryCount,
			assetReadyObservedUpdatedAt: asset.updatedAt,
		},
		objectKeys: objects.Contents?.map((o: { Key: string }) => o.Key),
	};
	const dir = path.join(root, ".cache/first-image");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, `${label}.json`), JSON.stringify(report, null, 2));
	console.log(
		"SCANLESS_RESULT",
		JSON.stringify({
			label,
			clickToVisible: Number(browserTimes.visible) - Number(browserTimes.click),
			attempts: job.attempts.length,
			reviews: reviews.size,
			objects: objects.KeyCount,
		}),
	);
} finally {
	for (const timer of timers) clearTimeout(timer);
	await Promise.all(pending);
	await browser?.close();
	server?.closeAllConnections();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	for (const dispose of cleanup.reverse()) await dispose();
	globalThis.fetch = nativeFetch;
}

import { expect, test } from "@playwright/test";
import pg from "pg";

import { captureConsentedGrowthEvents } from "./growth-events";

const pool = new pg.Pool({ connectionString: requiredEnvironment("TEST_DATABASE_URL") });

const runId = requiredEnvironment("E2E_RUN_ID");
const fundedEmail = `media-e2e-funded-${runId}@example.test`;
const emptyEmail = `media-e2e-empty-${runId}@example.test`;

if (process.env.E2E_TEST_MEDIA_ADAPTERS !== "true") {
	throw new Error("E2E_TEST_MEDIA_ADAPTERS=true is required; core scenarios never skip");
}

test.describe("creator workspace through real oRPC, database, storage, and local Outbox pump", () => {
	test.describe.configure({ timeout: 90_000 });
	test.afterAll(async () => pool.end());

	test("successful edit is idempotent and shows the job-bound before, after, and private download", async ({
		page,
	}, testInfo) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const prompt = marker("duplicate", "A ceramic lamp on a quiet desk", testInfo.retry);
		await openCreator(page, prompt, fundedEmail);
		await page.getByRole("button", { name: /review credits/i }).click();
		await page.getByRole("button", { name: /start edit/i }).dblclick();
		const job = await waitForJob(prompt, "SUCCEEDED");
		const user = await userByEmail(fundedEmail);
		expect(await jobsForPrompt(user.id, prompt)).toHaveLength(1);
		expect(
			await count(`SELECT count(*) FROM credit_reservation WHERE "jobId" = $1`, [job.id]),
		).toBe(1);
		expect(
			await count(`SELECT count(*) FROM outbox_event WHERE "dedupeKey" = $1`, [
				`job:${job.id}:created`,
			]),
		).toBe(1);
		await expect(page.getByText(job.id)).toBeVisible();
		await expect(page.getByRole("heading", { name: /your edit is ready/i })).toBeVisible({
			timeout: 30_000,
		});
		const originalPreviewUrl = await page
			.getByRole("img", { name: /original source image/i })
			.getAttribute("src");
		const comparison = page.getByRole("slider", {
			name: /compare original and edited image/i,
		});
		await expect(comparison).toBeVisible();
		await comparison.focus();
		await page.keyboard.press("End");
		await expect(comparison).toHaveValue("100");
		await page.getByRole("button", { name: /show result/i }).click();
		await expect(comparison).toHaveValue("0");
		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: /^download$/i }).click();
		expect((await download).suggestedFilename()).toBeTruthy();

		const editAgain = page.getByRole("link", { name: /edit again/i });
		await expect(editAgain).toHaveAttribute(
			"href",
			new RegExp(`/create\\?asset=.*&parentJob=${job.id}`),
		);
		await editAgain.click();
		await expect(page).toHaveURL(/\/create\?asset=/);
		const reusedSource = page.getByRole("img", { name: /selected source image/i });
		await expect(reusedSource).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => reusedSource.getAttribute("src")).not.toBe(originalPreviewUrl);
		await expect
			.poll(() => growthEvents.map(({ name }) => name))
			.toEqual([
				"editor_quote_created",
				"editor_generation_confirmed",
				"editor_generation_succeeded",
				"result_compared",
				"result_downloaded",
				"edit_again_started",
			]);
		const serializedGrowthEvents = JSON.stringify(growthEvents);
		expect(serializedGrowthEvents).not.toContain(prompt);
		expect(serializedGrowthEvents).not.toContain(job.id);
		expect(serializedGrowthEvents).not.toMatch(
			/assetId|signed|https?:|provider|model|cost|email|token/i,
		);
	});

	test("creates a second edit and branches again from the older successful version", async ({
		page,
	}, testInfo) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const rootPrompt = marker("session-root", "A warm editorial background", testInfo.retry);
		await createScenario(page, rootPrompt);
		const rootJob = await waitForJob(rootPrompt, "SUCCEEDED");
		const rootVersion = await editVersion(rootJob.id);
		expect(rootVersion.editSessionId).toBeTruthy();
		expect(rootVersion.parentJobId).toBeNull();

		await page.goto(`/edits/${rootVersion.editSessionId}`);
		await expect(page.getByText(rootPrompt)).toBeVisible();
		await expect(page.getByText(/standard edit/i)).toBeVisible();
		await expect(page.getByText(/5 credits/i)).toBeVisible();
		const rootCard = page.getByRole("listitem").filter({ hasText: rootPrompt });
		await rootCard.getByRole("link", { name: /edit again/i }).click();
		await expect(page).toHaveURL(
			new RegExp(`/create\\?asset=${rootVersion.outputAssetId}&parentJob=${rootJob.id}`),
		);

		const childPrompt = marker("session-child", "Add a soft shadow", testInfo.retry);
		await page.getByLabel(/edit instruction/i).fill(childPrompt);
		await page.getByRole("button", { name: /review credits/i }).click();
		await page.getByRole("button", { name: /start edit/i }).click();
		const childJob = await waitForJob(childPrompt, "SUCCEEDED");
		const childVersion = await editVersion(childJob.id);
		expect(childVersion.editSessionId).toBe(rootVersion.editSessionId);
		expect(childVersion.parentJobId).toBe(rootJob.id);

		await page.goto(`/edits/${rootVersion.editSessionId}`);
		await expect(page.getByText(childPrompt)).toBeVisible();
		await rootCard.getByRole("link", { name: /edit again/i }).click();
		const branchPrompt = marker("session-branch", "Try a cooler background", testInfo.retry);
		await page.getByLabel(/edit instruction/i).fill(branchPrompt);
		await page.getByRole("button", { name: /review credits/i }).click();
		await page.getByRole("button", { name: /start edit/i }).click();
		const branchJob = await waitForJob(branchPrompt, "SUCCEEDED");
		const branchVersion = await editVersion(branchJob.id);

		expect(branchVersion.editSessionId).toBe(rootVersion.editSessionId);
		expect(branchVersion.parentJobId).toBe(rootJob.id);
		expect(
			new Set([rootVersion.quoteId, childVersion.quoteId, branchVersion.quoteId]),
		).toHaveProperty("size", 3);
		expect(
			new Set([
				rootVersion.idempotencyKey,
				childVersion.idempotencyKey,
				branchVersion.idempotencyKey,
			]),
		).toHaveProperty("size", 3);
		expect(
			await count(`SELECT count(*) FROM credit_reservation WHERE "jobId" = ANY($1::text[])`, [
				[rootJob.id, childJob.id, branchJob.id],
			]),
		).toBe(3);
		expect(
			await count(`SELECT count(*) FROM outbox_event WHERE "dedupeKey" = ANY($1::text[])`, [
				[rootJob.id, childJob.id, branchJob.id].map((jobId) => `job:${jobId}:created`),
			]),
		).toBe(3);

		await page.goto(`/edits/${rootVersion.editSessionId}`);
		await expect(page.locator("ol > li")).toHaveCount(3);
		await expect(page.getByText(branchPrompt)).toBeVisible();
		await expect.poll(() => growthEvents.map(({ name }) => name)).toContain("edit_session_opened");
		expect(growthEvents.map(({ name }) => name)).toContain("edit_again_started");
	});

	test("insufficient credits creates no quote, job, reservation, or ledger entry", async ({
		page,
	}, testInfo) => {
		const prompt = marker("insufficient", "A long cinematic sequence", testInfo.retry);
		const user = await userByEmail(emptyEmail);
		const before = await count(
			`SELECT count(*) FROM credit_ledger_entry l JOIN credit_account a ON a.id=l."accountId" WHERE a."ownerId"=$1`,
			[user.id],
		);
		await openCreator(page, prompt, emptyEmail);
		await page.getByRole("button", { name: /review credits/i }).click();
		await expect(page.getByRole("alert")).toBeVisible();
		expect(await jobsForPrompt(user.id, prompt)).toHaveLength(0);
		expect(
			await count(
				`SELECT count(*) FROM generation_quote WHERE "ownerId"=$1 AND "inputSnapshot"->>'prompt'=$2`,
				[user.id, prompt],
			),
		).toBe(0);
		expect(
			await count(
				`SELECT count(*) FROM credit_ledger_entry l JOIN credit_account a ON a.id=l."accountId" WHERE a."ownerId"=$1`,
				[user.id],
			),
		).toBe(before);
	});

	test("valid upload becomes READY and invalid signature is deleted with its storage reservation released", async ({
		page,
	}) => {
		const renderPhaseUpdateWarnings: string[] = [];
		page.on("console", (message) => {
			if (message.text().includes("Cannot update a component")) {
				renderPhaseUpdateWarnings.push(message.text());
			}
		});
		const user = await userByEmail(fundedEmail);
		await page.goto("/create");
		const before = new Set(
			(await rows<{ id: string }>(`SELECT id FROM media_asset WHERE "ownerId"=$1`, [user.id])).map(
				(asset) => asset.id,
			),
		);
		await uploadFile(page, `${runId}-valid.png`, validPng());
		const validAsset = await waitForNewAsset(user.id, before, "READY");
		expect(validAsset.status).toBe("READY");

		const beforeInvalid = new Set(
			(await rows<{ id: string }>(`SELECT id FROM media_asset WHERE "ownerId"=$1`, [user.id])).map(
				(asset) => asset.id,
			),
		);
		await uploadFile(page, `${runId}-invalid-signature.png`, Buffer.alloc(validPng().length, 0x41));
		const invalidAsset = await waitForNewAsset(user.id, beforeInvalid, "DELETED");
		const session = (
			await rows<{ id: string; status: string }>(
				`SELECT id, status FROM media_upload_session WHERE "assetId"=$1`,
				[invalidAsset.id],
			)
		)[0];
		expect(session?.status).toBe("ABORTED");
		const reservation = (
			await rows<{ status: string }>(
				`SELECT status FROM storage_usage_reservation WHERE "referenceKey"=$1`,
				[`media-upload:${session!.id}`],
			)
		)[0];
		expect(reservation?.status).toBe("ACTIVE");
		const cleanupDedupeKey = `media-upload-finalization-failure-cleanup:${session!.id}`;
		const cleanup = (
			await rows<{ status: string; availableAt: Date; createdAt: Date }>(
				`SELECT status, "availableAt", "createdAt" FROM outbox_event WHERE "dedupeKey"=$1`,
				[cleanupDedupeKey],
			)
		)[0];
		expect(cleanup?.status).toBe("PENDING");
		expect(cleanup!.availableAt.getTime()).toBeGreaterThan(cleanup!.createdAt.getTime());
		await pool.query(`UPDATE outbox_event SET "availableAt"=now() WHERE "dedupeKey"=$1`, [
			cleanupDedupeKey,
		]);
		await expect
			.poll(async () =>
				count(
					`SELECT count(*) FROM outbox_event WHERE "dedupeKey"=$1 AND "processedAt" IS NOT NULL`,
					[cleanupDedupeKey],
				),
			)
			.toBe(1);
		await expect
			.poll(
				async () =>
					(
						await rows<{ status: string }>(
							`SELECT status FROM storage_usage_reservation WHERE "referenceKey"=$1`,
							[`media-upload:${session!.id}`],
						)
					)[0]?.status,
			)
			.toBe("RELEASED");
		expect(renderPhaseUpdateWarnings).toEqual([]);
	});

	async function uploadFile(page: import("@playwright/test").Page, name: string, buffer: Buffer) {
		await page
			.getByLabel(/upload source images/i)
			.locator('input[type="file"]')
			.setInputFiles({
				name,
				mimeType: "image/png",
				buffer,
			});
	}

	async function waitForNewAsset(userId: string, before: Set<string>, status: "READY" | "DELETED") {
		await expect
			.poll(
				async () => {
					const asset = (
						await rows<{ status: string }>(
							`SELECT status FROM media_asset WHERE "ownerId"=$1 AND NOT (id = ANY($2::text[])) ORDER BY "createdAt" DESC LIMIT 1`,
							[userId, [...before]],
						)
					)[0];
					return asset?.status;
				},
				{ timeout: 45_000 },
			)
			.toBe(status);
		return (
			await rows<{ id: string; status: string }>(
				`SELECT id, status FROM media_asset WHERE "ownerId"=$1 AND NOT (id = ANY($2::text[])) ORDER BY "createdAt" DESC LIMIT 1`,
				[userId, [...before]],
			)
		)[0]!;
	}

	test("provider failure settles the exact job at zero charge", async ({ page }, testInfo) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const prompt = marker("provider-failure", "Provider failure", testInfo.retry);
		await createScenario(page, prompt);
		const job = await waitForJob(prompt, "FAILED");
		const reservation = await reservationFor(job.id);
		expect(job.failureCode).toBe("NO_USABLE_OUTPUT");
		expect(reservation.settledAmount).toBe("0");
		expect(reservation.releasedAmount).toBe(job.creditsReserved);
		await expect(page.getByRole("heading", { name: /could not finish/i })).toBeVisible();
		await expect(page.getByText(/all 4 of 4 reserved credits were returned/i)).toBeVisible();
		await expect
			.poll(() => growthEvents.map(({ name }) => name))
			.toContain("editor_generation_failed");
		expect(growthEvents.map(({ name }) => name)).not.toContain("editor_generation_succeeded");
	});

	test("moderation rejection quarantines the exact output and charges zero", async ({
		page,
	}, testInfo) => {
		const prompt = marker("moderation-rejection", "Unsafe output fixture", testInfo.retry);
		await createScenario(page, prompt);
		const job = await waitForJob(prompt, "FAILED");
		const bindings = await rows<{ assetId: string; status: string; moderationStatus: string }>(
			`SELECT b."assetId", a.status, m.status AS "moderationStatus" FROM generation_job_asset b JOIN media_asset a ON a.id=b."assetId" LEFT JOIN asset_moderation_result m ON m."assetId"=a.id WHERE b."jobId"=$1 AND b.role='OUTPUT'`,
			[job.id],
		);
		expect(bindings).toHaveLength(1);
		expect(bindings[0]!.status).toBe("QUARANTINED");
		expect(bindings[0]!.moderationStatus).toBe("REJECTED");
		const reservation = await reservationFor(job.id);
		expect(reservation.settledAmount).toBe("0");
		await expect(page.getByText(/could not pass the safety review/i)).toBeVisible({
			timeout: 30_000,
		});
		await page.goto("/assets");
		await expect(page.locator(`[data-asset-id="${bindings[0]!.assetId}"]`)).toHaveCount(0);
	});

	test("refresh follows the same in-flight job through success", async ({ page }, testInfo) => {
		const prompt = marker("delayed-success", "Refresh recovery", testInfo.retry);
		const jobId = await createScenario(page, prompt);
		await expect(page).toHaveURL(new RegExp(`/create\\?job=${jobId}`));
		await page.reload();
		await expect(page.getByText(jobId)).toBeVisible({ timeout: 30_000 });
		const job = await waitForJob(prompt, "SUCCEEDED");
		expect(job.id).toBe(jobId);
		await expect(page.getByRole("heading", { name: /edit is ready/i })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("cancellation releases all reserved credits for the exact job", async ({
		page,
	}, testInfo) => {
		const prompt = marker("cancel-pending", "Cancel this generation", testInfo.retry);
		const jobId = await createScenario(page, prompt);
		await expect
			.poll(() => providerCancellationReadiness(jobId), { timeout: 30_000 })
			.toBe("PROVIDER_PENDING:SUBMITTED:false:task-bound");
		await page.getByRole("button", { name: /cancel/i }).click();
		await expect
			.poll(
				async () =>
					(
						await rows<{ status: string }>(`SELECT status FROM generation_job WHERE id=$1`, [jobId])
					)[0]?.status,
			)
			.toBe("CANCELED");
		await expect
			.poll(async () => {
				const reservation = (
					await rows<Reservation>(
						`SELECT status, "settledAmount", "releasedAmount" FROM credit_reservation WHERE "jobId"=$1`,
						[jobId],
					)
				)[0];
				return reservation
					? `${reservation.status}:${reservation.settledAmount}:${reservation.releasedAmount}`
					: "missing";
			})
			.toBe("SETTLED:0:4");
		await expect(page.getByRole("heading", { name: /edit was canceled/i })).toBeVisible();
		await expect(page.getByText(/all 4 of 4 reserved credits were returned/i)).toBeVisible();
	});

	test("reuse binds the seeded READY asset into the new job", async ({ page }, testInfo) => {
		const user = await userByEmail(fundedEmail);
		const asset = (
			await rows<{ id: string }>(
				`SELECT id FROM media_asset WHERE "ownerId"=$1 AND "sourceUrl"=$2 AND status='READY'`,
				[user.id, `e2e-seed:${runId}`],
			)
		)[0]!;
		await page.goto("/assets");
		const card = page.locator(`[data-asset-id="${asset.id}"]`);
		await card.getByRole("link", { name: /reuse/i }).click();
		await expect(page).toHaveURL(new RegExp(`/create\\?asset=${asset.id}`));
		const prompt = marker("reuse", "Turn the reference into a watercolor scene", testInfo.retry);
		await page.getByLabel(/edit instruction/i).fill(prompt);
		await page.getByRole("button", { name: /review credits/i }).click();
		await expect(page.getByText(/ready to edit/i)).toBeVisible();
		await page.getByRole("button", { name: /start edit/i }).click();
		const job = await waitForJob(prompt, "SUCCEEDED");
		const binding = (
			await rows<{ assetId: string }>(
				`SELECT "assetId" FROM generation_job_asset WHERE "jobId"=$1 AND "assetId"=$2 AND role='INPUT'`,
				[job.id, asset.id],
			)
		)[0];
		expect(binding?.assetId).toBe(asset.id);
	});

	test("mobile editor keeps the required source, prompt, modes, and review action keyboard accessible", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openCreator(page, marker("mobile", "Warm the evening light", 0), fundedEmail);

		await expect(page.getByRole("img", { name: /selected source image/i })).toBeVisible();
		await expect(page.getByRole("radiogroup", { name: /edit mode/i })).toBeVisible();
		const quality = page.getByRole("radio", { name: /quality edit/i });
		await quality.focus();
		await page.keyboard.press("Space");
		await expect(quality).toBeChecked();
		await expect(page.getByRole("button", { name: /review credits/i })).toBeEnabled();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
});

async function openCreator(page: import("@playwright/test").Page, prompt: string, email: string) {
	const user = await userByEmail(email);
	const source = (
		await rows<{ id: string }>(
			`SELECT id FROM media_asset WHERE "ownerId"=$1 AND "sourceUrl"=$2 AND status='READY' AND "deletedAt" IS NULL`,
			[user.id, `e2e-seed:${runId}`],
		)
	)[0];
	if (!source) throw new Error(`Seed source image missing for ${email}`);
	await page.goto(`/create?asset=${source.id}`);
	await page.getByLabel(/edit instruction/i).fill(prompt);
}

async function createScenario(
	page: import("@playwright/test").Page,
	prompt: string,
): Promise<string> {
	await openCreator(page, prompt, fundedEmail);
	await page.getByRole("button", { name: /review credits/i }).click();
	await expect(page.getByText(/ready to edit/i)).toBeVisible();
	await page.getByRole("button", { name: /start edit/i }).click();
	const user = await userByEmail(fundedEmail);
	const job = await expect
		.poll(async () => (await jobsForPrompt(user.id, prompt))[0] ?? null)
		.not.toBeNull()
		.then(async () => (await jobsForPrompt(user.id, prompt))[0]!);
	await expect(page.getByText(job.id)).toBeVisible();
	return job.id;
}

async function waitForJob(prompt: string, status: "SUCCEEDED" | "FAILED") {
	const user = await userByEmail(fundedEmail);
	await expect
		.poll(async () => (await jobsForPrompt(user.id, prompt))[0]?.status, { timeout: 30_000 })
		.toBe(status);
	return (await jobsForPrompt(user.id, prompt))[0]!;
}

async function jobsForPrompt(userId: string, prompt: string) {
	return rows<Job>(
		`SELECT id, status, "failureCode", "creditsReserved" FROM generation_job WHERE "ownerId"=$1 AND "inputSnapshot"->>'prompt'=$2 ORDER BY "createdAt" DESC`,
		[userId, prompt],
	);
}

async function editVersion(jobId: string) {
	const version = (
		await rows<{
			editSessionId: string | null;
			parentJobId: string | null;
			quoteId: string;
			idempotencyKey: string;
			outputAssetId: string;
		}>(
			`SELECT j."editSessionId", j."parentJobId", j."quoteId", j."idempotencyKey", b."assetId" AS "outputAssetId"
			 FROM generation_job j
			 JOIN generation_job_asset b ON b."jobId"=j.id AND b.role='OUTPUT'
			 WHERE j.id=$1
			 ORDER BY b.position ASC
			 LIMIT 1`,
			[jobId],
		)
	)[0];
	if (!version) throw new Error(`Edit version missing for ${jobId}`);
	return version;
}

async function providerCancellationReadiness(jobId: string): Promise<string> {
	const state = (
		await rows<{
			jobStatus: string;
			attemptStatus: string;
			uncertainSubmission: boolean;
			providerTaskId: string | null;
		}>(
			`SELECT j.status AS "jobStatus", a.status AS "attemptStatus", a."uncertainSubmission", a."providerTaskId" FROM generation_job j JOIN generation_attempt a ON a."jobId"=j.id WHERE j.id=$1 ORDER BY a."attemptNumber" DESC LIMIT 1`,
			[jobId],
		)
	)[0];
	return state
		? `${state.jobStatus}:${state.attemptStatus}:${state.uncertainSubmission}:${state.providerTaskId ? "task-bound" : "task-missing"}`
		: "missing";
}

async function userByEmail(email: string) {
	const user = (await rows<{ id: string }>(`SELECT id FROM "user" WHERE email=$1`, [email]))[0];
	if (!user) throw new Error(`Seed user missing: ${email}`);
	return user;
}

interface Job {
	id: string;
	status: string;
	failureCode: string | null;
	creditsReserved: string;
}
interface Reservation {
	status: string;
	settledAmount: string;
	releasedAmount: string;
}

async function reservationFor(jobId: string): Promise<Reservation> {
	const reservation = (
		await rows<Reservation>(
			`SELECT status, "settledAmount", "releasedAmount" FROM credit_reservation WHERE "jobId"=$1`,
			[jobId],
		)
	)[0];
	if (!reservation) throw new Error(`Reservation missing for ${jobId}`);
	return reservation;
}

async function rows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
	return (await pool.query(sql, values)).rows as T[];
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
	return Number((await rows<{ count: string }>(sql, values))[0]?.count ?? 0);
}

function marker(scenario: string, text: string, retry: number): string {
	return `[e2e:${scenario}] [run:${runId}] [retry:${retry}] ${text}`;
}

function validPng(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	);
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for media E2E`);
	return value;
}

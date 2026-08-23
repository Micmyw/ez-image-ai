import { expect, test } from "@playwright/test";
import pg from "pg";

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

	test("duplicate click creates exactly one job and one reservation", async ({ page }) => {
		const prompt = marker("duplicate", "A ceramic lamp on a quiet desk");
		await openCreator(page, prompt);
		await page.getByRole("button", { name: /review credits/i }).click();
		await page.getByRole("button", { name: /start creating/i }).dblclick();
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
	});

	test("insufficient credits creates no quote, job, reservation, or ledger entry", async ({
		page,
	}) => {
		const prompt = marker("insufficient", "A long cinematic sequence");
		const user = await userByEmail(emptyEmail);
		const before = await count(
			`SELECT count(*) FROM credit_ledger_entry l JOIN credit_account a ON a.id=l."accountId" WHERE a."ownerId"=$1`,
			[user.id],
		);
		await openCreator(page, prompt);
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
		expect(reservation?.status).toBe("RELEASED");
		await expect
			.poll(async () =>
				count(
					`SELECT count(*) FROM outbox_event WHERE "dedupeKey"=$1 AND "processedAt" IS NOT NULL`,
					[`media-upload-invalid-cleanup:${session!.id}`],
				),
			)
			.toBe(1);
	});

	async function uploadFile(page: import("@playwright/test").Page, name: string, buffer: Buffer) {
		await page
			.getByLabel(/upload images or video/i)
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

	test("provider failure settles the exact job at zero charge", async ({ page }) => {
		const prompt = marker("provider-failure", "Provider failure");
		await createScenario(page, prompt);
		const job = await waitForJob(prompt, "FAILED");
		const reservation = await reservationFor(job.id);
		expect(job.failureCode).toBe("NO_USABLE_OUTPUT");
		expect(reservation.settledAmount).toBe("0");
		expect(reservation.releasedAmount).toBe(job.creditsReserved);
		await expect(page.getByText(/could not finish/i)).toBeVisible();
	});

	test("moderation rejection quarantines the exact output and charges zero", async ({ page }) => {
		const prompt = marker("moderation-rejection", "Unsafe output fixture");
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
		await page.goto("/assets");
		await expect(page.locator(`[data-asset-id="${bindings[0]!.assetId}"]`)).toHaveCount(0);
	});

	test("refresh follows the same in-flight job through success", async ({ page }) => {
		const prompt = marker("delayed-success", "Refresh recovery");
		const jobId = await createScenario(page, prompt);
		await page.goto(`/create?job=${jobId}`);
		await page.reload();
		await expect(page.getByText(jobId)).toBeVisible({ timeout: 30_000 });
		const job = await waitForJob(prompt, "SUCCEEDED");
		expect(job.id).toBe(jobId);
		await expect(page.getByRole("heading", { name: /creation is ready/i })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("cancellation releases all reserved credits for the exact job", async ({ page }) => {
		const prompt = marker("delayed-success", "Cancel this generation");
		const jobId = await createScenario(page, prompt);
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
		await expect(page.getByRole("heading", { name: /creation was canceled/i })).toBeVisible();
		await expect(page.getByText("4").nth(2)).toBeVisible();
	});

	test("reuse binds the seeded READY asset into the new job", async ({ page }) => {
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
		const prompt = marker("reuse", "Turn the reference into a watercolor scene");
		await page.getByLabel(/prompt/i).fill(prompt);
		await page.getByRole("button", { name: /review credits/i }).click();
		await expect(page.getByText(/ready to create/i)).toBeVisible();
		await page.getByRole("button", { name: /start creating/i }).click();
		const job = await waitForJob(prompt, "SUCCEEDED");
		const binding = (
			await rows<{ assetId: string }>(
				`SELECT "assetId" FROM generation_job_asset WHERE "jobId"=$1 AND "assetId"=$2 AND role='INPUT'`,
				[job.id, asset.id],
			)
		)[0];
		expect(binding?.assetId).toBe(asset.id);
	});
});

async function openCreator(page: import("@playwright/test").Page, prompt: string) {
	await page.goto("/create");
	await page.getByLabel(/prompt/i).fill(prompt);
}

async function createScenario(
	page: import("@playwright/test").Page,
	prompt: string,
): Promise<string> {
	await openCreator(page, prompt);
	await page.getByRole("button", { name: /review credits/i }).click();
	await expect(page.getByText(/ready to create/i)).toBeVisible();
	await page.getByRole("button", { name: /start creating/i }).click();
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

function marker(scenario: string, text: string): string {
	return `[e2e:${scenario}] [run:${runId}] ${text}`;
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

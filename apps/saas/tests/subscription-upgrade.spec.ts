import { expect, test } from "@playwright/test";
import pg from "pg";

import { EDITOR_UPGRADE_STORAGE_KEY } from "../modules/payments/lib/editor-upgrade";
import { captureConsentedGrowthEvents } from "./growth-events";

const pool = new pg.Pool({ connectionString: requiredEnvironment("TEST_DATABASE_URL") });
const runId = requiredEnvironment("E2E_RUN_ID");
const freeEmail = `media-e2e-free-${runId}@example.test`;
const subscriptionId = `e2e:${runId}:creator:free-upgrade`;

test.describe("subscription upgrade checkout recovery", () => {
	test.describe.configure({ timeout: 90_000 });

	test.beforeEach(async () => {
		await pool.query(
			`UPDATE subscription
			 SET status='EXPIRED', "graceEndsAt"=NULL, "updatedAt"=now()
			 WHERE provider='e2e' AND "providerSubscriptionId"=$1`,
			[subscriptionId],
		);
		await pool.query(
			`DELETE FROM billing_period WHERE "subscriptionId" IN (
				SELECT id FROM subscription WHERE provider='e2e' AND "providerSubscriptionId"=$1
			)`,
			[subscriptionId],
		);
	});

	test.afterEach(async () => {
		await pool.query(
			`UPDATE subscription
			 SET status='EXPIRED', "graceEndsAt"=NULL, "updatedAt"=now()
			 WHERE provider='e2e' AND "providerSubscriptionId"=$1`,
			[subscriptionId],
		);
	});

	test.afterAll(async () => pool.end());

	for (const provider of ["paypal", "waffo"]) {
		test(`subscription upgrade explains unconfirmed ${provider} cancellation and waits for paid expiry`, async ({
			page,
		}) => {
			const user = await userByEmail(freeEmail);
			const fixtureId = `cancellation-e2e-${runId}-${provider}`;
			await pool.query(
				`INSERT INTO billing_plan (id, provider, "providerPriceId", name, "creditsPerPeriod", "priceMicros", currency, metadata, "updatedAt")
				 VALUES ($1, $2, $1, 'creator', 700, 19000000, 'USD', '{"planId":"creator","interval":"month"}', now())`,
				[fixtureId, provider],
			);
			try {
				await pool.query(
					`INSERT INTO purchase (id, "userId", type, "productKind", provider, "customerId", "subscriptionId", "priceId", status, "updatedAt")
					 VALUES ($1, $2, 'SUBSCRIPTION', 'PLAN', $3, $1, $1, $1, 'expired', now())`,
					[fixtureId, user.id, provider],
				);
				await pool.query(
					`INSERT INTO subscription (id, "ownerType", "ownerId", provider, "providerSubscriptionId", "planId", "purchaseId",
						status, "cancelAtPeriodEnd", "cancellationRequestedAt", "currentPeriodEnd", "updatedAt")
					 VALUES ($1, 'USER', $2, $3, $1, $1, $1, 'EXPIRED', true, now(), now() - interval '1 day', now())`,
					[fixtureId, user.id, provider],
				);
				await page.goto("/settings/billing");
				await expect(
					page.getByText(/new monthly or yearly subscriptions are blocked/i),
				).toBeVisible();
				await expect(
					page.getByText(/awaiting confirmation/, { exact: false }).first(),
				).toBeVisible();
				await expect(page.getByText("Renewal canceled", { exact: true })).toHaveCount(0);
				await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(0);
				await page.goto("/choose-plan");
				await expect(
					page.getByText(/new monthly or yearly subscriptions are blocked/i),
				).toBeVisible();
				await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(0);

				await pool.query(
					`UPDATE subscription SET "renewalDisabledAt"=now(), status='CANCELED',
						"currentPeriodEnd"=now() + interval '1 month' WHERE id=$1`,
					[fixtureId],
				);
				await page.goto("/settings/billing");
				await expect(page.getByText(/renewal through .* is confirmed canceled/i)).toBeVisible();
				await expect(page.getByText("Renewal canceled", { exact: true })).toBeVisible();
				await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(0);
				await pool.query(
					`UPDATE subscription SET status='EXPIRED', "currentPeriodEnd"=now() - interval '1 day' WHERE id=$1`,
					[fixtureId],
				);
				await page.reload();
				await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(3);
				expect(
					(
						await pool.query(
							'SELECT count(*) AS count FROM payment_checkout_intent WHERE "ownerId"=$1',
							[user.id],
						)
					).rows[0].count,
				).toBe("0");
			} finally {
				await pool.query("DELETE FROM subscription WHERE id=$1", [fixtureId]);
				await pool.query("DELETE FROM purchase WHERE id=$1", [fixtureId]);
				await pool.query("DELETE FROM billing_plan WHERE id=$1", [fixtureId]);
			}
		});
	}

	test("subscription upgrade with missing Price ID stays local and visibly unavailable", async ({
		page,
	}) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const user = await userByEmail(freeEmail);
		const before = await checkoutFixtureCounts(user.id);
		await page.goto("/choose-plan?returnTo=%2Fcreate");
		const creator = page.locator('[data-test="price-table-plan"]').filter({
			has: page.getByRole("heading", { name: "Pro", exact: true }),
		});
		await expect(creator).toHaveCount(1);
		await expect(
			creator.getByRole("alert").filter({ hasText: /no payment method is currently available/i }),
		).toBeVisible();
		await expect(creator.getByRole("button", { name: /choose plan/i })).toBeDisabled();
		await expect.poll(() => checkoutFixtureCounts(user.id)).toEqual(before);
		expect(growthEvents.map(({ name }) => name)).not.toContain("checkout_started");
	});

	test("subscription upgrade waits for verified payment and restores the editor", async ({
		page,
	}) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const user = await userByEmail(freeEmail);
		const source = await sourceForUser(user.id);
		const prompt = `[e2e:subscription-upgrade] [run:${runId}] Keep the subject and soften the background`;

		await page.goto(`/create?asset=${source.id}`);
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText(
			"Nano Banana 2 Lite",
			{ timeout: 30_000 },
		);
		await page.getByLabel(/edit instruction|image prompt/i).fill(prompt);
		await page.getByRole("button", { name: /^Model: / }).click();
		await page.getByRole("button", { name: "GPT Image", exact: true }).click();
		await page.locator('[data-test="editor-model-image-gpt-image-2"]').click();
		const dialog = page.getByRole("dialog", { name: /unlock more image models/i });
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText("GPT Image 2");
		await page.locator('[data-test="editor-model-upgrade"]').click();
		await expect(dialog).toContainText(/image, instruction, and model settings stay saved/i);
		await dialog.getByRole("button", { name: /choose a plan/i }).click();

		await expect(page).toHaveURL(/\/choose-plan\?returnTo=/);
		await expect
			.poll(() =>
				page.evaluate((key) => window.sessionStorage.getItem(key), EDITOR_UPGRADE_STORAGE_KEY),
			)
			.toContain(prompt);
		await expect.poll(() => freeGrantCount(user.id)).toBe(1);
		const grantCountBeforeReturn = await freeGrantCount(user.id);

		const pendingState = page.waitForResponse(
			(response) =>
				response.url().includes("/api/rpc/payments/getCheckoutReturnState") &&
				response.request().method() === "POST",
		);
		await page.goto(
			`/checkout-return?expectedPlanId=creator&returnTo=${encodeURIComponent(
				"/create?upgrade=complete",
			)}`,
		);
		await pendingState;
		await expect(page.getByRole("heading", { name: /processing your purchase/i })).toBeVisible();
		await expect(page.getByText(/confirming your purchase/i)).toBeVisible();
		expect(await freeGrantCount(user.id)).toBe(grantCountBeforeReturn);
		await activateCreatorFixture(user.id);
		const unpaidState = await page.request.post("/api/rpc/payments/getCheckoutReturnState", {
			data: { json: { expectedPlanId: "creator" } },
		});
		expect(unpaidState.ok()).toBe(true);
		expect(await unpaidState.json()).toMatchObject({
			json: { status: "PENDING", planId: null, paidThrough: null },
		});
		await recordCreatorPaymentFixture();

		await expect(page).toHaveURL(/\/create\?model=image-gpt-image-2$/, { timeout: 15_000 });
		await expect(page.getByText(/your paid plan is active/i)).toBeVisible();
		await expect(page.getByLabel(/edit instruction|image prompt/i)).toHaveValue(prompt);
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText("GPT Image 2");
		await expect(page.getByRole("img", { name: /selected source image/i })).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate((key) => window.sessionStorage.getItem(key), EDITOR_UPGRADE_STORAGE_KEY),
			)
			.toBeNull();
		expect(await freeGrantCount(user.id)).toBe(grantCountBeforeReturn);
		await expect
			.poll(() => growthEvents.map(({ name }) => name))
			.toEqual(expect.arrayContaining(["upgrade_prompt_viewed", "subscription_activated"]));
	});
});

async function activateCreatorFixture(userId: string): Promise<void> {
	const plan = (
		await pool.query<{ id: string }>(
			`SELECT id FROM billing_plan WHERE provider='e2e' AND "providerPriceId"='e2e-creator'`,
		)
	).rows[0];
	if (!plan) throw new Error("Local Creator billing plan fixture is missing");
	await pool.query(
		`INSERT INTO subscription (
			id, "ownerType", "ownerId", provider, "providerSubscriptionId", "planId", status,
			"currentPeriodStart", "currentPeriodEnd", "createdAt", "updatedAt"
		 ) VALUES (
			$1, 'USER', $2, 'e2e', $3, $4, 'ACTIVE', now(), now() + interval '1 month', now(), now()
		 )
		 ON CONFLICT (provider, "providerSubscriptionId") DO UPDATE SET
			"ownerId"=EXCLUDED."ownerId", "planId"=EXCLUDED."planId", status='ACTIVE',
			"currentPeriodStart"=EXCLUDED."currentPeriodStart",
			"currentPeriodEnd"=EXCLUDED."currentPeriodEnd", "graceEndsAt"=NULL, "updatedAt"=now()`,
		[`subscription-${runId}-free-upgrade`, userId, subscriptionId, plan.id],
	);
}

async function recordCreatorPaymentFixture(): Promise<void> {
	await pool.query(
		`INSERT INTO billing_period (
			id, "subscriptionId", "startsAt", "endsAt", status,
			"paidAmount", "creditAmount", "providerInvoicePaymentId", "createdAt", "updatedAt"
		 ) SELECT $1, id, "currentPeriodStart", "currentPeriodEnd", 'ACTIVE',
			19000000, 700, $2, now(), now()
		   FROM subscription WHERE provider='e2e' AND "providerSubscriptionId"=$3
		 ON CONFLICT (id) DO UPDATE SET
			"startsAt"=EXCLUDED."startsAt", "endsAt"=EXCLUDED."endsAt", status='ACTIVE',
			"paidAmount"=EXCLUDED."paidAmount", "updatedAt"=now()`,
		[`period-${runId}-free-upgrade`, `${subscriptionId}:local-payment`, subscriptionId],
	);
}

async function userByEmail(email: string) {
	const user = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email=$1`, [email]))
		.rows[0];
	if (!user) throw new Error(`Seed user missing: ${email}`);
	return user;
}

async function sourceForUser(userId: string) {
	const source = (
		await pool.query<{ id: string }>(
			`SELECT id FROM media_asset
			 WHERE "ownerId"=$1 AND "sourceUrl"=$2 AND status='READY' AND "deletedAt" IS NULL`,
			[userId, `e2e-seed:${runId}`],
		)
	).rows[0];
	if (!source) throw new Error(`Seed source image missing for ${userId}`);
	return source;
}

async function freeGrantCount(userId: string): Promise<number> {
	const result = await pool.query<{ count: string }>(
		`SELECT count(*)
		 FROM credit_ledger_entry entry
		 JOIN credit_account account ON account.id=entry."accountId"
		 WHERE account."ownerType"='USER' AND account."ownerId"=$1
		   AND entry.type='GRANT' AND entry."referenceKey" LIKE $2`,
		[userId, `free-plan:user:${userId}:%`],
	);
	return Number(result.rows[0]?.count ?? 0);
}

async function checkoutFixtureCounts(
	userId: string,
): Promise<{ purchases: number; subscriptions: number }> {
	const result = await pool.query<{ purchases: string; subscriptions: string }>(
		`SELECT
			(SELECT count(*) FROM purchase WHERE "userId"=$1) AS purchases,
			(SELECT count(*) FROM subscription WHERE "ownerType"='USER' AND "ownerId"=$1) AS subscriptions`,
		[userId],
	);
	return {
		purchases: Number(result.rows[0]?.purchases ?? 0),
		subscriptions: Number(result.rows[0]?.subscriptions ?? 0),
	};
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for subscription upgrade E2E`);
	return value;
}

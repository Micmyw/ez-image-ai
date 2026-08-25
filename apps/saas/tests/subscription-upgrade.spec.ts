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
			 WHERE "providerSubscriptionId"=$1`,
			[subscriptionId],
		);
	});

	test.afterEach(async () => {
		await pool.query(
			`UPDATE subscription
			 SET status='EXPIRED', "graceEndsAt"=NULL, "updatedAt"=now()
			 WHERE "providerSubscriptionId"=$1`,
			[subscriptionId],
		);
	});

	test.afterAll(async () => pool.end());

	test("subscription upgrade with missing Price ID stays local and visibly unavailable", async ({
		page,
	}) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const user = await userByEmail(freeEmail);
		const before = await checkoutFixtureCounts(user.id);
		await page.goto("/choose-plan?returnTo=%2Fcreate");
		const creator = page.locator('[data-test="price-table-plan"]').filter({ hasText: "Creator" });
		await creator.getByRole("button", { name: /choose plan/i }).click();

		await expect(
			page.getByRole("alert").filter({ hasText: /paid checkout is temporarily unavailable/i }),
		).toBeVisible();
		await expect.poll(() => checkoutFixtureCounts(user.id)).toEqual(before);
		expect(growthEvents.map(({ name }) => name)).not.toContain("checkout_started");
	});

	test("subscription upgrade waits for server activation and restores the editor", async ({
		page,
	}) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const user = await userByEmail(freeEmail);
		const source = await sourceForUser(user.id);
		const prompt = `[e2e:subscription-upgrade] [run:${runId}] Keep the subject and soften the background`;

		await page.goto(`/create?asset=${source.id}`);
		await page.getByLabel(/edit instruction/i).fill(prompt);
		const quality = page.getByRole("radio", { name: /quality edit/i });
		await quality.click();
		const dialog = page.getByRole("dialog", { name: /unlock quality edit/i });
		await expect(dialog).toContainText(/image, instruction, quality edit selection/i);
		await expect(page.locator('input[name="editor-mode"][value="image-quality"]')).toBeChecked();
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

		await expect(page).toHaveURL(/\/create(?:\?upgrade=complete)?$/, { timeout: 15_000 });
		await expect(page.getByText(/your paid plan is active/i)).toBeVisible();
		await expect(page.getByLabel(/edit instruction/i)).toHaveValue(prompt);
		await expect(page.getByRole("radio", { name: /quality edit/i })).toBeChecked();
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
		 ON CONFLICT ("providerSubscriptionId") DO UPDATE SET
			"ownerId"=EXCLUDED."ownerId", "planId"=EXCLUDED."planId", status='ACTIVE',
			"currentPeriodStart"=EXCLUDED."currentPeriodStart",
			"currentPeriodEnd"=EXCLUDED."currentPeriodEnd", "graceEndsAt"=NULL, "updatedAt"=now()`,
		[`subscription-${runId}-free-upgrade`, userId, subscriptionId, plan.id],
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

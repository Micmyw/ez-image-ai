import { expect, test } from "@playwright/test";
import pg from "pg";

import { assertLocalMediaE2E } from "../../../tooling/e2e/src/guard";
import { captureConsentedGrowthEvents } from "./growth-events";

const localEnvironment = assertLocalMediaE2E();
const pool = new pg.Pool({ connectionString: localEnvironment.databaseUrl });
const runId = localEnvironment.runId;
const freeEmail = `media-e2e-free-${runId}@example.test`;
const subscriptionId = `e2e:${runId}:creator:free-upgrade`;
const returnFixture = {
	planId: `upgrade-return-plan-${runId}`,
	priceId: `TEST-PAYPAL-UPGRADE-RETURN-${runId}`,
	intentId: `upgrade-return-intent-${runId}`,
	subscriptionId: `upgrade-return-subscription-${runId}`,
	providerSubscriptionId: `TEST-PAYPAL-SUBSCRIPTION-${runId}`,
	periodId: `upgrade-return-period-${runId}`,
	paymentId: `paypal:TEST-UPGRADE-RETURN-PAYMENT-${runId}`,
};

test.describe("subscription upgrade checkout recovery", () => {
	test.describe.configure({ timeout: 90_000 });

	test.beforeEach(async () => {
		await cleanupCreatorReturnFixture();
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
		await cleanupCreatorReturnFixture();
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

	test("subscription upgrade from billing waits for verified payment and preserves the editor", async ({
		page,
	}) => {
		const growthEvents = await captureConsentedGrowthEvents(page);
		const user = await userByEmail(freeEmail);
		const source = await sourceForUser(user.id);
		const prompt = `[e2e:subscription-upgrade] [run:${runId}] Keep the subject and soften the background`;

		await page.goto(`/create?asset=${source.id}`);
		await expect(page.locator("#registered-generator")).toHaveAttribute(
			"data-editor-ready",
			"true",
		);
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText(
			"Nano Banana 2 Lite",
			{ timeout: 30_000 },
		);
		await expect(page.locator('[data-test="registered-generator"]')).toHaveAttribute(
			"aria-busy",
			"false",
		);
		await expect(page.locator('[data-test="generation-submit"]')).toContainText("5 credits");
		const promptInput = page.getByLabel(/edit instruction|image prompt/i);
		await promptInput.fill(prompt);
		await expect(promptInput).toHaveValue(prompt);
		await page.getByRole("button", { name: /^Model: / }).click();
		await page.getByRole("button", { name: "GPT Image", exact: true }).click();
		await page.locator('[data-test="editor-model-image-gpt-image-2"]').click();
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText("GPT Image 2");
		await expect(promptInput).toHaveValue(prompt);
		await expect(page.locator('[data-test="generation-submit"]')).toBeEnabled();
		await expect(page.locator('[data-test="editor-model-upgrade"]')).toHaveCount(0);
		await expect(page.locator('[data-test="editor-model-access-notice"]')).toHaveCount(0);

		await page.goto("/settings/billing");
		await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(3);
		await page.goto("/choose-plan?returnTo=%2Fcreate");
		await expect(page.locator('[data-test="price-table-plan"]')).toHaveCount(3);
		await expect.poll(() => freeGrantCount(user.id)).toBe(1);
		const grantCountBeforeReturn = await freeGrantCount(user.id);
		const grantsBeforeReturn = await creditGrants(user.id);
		// The fixture represents trusted processing in the isolated database. It
		// creates no provider resource, payment event, Outbox work or credit grant.
		await prepareCreatorReturnFixture(user.id);
		const unexpectedPaymentMutations: string[] = [];
		await page.route("**/api/rpc/payments/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (/^\/api\/rpc\/payments\/(?!get|list)/.test(path)) {
				unexpectedPaymentMutations.push(path);
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});

		const pendingState = page.waitForResponse(
			(response) =>
				response.url().includes("/api/rpc/payments/getCheckoutReturnState") && response.ok(),
		);
		await page.goto(
			`/checkout-return?expectedPlanId=creator&checkoutIntentId=${encodeURIComponent(returnFixture.intentId)}&returnTo=${encodeURIComponent(
				"/create",
			)}`,
		);
		await pendingState;
		await expect(
			page.getByRole("heading", { name: "Your subscription checkout", exact: true }),
		).toBeVisible();
		const checkoutStatus = page.getByTestId("subscription-checkout-status");
		await expect(checkoutStatus).toHaveAttribute("data-status", "PENDING");
		await expect(checkoutStatus).toContainText("Subscription payment has not been confirmed");
		expect(await freeGrantCount(user.id)).toBe(grantCountBeforeReturn);
		expect(await creditGrants(user.id)).toEqual(grantsBeforeReturn);
		await activateCreatorFixture(user.id);
		const unpaidState = await page.request.post("/api/rpc/payments/getCheckoutReturnState", {
			data: {
				json: { expectedPlanId: "creator", checkoutIntentId: returnFixture.intentId },
			},
		});
		expect(unpaidState.ok()).toBe(true);
		expect(await unpaidState.json()).toMatchObject({
			json: { status: "PENDING", planId: null, paidThrough: null },
		});
		expect(await creditGrants(user.id)).toEqual(grantsBeforeReturn);
		await recordCreatorPaymentFixture();
		const paidState = await page.request.post("/api/rpc/payments/getCheckoutReturnState", {
			data: {
				json: { expectedPlanId: "creator", checkoutIntentId: returnFixture.intentId },
			},
		});
		expect(paidState.ok()).toBe(true);
		expect(await paidState.json()).toMatchObject({ json: { status: "ACTIVE", planId: "creator" } });
		const legacyState = await page.request.post("/api/rpc/payments/getCheckoutReturnState", {
			data: { json: { expectedPlanId: "creator" } },
		});
		expect(legacyState.ok()).toBe(true);
		expect(await legacyState.json()).toMatchObject({ json: pendingCheckoutState });
		await expect(checkoutStatus).toHaveAttribute("data-status", "ACTIVE", { timeout: 15_000 });
		await expect(page).toHaveURL(/\/checkout-return\?/);
		await expect(checkoutStatus).toContainText("Your subscription is confirmed");
		expect(await creditGrants(user.id)).toEqual(grantsBeforeReturn);
		await page.getByTestId("subscription-continue").click();

		await expect(page).toHaveURL(/\/create$/, { timeout: 15_000 });
		await expect(page.getByLabel(/edit instruction|image prompt/i)).toHaveValue(prompt);
		await expect(page.getByRole("button", { name: /^Model: / })).toContainText("GPT Image 2");
		await expect(page.getByRole("img", { name: /selected source image/i })).toBeVisible();
		await expect(page.locator('[data-test="generation-submit"]')).toBeEnabled();
		expect(await freeGrantCount(user.id)).toBe(grantCountBeforeReturn);
		expect(await creditGrants(user.id)).toEqual(grantsBeforeReturn);
		await expect
			.poll(() => growthEvents.map(({ name }) => name))
			.toEqual(expect.arrayContaining(["subscription_activated"]));
		expect(unexpectedPaymentMutations).toEqual([]);
	});
});

const pendingCheckoutState = { status: "PENDING", planId: null, paidThrough: null };

async function prepareCreatorReturnFixture(userId: string): Promise<void> {
	const copied = await pool.query(
		`INSERT INTO billing_plan (id, provider, "providerPriceId", "productKind", name,
			"creditsPerPeriod", "priceMicros", currency, active, version, metadata, "updatedAt")
		 SELECT $1, 'paypal', $2, 'PLAN', name, "creditsPerPeriod", "priceMicros", currency,
			active, version, metadata || '{"interval":"month","source":"local-subscription-return-e2e"}'::jsonb, now()
		 FROM billing_plan WHERE provider='e2e' AND "providerPriceId"='e2e-creator' AND "productKind"='PLAN'`,
		[returnFixture.planId, returnFixture.priceId],
	);
	if (copied.rowCount !== 1) throw new Error("Local Creator billing plan fixture is missing");
	await pool.query(
		`INSERT INTO payment_checkout_intent (id, provider, "ownerType", "ownerId", "submittedByUserId",
			"productKind", "billingPlanId", "planKey", interval, "idempotencyKey", "providerSessionId", status,
			"checkoutRecovery", "updatedAt")
		 VALUES ($1, 'paypal', 'USER', $2, $2, 'PLAN', $3, 'creator', 'month', $1, $4, 'PROVIDER_PENDING',
			'{"version":1,"mode":"MERCHANT","scope":"local-fixture","status":"PENDING"}', now())`,
		[returnFixture.intentId, userId, returnFixture.planId, returnFixture.providerSubscriptionId],
	);
}

async function activateCreatorFixture(userId: string): Promise<void> {
	await pool.query(
		`INSERT INTO subscription (
			id, "ownerType", "ownerId", provider, "providerSubscriptionId", "planId", status,
			"currentPeriodStart", "currentPeriodEnd", "createdAt", "updatedAt"
		 ) VALUES (
			$1, 'USER', $2, 'paypal', $3, $4, 'ACTIVE', now(), now() + interval '1 month', now(), now()
		 )`,
		[
			returnFixture.subscriptionId,
			userId,
			returnFixture.providerSubscriptionId,
			returnFixture.planId,
		],
	);
	const completed = await pool.query(
		`UPDATE payment_checkout_intent SET status='COMPLETED', "activeScopeKey"=NULL, "updatedAt"=now()
		 WHERE id=$1 AND provider='paypal' AND "ownerType"='USER' AND "ownerId"=$2
			AND "billingPlanId"=$3 AND "providerSessionId"=$4 AND status='PROVIDER_PENDING'`,
		[returnFixture.intentId, userId, returnFixture.planId, returnFixture.providerSubscriptionId],
	);
	if (completed.rowCount !== 1)
		throw new Error("Owned subscription checkout fixture was not completed");
}

async function recordCreatorPaymentFixture(): Promise<void> {
	const recorded = await pool.query(
		`INSERT INTO billing_period (
			id, "subscriptionId", "startsAt", "endsAt", status,
			"paidAmount", "creditAmount", "providerInvoicePaymentId", "createdAt", "updatedAt"
		 ) SELECT $1, sub.id, sub."currentPeriodStart", sub."currentPeriodEnd", 'ACTIVE',
			plan."priceMicros", plan."creditsPerPeriod", $2, now(), now()
		   FROM subscription sub JOIN billing_plan plan ON plan.id=sub."planId"
		   WHERE sub.id=$3 AND sub.provider='paypal' AND sub."providerSubscriptionId"=$4`,
		[
			returnFixture.periodId,
			returnFixture.paymentId,
			returnFixture.subscriptionId,
			returnFixture.providerSubscriptionId,
		],
	);
	if (recorded.rowCount !== 1)
		throw new Error("Owned subscription payment fixture was not recorded");
}

async function cleanupCreatorReturnFixture(): Promise<void> {
	await pool.query('DELETE FROM billing_period WHERE id=$1 AND "subscriptionId"=$2', [
		returnFixture.periodId,
		returnFixture.subscriptionId,
	]);
	await pool.query(
		`DELETE FROM subscription WHERE id=$1 AND provider='paypal' AND "providerSubscriptionId"=$2`,
		[returnFixture.subscriptionId, returnFixture.providerSubscriptionId],
	);
	await pool.query(
		`DELETE FROM payment_checkout_intent WHERE id=$1 AND provider='paypal' AND "billingPlanId"=$2`,
		[returnFixture.intentId, returnFixture.planId],
	);
	await pool.query(
		`DELETE FROM billing_plan WHERE id=$1 AND provider='paypal' AND "providerPriceId"=$2`,
		[returnFixture.planId, returnFixture.priceId],
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

async function creditGrants(userId: string): Promise<{ count: string; amount: string }> {
	const result = await pool.query<{ count: string; amount: string }>(
		`SELECT count(*)::text AS count, COALESCE(sum(entry.amount), 0)::text AS amount
		 FROM credit_ledger_entry entry
		 JOIN credit_account account ON account.id=entry."accountId"
		 WHERE account."ownerType"='USER' AND account."ownerId"=$1 AND entry.type='GRANT'`,
		[userId],
	);
	return result.rows[0]!;
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

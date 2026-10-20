import { expect, test } from "@playwright/test";
import pg from "pg";

import { assertLocalMediaE2E } from "../../../tooling/e2e/src/guard";

const localEnvironment = assertLocalMediaE2E();
const pool = new pg.Pool({ connectionString: localEnvironment.databaseUrl });
const freeEmail = `media-e2e-free-${localEnvironment.runId}@example.test`;
const modelFamilies = [
	[
		"Nano Banana",
		[
			"image-nano-banana-2-lite",
			"image-nano-banana",
			"image-nano-banana-2",
			"image-nano-banana-pro",
		],
	],
	[
		"GPT Image",
		[
			"image-gpt-image-1-5",
			"image-gpt-image-2",
			"image-gpt-image-2-5-flare",
			"image-gpt-image-2-5-sunburst",
		],
	],
	[
		"Seedream",
		["image-seedream-4", "image-seedream-4-5", "image-seedream-5-lite", "image-seedream-5-pro"],
	],
] as const;

test.afterAll(async () => pool.end());
test.setTimeout(90_000);

for (const width of [1440, 390]) {
	test(`subscription upgrade is optional for funded image-model selection at ${width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		const businessRequests: string[] = [];
		page.on("request", (request) => {
			if (
				/\/api\/rpc\/.*\/(createQuote|createGeneration|submitGeneration|retryGeneration|createCheckoutLink)/.test(
					request.url(),
				)
			)
				businessRequests.push(request.url());
		});
		await page.goto("/create?model=image-nano-banana-2-lite");
		const form = page.locator('[data-test="registered-generator"]');
		await expect(form).toHaveAttribute("data-editor-ready", "true");
		const prompt = form.locator("textarea");
		const instruction = "Keep this instruction while I compare image models.";
		await prompt.fill(instruction);
		const readAccount = async () =>
			(
				await pool.query<{ credits: string; subscriptions: string }>(
					`SELECT
					(SELECT COALESCE(sum(lot."remainingAmount"), 0)::text
					 FROM credit_lot lot JOIN credit_account account ON account.id=lot."accountId"
					 WHERE account."ownerType"='USER' AND account."ownerId"=u.id
					   AND (lot."expiresAt" IS NULL OR lot."expiresAt">now())) AS credits,
					(SELECT count(*)::text FROM subscription sub
					 WHERE sub."ownerType"='USER' AND sub."ownerId"=u.id
					   AND sub.status IN ('ACTIVE', 'PAST_DUE', 'CANCELED')
					   AND (sub."currentPeriodEnd">now() OR sub."graceEndsAt">now())) AS subscriptions
				 FROM "user" u WHERE u.email=$1`,
					[freeEmail],
				)
			).rows[0];
		await expect
			.poll(async () => Number((await readAccount())?.credits ?? "0"))
			.toBeGreaterThanOrEqual(25);
		const account = await readAccount();
		expect(account).toBeDefined();
		expect(account!.subscriptions).toBe("0");

		const modelTrigger = page.locator('[data-test="editor-model-trigger"]');
		const submit = page.locator('[data-test="generation-submit"]');
		for (const [family, products] of modelFamilies) {
			for (const productKey of products) {
				await modelTrigger.click();
				await page.getByRole("button", { name: family, exact: true }).click();
				const option = page.locator(`[data-test="editor-model-${productKey}"]`);
				await expect(option).toBeEnabled();
				await expect(option).not.toContainText("Paid plan");
				await option.click();
				await expect(page).toHaveURL(new RegExp(`model=${productKey}(?:&|$)`));
				await expect(submit).toBeEnabled();
				await expect(submit).toContainText("Generate image");
				await expect(submit).toContainText(/\d+ credits/);
				await expect(page.locator('[data-test="editor-model-upgrade"]')).toHaveCount(0);
				await expect(page.locator('[data-test="editor-model-access-notice"]')).toHaveCount(0);
				await expect(prompt).toHaveValue(instruction);
				if (productKey === "image-gpt-image-2-5-sunburst")
					await page.screenshot({
						path: testInfo.outputPath("sunburst-account-credits.png"),
						animations: "disabled",
					});
			}
		}
		await expect(modelTrigger).toContainText("Seedream 5 Pro");
		await modelTrigger.click();
		const menu = page.getByRole("dialog", { name: "Image models", exact: true });
		await expect(menu).toBeVisible();
		await expect(page.locator('[data-test="editor-model-image-seedream-5-pro"]')).toContainText(
			"Up to 2K",
		);
		const menuBox = await menu.boundingBox();
		expect(menuBox).not.toBeNull();
		expect(menuBox!.x).toBeGreaterThanOrEqual(0);
		expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
		await page.screenshot({
			path: testInfo.outputPath("model-selection.png"),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(modelTrigger).toBeFocused();
		await page.reload();
		await expect(modelTrigger).toContainText("Seedream 5 Pro");
		await expect(prompt).toHaveValue(instruction);
		await expect(submit).toBeEnabled();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		expect(businessRequests).toEqual([]);
	});
}

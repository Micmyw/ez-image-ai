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
	test(`subscription upgrade keeps model selection in the editor until requested at ${width}px`, async ({
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
		await prompt.fill("Keep this instruction while I compare image models.");
		const account = (
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
		expect(Number(account?.credits ?? "0")).toBeGreaterThanOrEqual(10);
		expect(account?.subscriptions).toBe("0");
		const modelTrigger = page.locator('[data-test="editor-model-trigger"]');
		for (const [family, products] of modelFamilies) {
			for (const productKey of products) {
				await modelTrigger.click();
				await page.getByRole("button", { name: family, exact: true }).click();
				const option = page.locator(`[data-test="editor-model-${productKey}"]`);
				await expect(option).toBeEnabled();
				if (productKey === "image-nano-banana-2-lite")
					await expect(option).not.toContainText("Paid plan");
				else await expect(option).toContainText("Paid plan");
				await option.click();
				await expect(page).toHaveURL(new RegExp(`model=${productKey}(?:&|$)`));
				if (productKey === "image-nano-banana-2-lite") {
					await expect(page.locator('[data-test="generation-submit"]')).toBeEnabled();
					await expect(page.locator('[data-test="editor-model-upgrade"]')).toHaveCount(0);
				} else {
					await expect(page.locator('[data-test="generation-submit"]')).toHaveCount(0);
					await expect(page.locator('[data-test="editor-model-upgrade"]')).toBeEnabled();
					await expect(page.locator('[data-test="editor-model-access-notice"]')).toBeVisible();
				}
				await expect(prompt).toHaveValue("Keep this instruction while I compare image models.");
			}
		}
		await expect(modelTrigger).toContainText("Seedream 5 Pro");
		const dialog = page.getByRole("dialog", { name: "Unlock more image models", exact: true });
		await expect(dialog).toBeHidden();
		await expect(page.locator('[data-test="editor-model-access-notice"]')).toContainText(
			"Seedream 5 Pro",
		);
		await expect(prompt).toHaveValue("Keep this instruction while I compare image models.");
		await modelTrigger.click();
		const selectedOption = page.locator('[data-test="editor-model-image-seedream-5-pro"]');
		await expect(selectedOption).toContainText("Paid plan");
		await expect(selectedOption).toContainText("Up to 2K");
		await page.keyboard.press("Escape");
		await page.screenshot({
			path: testInfo.outputPath("model-selection.png"),
			animations: "disabled",
		});
		const upgrade = page.locator('[data-test="editor-model-upgrade"]');
		await expect(upgrade).toBeEnabled();
		await upgrade.click();
		await expect(dialog).toBeVisible();
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(dialogBox!.width).toBeLessThanOrEqual(600);
		expect(dialogBox!.x).toBeGreaterThanOrEqual(12);
		expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width - 12);
		await expect(dialog).toContainText("Seedream 5 Pro");
		await expect(dialog).not.toContainText("SKU");
		await expect(page.getByRole("dialog", { name: "Image models", exact: true })).toBeHidden();
		const backdrop = page.locator('[data-test="editor-upgrade-backdrop"]');
		await expect(backdrop).toBeVisible();
		expect(
			await backdrop.evaluate((element) => {
				const color = getComputedStyle(element).backgroundColor;
				return color.startsWith("rgba(") || color.includes("/");
			}),
		).toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("upgrade-dialog.png"),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(upgrade).toBeFocused();
		await expect(prompt).toHaveValue("Keep this instruction while I compare image models.");
		await upgrade.click();
		await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
		await expect(dialog).toBeHidden();
		await upgrade.click();
		await dialog.getByRole("button", { name: "Choose a plan", exact: true }).click();
		await expect(page).toHaveURL(/\/choose-plan\?returnTo=/);
		const saved = await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem("ezpic.editor-upgrade.v1") ?? "null"),
		);
		expect(saved.draft.productKey).toBe("image-seedream-5-pro");
		expect(saved.draft.input.prompt).toBe("Keep this instruction while I compare image models.");
		expect(saved.draft.input.sourceAssetId).toBe("");
		expect(saved.sourceReady).toBe(false);
		await page.goBack();
		await expect(modelTrigger).toContainText("Seedream 5 Pro");
		await expect(prompt).toHaveValue("Keep this instruction while I compare image models.");
		await expect(dialog).toBeHidden();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		expect(businessRequests).toEqual([]);
	});
}

import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
	test(`subscription upgrade keeps model selection in the editor until requested at ${width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		const businessRequests: string[] = [];
		page.on("request", (request) => {
			if (/\/api\/rpc\/.*\/(createQuote|createGeneration|createCheckoutLink)/.test(request.url()))
				businessRequests.push(request.url());
		});
		await page.goto("/create?model=image-nano-banana-2-lite");
		const prompt = page.locator('[data-test="registered-generator"] textarea');
		await prompt.fill("Keep this instruction while I compare image models.");
		const modelTrigger = page.locator('[data-test="editor-model-trigger"]');
		await modelTrigger.click();
		await page.getByRole("button", { name: "Seedream", exact: true }).click();
		await page.locator('[data-test="editor-model-image-seedream-5-pro"]').click();
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

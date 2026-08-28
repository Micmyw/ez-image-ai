import { expect, test, type Page, type TestInfo } from "@playwright/test";
import pg from "pg";

const marketingUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";
const testDatabaseUrl = requiredEnvironment("TEST_DATABASE_URL");
const runId = requiredEnvironment("E2E_RUN_ID");
const pool = new pg.Pool({ connectionString: testDatabaseUrl });
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

test("anonymous Standard trial is private, accessible, responsive, and temporary", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	const prompt = `[e2e:delayed-success] [run:${runId}] guest browser certification ${testInfo.retry}`;
	await enterGuestWorkspace(page, prompt);

	await assertGuestLayouts(page, [1440, 800, 320]);
	await captureReviewScreenshots(page, testInfo);
	await assertGuestAccessibility(page);
	await assertGuestOriginality(page);

	const promptInput = page.getByLabel(/edit instruction/i);
	await expect(promptInput).toHaveValue(prompt);
	await promptInput.fill(`${prompt} retry`);
	let blockedOnce = false;
	await page.route("**/api/**", async (route) => {
		if (
			!blockedOnce &&
			route.request().method() === "POST" &&
			new URL(route.request().url()).pathname.endsWith("/api/rpc/media/submitGuestGeneration")
		) {
			blockedOnce = true;
			await route.abort("failed");
			return;
		}
		await route.continue();
	});
	await page.getByRole("button", { name: /standard edit/i }).click();
	const alert = page.getByRole("alert");
	await expect(alert).toBeVisible();
	await expect(alert.locator("xpath=..")).toBeFocused();
	await page.unroute("**/api/**");

	await page.getByRole("button", { name: /standard edit/i }).click();
	const viewStatus = page.getByRole("button", { name: /view status/i });
	await expect(viewStatus).toBeVisible({ timeout: 30_000 });
	await viewStatus.click();
	await expect(page.locator("#guest-status-region")).toBeFocused();

	const resultRegion = page.locator("#guest-result-region");
	await expect(resultRegion.getByRole("img")).toBeVisible({ timeout: 60_000 });
	await expect(resultRegion).not.toBeFocused();
	await page.getByRole("button", { name: /view result/i }).click();
	await expect(resultRegion).toBeFocused();
	await expect(resultRegion).toContainText(/available until|expires/i);
	const resultUrl = await resultRegion.getByRole("img").getAttribute("src");
	expect(resultUrl).toMatch(/^https?:\/\//);
	expect(resultUrl).toMatch(/X-Amz-|Signature=/i);

	const download = page.waitForEvent("download");
	await resultRegion.getByRole("button", { name: /download watermarked preview/i }).click();
	expect((await download).suggestedFilename()).toBeTruthy();
	const main = page.getByRole("main");
	await expect(main.getByRole("button", { name: /sign in/i })).toBeVisible();
	await expect(main.getByRole("button", { name: /create account/i })).toBeVisible();
	await expect(page.getByRole("link", { name: /history|assets|edits/i })).toHaveCount(0);
	await expect(page.getByText(/edit again/i)).toHaveCount(0);

	const expiredTrial = await pool.query(
		`UPDATE guest_media_trial SET "projectedDispatchAt"="createdAt" + interval '1 millisecond', "estimateExpiresAt"="createdAt" + interval '2 milliseconds', "expiresAt"="createdAt" + interval '3 milliseconds' WHERE COALESCE("currentJobId", "consumedJobId")=(SELECT id FROM generation_job WHERE "inputSnapshot"->>'prompt'=$1 ORDER BY "createdAt" DESC LIMIT 1)`,
		[`${prompt} retry`],
	);
	expect(expiredTrial.rowCount).toBe(1);
	await page.reload();
	await expect(page.getByText(/expired/i).first()).toBeVisible({ timeout: 30_000 });
});

async function enterGuestWorkspace(page: Page, prompt: string): Promise<void> {
	await page.context().addCookies([{ name: "consent", value: "true", url: marketingUrl }]);
	await page.goto(marketingUrl);
	await page.getByLabel(/describe your edit/i).fill(prompt);
	const chooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: /drop an image here or choose a file/i }).click();
	await (
		await chooserPromise
	).setFiles({ name: "guest-source.png", mimeType: "image/png", buffer: png });
	await page.getByRole("button", { name: /try one standard edit free/i }).click();
	await expect(page).toHaveURL(/\/try(?:\?|$)/, { timeout: 30_000 });
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await expect(page.getByRole("button", { name: /standard edit/i })).toBeVisible();
}

async function assertGuestLayouts(page: Page, widths: number[]): Promise<void> {
	for (const width of widths) {
		await page.setViewportSize({ width, height: 900 });
		const geometry = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth,
			pageWidth: document.documentElement.scrollWidth,
			result: document.getElementById("guest-result-region")?.getBoundingClientRect().toJSON(),
		}));
		expect(geometry.pageWidth, `${width}px page overflow`).toBeLessThanOrEqual(
			geometry.viewport + 1,
		);
		expect(geometry.result?.left ?? -1).toBeGreaterThanOrEqual(0);
		expect(geometry.result?.right ?? width + 1).toBeLessThanOrEqual(width + 1);
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	const session = await page.context().newCDPSession(page);
	await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 4 });
	expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(4);
	await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
}

async function assertGuestAccessibility(page: Page): Promise<void> {
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByLabel(/edit instruction/i)).toBeVisible();
	await expect(page.locator("#guest-status-region")).toHaveAttribute("aria-live", "polite");
	const primary = page.getByRole("button", { name: /standard edit/i });
	const primaryBox = await primary.boundingBox();
	expect(primaryBox?.height ?? 0).toBeGreaterThanOrEqual(48);
	for (const control of await page
		.locator("button:visible, input:visible, textarea:visible")
		.all()) {
		const box = await control.boundingBox();
		if (box) expect(box.height).toBeGreaterThanOrEqual(44);
	}
	await page.emulateMedia({ reducedMotion: "reduce" });
	const animation = await page
		.locator("#guest-result-region [aria-hidden=true]")
		.last()
		.evaluate((element) => getComputedStyle(element).animationName)
		.catch(() => "none");
	expect(animation).toBe("none");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.getByLabel(/edit instruction/i).focus();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: /quality edit/i })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(primary).toBeFocused();
	await expect(page.getByText(/standard edit/i).first()).toBeVisible();
}

async function assertGuestOriginality(page: Page): Promise<void> {
	const publicText = await page.locator("body").innerText();
	expect(publicText).not.toMatch(/raphael|seedream|providerModelId|providerCostMicros/i);
	await expect(page.getByText(/history|edit again/i)).toHaveCount(0);
}

async function captureReviewScreenshots(page: Page, testInfo: TestInfo): Promise<void> {
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
		const path = testInfo.outputPath(`guest-originality-${width}.png`);
		await page.screenshot({ path, fullPage: true });
		await testInfo.attach(`guest-originality-${width}`, { path, contentType: "image/png" });
	}
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for guest browser evidence`);
	return value;
}

test.afterAll(async () => pool.end());

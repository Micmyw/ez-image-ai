import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { getVideoModelOptions, VIDEO_MODEL_CATALOG } from "@repo/config/video-models";

import { E2E_PASSWORD, fundedEmail } from "../../../../tooling/e2e/src/fixtures";

type MockStage =
	| "QUEUED"
	| "GENERATING"
	| "SUBMISSION_UNCERTAIN"
	| "OUTPUT_REVIEW"
	| "READY"
	| "REJECTED";
type Scenario = {
	stage: MockStage;
	available: boolean;
	creates: Array<Record<string, unknown>>;
	quotes: number;
	gets: number;
	playback: number;
	loseFirstResponse: boolean;
	quoteError: string | null;
	quoteExpired: boolean;
	quoteRequests: Array<Record<string, unknown>>;
	blockedSound: boolean;
};
function scenario(): Scenario {
	return {
		stage: "QUEUED",
		available: true,
		creates: [],
		quotes: 0,
		gets: 0,
		playback: 0,
		loseFirstResponse: false,
		quoteError: null,
		quoteExpired: false,
		quoteRequests: [],
		blockedSound: false,
	};
}

async function setup(context: BrowserContext, page: Page, state: Scenario) {
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)) return route.abort();
		const endpoint = url.pathname.split("/api/rpc/videoV1/")[1];
		if (url.pathname === "/__video-ui-upload") return route.fulfill({ status: 200 });
		if (url.pathname === "/__video-ui-expired") return route.fulfill({ status: 403 });
		if (!endpoint) return route.continue();
		const body = route.request().method() === "POST" ? route.request().postDataJSON()?.json : null;
		const job = {
			jobId: "ui-mock-video-1",
			stage: state.stage,
			credits: "23",
			creditState:
				state.stage === "READY" ? "SETTLED" : state.stage === "REJECTED" ? "RELEASED" : "RESERVED",
			canPlay: state.stage === "READY",
			failureCode: null,
			updatedAt: "2026-10-04T00:00:00Z",
		};
		const reply = (json: unknown) => route.fulfill({ json: { json } });
		if (endpoint === "catalog")
			return reply({
				available: state.available,
				accessAllowed: true,
				reasons: [],
				productKey: "video-kling-2-6-v1",
				modelName: "Kling 2.6",
				duration: 5,
				sound: false,
				credits: "23",
				maxInputBytes: 10_000_000,
				maxPromptCodePoints: 1000,
				aspectRatios: ["16:9", "9:16"],
				models: VIDEO_MODEL_CATALOG.map((model) => ({
					productKey: model.productKey,
					available: state.available && model.status === "implemented",
					reasons: [],
					options: model.modes.flatMap((mode) => [
						...new Map(
							getVideoModelOptions(model.productKey, mode).map(
								({ duration, resolution, sound }) => [
									`${duration}:${resolution}:${sound}`,
									{
										duration,
										resolution,
										sound,
										mode,
										available: state.available && !(state.blockedSound && sound),
										reasons: [],
										credits: "23",
									},
								],
							),
						).values(),
					]),
				})),
			});
		if (endpoint === "quote") {
			state.quotes++;
			state.quoteRequests.push(body);
			if (state.quoteError)
				return route.fulfill({
					status: 400,
					json: {
						json: {
							defined: false,
							code: "BAD_REQUEST",
							status: 400,
							message: state.quoteError,
							data: { code: state.quoteError },
						},
					},
				});
			return reply({
				quoteId: "ui-mock-quote-1",
				credits: "23",
				expiresAt: new Date(Date.now() + (state.quoteExpired ? -1000 : 60_000)).toISOString(),
				requestFingerprint: "ui-mock-fingerprint",
			});
		}
		if (endpoint === "jobs/create") {
			state.creates.push(body);
			if (state.loseFirstResponse && state.creates.length === 1)
				return route.abort("connectionreset");
			return reply(job);
		}
		if (endpoint === "jobs/get") {
			state.gets++;
			return reply(job);
		}
		if (endpoint === "jobs/list")
			return reply({ items: state.creates.length ? [job] : [], nextCursor: null });
		if (endpoint === "jobs/playback") {
			state.playback++;
			return reply({
				url: "/__video-ui-expired",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			});
		}
		if (endpoint === "uploads/create")
			return reply({
				sessionId: "ui-upload-1",
				assetId: "ui-image-1",
				uploadUrl: `${url.origin}/__video-ui-upload`,
				method: "PUT",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			});
		if (endpoint === "uploads/complete")
			return reply({
				assetId: "ui-image-1",
				status: "VERIFYING",
				uploadStatus: "COMPLETED",
				moderationStatus: "PENDING",
				mimeType: "image/png",
				byteSize: "100",
				width: 64,
				height: 64,
			});
		return route.abort(); // Unrecognized video APIs must never escape the UI Mock boundary.
	});
	const login = await page.request.post("/api/auth/sign-in/email", {
		maxRetries: 2, // Local auth setup only; video submission itself is never auto-retried.
		data: { email: fundedEmail(process.env.E2E_RUN_ID!), password: E2E_PASSWORD },
	});
	expect(login.ok()).toBe(true);
	await page.goto("/video");
	await expect(page.locator('[data-test="video-workspace"]')).toBeVisible();
}

async function quoteAndConfirm(page: Page, doubleClick = false) {
	await page
		.getByLabel("Describe your video", { exact: true })
		.fill("UI mock only: a slow camera above a quiet lake.");
	await page.locator('[data-test="video-quote"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("23 credits");
	if (doubleClick)
		await page.locator('[data-test="video-confirm"]').evaluate((button) => {
			(button as HTMLButtonElement).click();
			(button as HTMLButtonElement).click();
		});
	else await page.locator('[data-test="video-confirm"]').click();
}

async function selectSetting(page: Page, label: string, value: string) {
	if (label === "Video model") {
		await page.getByRole("button", { name: label, exact: true }).click();
		await page
			.getByRole("button", {
				name: VIDEO_MODEL_CATALOG.find((model) => model.productKey === value)!.label,
				exact: true,
			})
			.click();
	} else {
		await page.getByRole("button", { name: "Video settings", exact: true }).click();
		await page.getByLabel(label, { exact: true }).selectOption(value);
		await page.getByRole("button", { name: "Done", exact: true }).click();
	}
}

test("UI Mock: text confirmation, refresh, closed-page recovery and private playback authorization", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	await setup(context, page, state);
	await quoteAndConfirm(page, true);
	await expect(page.locator('[data-test="video-job"]')).toHaveAttribute("data-stage", "QUEUED");
	expect(state.creates).toHaveLength(1);
	expect(state.creates[0]!.request as { sound: boolean; duration: number }).toMatchObject({
		sound: false,
		duration: 5,
	});
	await page.reload();
	await expect(page.locator('[data-test="video-job"]')).toHaveAttribute("data-stage", "QUEUED");
	await page.close();
	await context.clearCookies();
	state.stage = "OUTPUT_REVIEW";
	const reopened = await context.newPage();
	await reopened.goto("/video/history");
	await expect(reopened).toHaveURL(/\/login/);
	const login = await reopened.request.post("/api/auth/sign-in/email", {
		data: { email: fundedEmail(process.env.E2E_RUN_ID!), password: E2E_PASSWORD },
	});
	expect(login.ok()).toBe(true);
	await reopened.goto("/video/history");
	await expect(reopened.getByText("Reviewing the saved video", { exact: true })).toBeVisible();
	await reopened.getByText("Reviewing the saved video", { exact: true }).click();
	await expect(reopened.locator("video")).toHaveCount(0);
	await reopened.screenshot({
		path: testInfo.outputPath("desktop-output-review.png"),
		fullPage: true,
		animations: "disabled",
	});
	state.stage = "READY";
	await expect(reopened.getByText("Ready to play", { exact: true })).toBeVisible();
	await expect.poll(() => state.playback).toBeGreaterThan(0);
	await expect(reopened.getByRole("button", { name: "Refresh playback access" })).toBeVisible();
	const before = state.playback;
	await reopened.getByRole("button", { name: "Refresh playback access" }).click();
	await expect.poll(() => state.playback).toBeGreaterThan(before);
	await reopened.close();
});

test("UI Mock: interrupted confirmation retains its exact key through reload", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.loseFirstResponse = true;
	await setup(context, page, state);
	await quoteAndConfirm(page);
	await expect(page.getByRole("button", { name: "Check the same request" })).toBeEnabled();
	await page.reload();
	await page.getByRole("button", { name: "Check the same request" }).click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
	expect(state.quotes).toBe(1);
});

test("UI Mock: all model settings invalidate the quote and restore the exact pending receipt", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.loseFirstResponse = true;
	await page.setViewportSize({ width: 1440, height: 1100 });
	await setup(context, page, state);
	await page
		.getByLabel("Describe your video", { exact: true })
		.fill("UI mock: a gentle camera over a quiet lake.");
	await page.getByRole("button", { name: "Video model", exact: true }).click();
	await expect(page.locator('[data-test="video-model-menu"] section')).toHaveCount(5);
	await expect(page.getByRole("button", { name: "MiniMax H3 Max", exact: true })).toBeDisabled();
	await page.screenshot({
		path: testInfo.outputPath("desktop-model-families-fixture.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await page.locator('[data-test="video-quote"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toBeVisible();
	const changes = [
		["Video model", "video-seedance-2-5"],
		["Duration", "6"],
		["Resolution", "1080p"],
		["Frame shape", "9:16"],
		["Audio", "true"],
	] as const;
	for (const [label, value] of changes) {
		const before = state.quotes;
		await selectSetting(page, label, value);
		await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
		expect(state.quotes).toBe(before);
		expect(state.creates).toHaveLength(0);
		await page.locator('[data-test="video-quote"]').click();
		await expect(page.locator('[data-test="video-confirm"]')).toBeVisible();
	}
	await page.getByRole("button", { name: "Video settings", exact: true }).click();
	await page.screenshot({
		path: testInfo.outputPath("desktop-video-settings-fixture.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.getByRole("button", { name: "Check the same request" })).toBeEnabled();
	const expected = {
		productKey: "video-seedance-2-5",
		mode: "text-to-video",
		duration: 6,
		resolution: "1080p",
		aspectRatio: "9:16",
		sound: true,
	};
	expect(state.creates[0]!.request).toMatchObject(expected);
	await page.reload();
	await expect(page.locator("#video-model")).toHaveAttribute(
		"data-product-key",
		"video-seedance-2-5",
	);
	await page.getByRole("button", { name: "Video settings", exact: true }).click();
	for (const [label, value] of changes.slice(1))
		await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page.getByRole("button", { name: "Check the same request" }).click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
	expect(state.quoteRequests.at(-1)).toMatchObject(expected);
	expect(state.quotes).toBe(6);
});

test("UI Mock: missing sound readiness disables only affected options and prevents a native-audio quote", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.blockedSound = true;
	await setup(context, page, state);
	await page.getByRole("button", { name: "Video settings", exact: true }).click();
	await expect(page.locator('#video-sound option[value="true"]')).toBeDisabled();
	await expect(page.locator('#video-sound option[value="false"]')).toBeEnabled();
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await selectSetting(page, "Video model", "video-minimax-h3");
	await page.getByRole("button", { name: "Video settings", exact: true }).click();
	await expect(page.getByLabel("Audio", { exact: true })).toHaveValue("true");
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await expect(page.locator('[data-test="video-quote"]')).toBeDisabled();
	await expect(
		page.getByText("This model may include native audio and has no sound switch."),
	).toBeVisible();
	expect(state.quotes).toBe(0);
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: image sealing remains pending review on a narrow screen", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	await page.setViewportSize({ width: 390, height: 844 });
	await setup(context, page, state);
	await page.getByLabel("Input", { exact: true }).selectOption("image-to-video");
	await page.locator("#video-image").setInputFiles({
		name: "reference.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=",
			"base64",
		),
	});
	await expect(
		page.getByText("Image secured. Content review starts after you confirm generation."),
	).toBeVisible();
	expect(state.quotes).toBe(0);
	expect(state.creates).toHaveLength(0);
	await page.getByRole("button", { name: "Video settings", exact: true }).click();
	await expect(page.getByLabel("Frame shape")).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("mobile-video-settings-fixture.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByLabel("Describe movement and camera direction")
		.fill("UI mock only: move the camera slowly.");
	await page.locator('[data-test="video-quote"]').click();
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates[0]!.request).toMatchObject({
		mode: "image-to-video",
		inputAssetId: "ui-image-1",
		sound: false,
		duration: 5,
	});
	expect(state.creates[0]!.request).toHaveProperty("aspectRatio", "source");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("mobile-image-queued.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("UI Mock: disabled intake keeps history and tasks readable", async ({ context, page }) => {
	const state = scenario();
	state.available = false;
	state.creates.push({});
	state.stage = "GENERATING";
	await setup(context, page, state);
	await expect(page.locator('[data-test="video-quote"]')).toBeDisabled();
	await page.goto("/video/history");
	await page.getByText("Generating your video", { exact: true }).click();
	await expect(page.locator('[data-test="video-job"]')).toHaveAttribute("data-stage", "GENERATING");
	await expect(page.locator('[data-test="video-quote"]')).toBeDisabled();
});

test("UI Mock: rejection reports released credits without a paid retry", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.stage = "REJECTED";
	await setup(context, page, state);
	await quoteAndConfirm(page);
	await expect(page.locator('[data-test="video-job"]')).toContainText("23 credits released");
	await expect(page.locator('[data-test="video-job"] button')).toHaveCount(0);
	await expect(page.locator("video")).toHaveCount(0);
});

test("UI Mock: insufficient credits and expired quotes never submit a task", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.quoteError = "INSUFFICIENT_CREDITS";
	await setup(context, page, state);
	await page.getByLabel("Describe your video", { exact: true }).fill("UI mock: a slow camera.");
	await page.locator('[data-test="video-quote"]').click();
	await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toContainText(
		"not enough eligible paid credits",
	);
	state.quoteError = null;
	state.quoteExpired = true;
	await page.locator('[data-test="video-quote"]').click();
	await expect(
		page.getByText("The quote expired or is no longer valid. Review the current cost again."),
	).toBeVisible();
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: uncertainty keeps credits reserved and hidden tabs pause status polling", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.stage = "SUBMISSION_UNCERTAIN";
	await setup(context, page, state);
	await quoteAndConfirm(page);
	await expect(page.locator('[data-test="video-job"]')).toContainText("23 credits reserved");
	await expect(page.locator('[data-test="video-job"] button')).toHaveCount(0);
	await expect.poll(() => state.gets).toBeGreaterThan(0);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForTimeout(150); // Let an already-started read finish before measuring absence.
	const previous = state.gets;
	await page.waitForTimeout(2300); // A complete active polling interval is the observation window.
	expect(state.gets).toBe(previous);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => state.gets).toBeGreaterThan(previous);
	expect(state.creates).toHaveLength(1);
});

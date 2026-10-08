import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import {
	getVideoModelOptions,
	getVideoVariantGroup,
	VIDEO_MODEL_CATALOG,
} from "@repo/config/video-models";
import type { VideoRetailDisplay } from "@repo/config/video-pricing.server";

import approvedRetail from "../../../../packages/config/fixtures/video-retail-approved-2026-10-08.json";
import { E2E_PASSWORD, fundedEmail } from "../../../../tooling/e2e/src/fixtures";

const test = base.extend<
	{},
	{ videoAuthState: Awaited<ReturnType<BrowserContext["storageState"]>> }
>({
	videoAuthState: [
		async ({ playwright }, use, workerInfo) => {
			const auth = await playwright.request.newContext({
				baseURL: workerInfo.project.use.baseURL,
			});
			try {
				const login = await auth.post("/api/auth/sign-in/email", {
					data: { email: fundedEmail(process.env.E2E_RUN_ID!), password: E2E_PASSWORD },
				});
				expect(login.ok()).toBe(true);
				await use(await auth.storageState());
			} finally {
				await auth.dispose();
			}
		},
		{ scope: "worker" },
	],
	// Each test receives a fresh context and scenario state with the same real login.
	storageState: async ({ videoAuthState }, use) => {
		await use(videoAuthState);
	},
});

type MockStage =
	| "QUEUED"
	| "GENERATING"
	| "SUBMISSION_UNCERTAIN"
	| "OUTPUT_REVIEW"
	| "READY"
	| "REJECTED";
type Scenario = {
	pricingValidUntil: string | null;
	retailAudience: "standard" | "annual" | null;
	quoteAudience: "standard" | "annual" | null;
	acceptedPricing: VideoRetailDisplay | null;
	stage: MockStage;
	available: boolean;
	creates: Array<Record<string, unknown>>;
	quotes: number;
	catalogReads: number;
	gets: number;
	playback: number;
	loseFirstResponse: boolean;
	quoteError: string | null;
	createError: string | null;
	quoteCredits: string;
	quoteExpired: boolean;
	quoteRequests: Array<Record<string, unknown>>;
	blockedSound: boolean;
	disabledModelKey?: string;
	omittedCatalogOptionKey?: string;
};
function scenario(): Scenario {
	return {
		pricingValidUntil: null,
		retailAudience: null,
		quoteAudience: null,
		acceptedPricing: null,
		stage: "QUEUED",
		available: true,
		creates: [],
		quotes: 0,
		catalogReads: 0,
		gets: 0,
		playback: 0,
		loseFirstResponse: false,
		quoteError: null,
		createError: null,
		quoteCredits: "23",
		quoteExpired: false,
		quoteRequests: [],
		blockedSound: false,
	};
}

const retailKey = (selection: Record<string, unknown>) =>
	[
		selection.productKey,
		selection.mode,
		selection.duration,
		selection.resolution,
		selection.sound,
		selection.veoTier ?? "",
	].join(":");
const retailRows = new Map(approvedRetail.rows.map((row) => [retailKey(row.selection), row]));
function retailPrice(selection: Record<string, unknown>, audience: "standard" | "annual" | null) {
	const row = retailRows.get(retailKey(selection));
	if (!row || !audience) return null;
	const credits = audience === "annual" ? row.annualCredits : row.standardCredits;
	return {
		credits,
		pricing: {
			policyVersion: approvedRetail.version,
			audience,
			credits,
			standardCredits: row.standardCredits,
			annualCredits: row.annualCredits,
			savedCredits: String(BigInt(row.standardCredits) - BigInt(credits)),
			annualSavingsCredits: String(BigInt(row.standardCredits) - BigInt(row.annualCredits)),
		} satisfies VideoRetailDisplay,
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
			...(state.acceptedPricing
				? { credits: state.acceptedPricing.credits, pricing: state.acceptedPricing }
				: {}),
		};
		const reply = (json: unknown) => route.fulfill({ json: { json } });
		const reject = (code: string) =>
			route.fulfill({
				status: 400,
				json: {
					json: { defined: false, code: "BAD_REQUEST", status: 400, message: code, data: { code } },
				},
			});
		if (endpoint === "catalog") {
			state.catalogReads++;
			return reply({
				available: state.available,
				accessAllowed: true,
				pricingValidUntil: state.pricingValidUntil,
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
					available:
						state.available &&
						model.status === "implemented" &&
						model.productKey !== state.disabledModelKey,
					reasons: [],
					options: model.modes
						.flatMap((mode) => [
							...new Map(
								getVideoModelOptions(model.productKey, mode).map(
									({ duration, resolution, sound, veoTier }) => [
										`${duration}:${resolution}:${sound}:${veoTier ?? ""}`,
										{
											duration,
											resolution,
											sound,
											...(veoTier ? { veoTier } : {}),
											mode,
											available: state.available && !(state.blockedSound && sound),
											reasons: [],
											credits: "23",
											...retailPrice(
												{
													productKey: model.productKey,
													mode,
													duration,
													resolution,
													sound,
													veoTier,
												},
												state.retailAudience,
											),
										},
									],
								),
							).values(),
						])
						.filter(
							(option) =>
								retailKey({ productKey: model.productKey, ...option }) !==
								state.omittedCatalogOptionKey,
						),
				})),
			});
		}
		if (endpoint === "quote") {
			state.quotes++;
			state.quoteRequests.push(body);
			if (state.quoteError) return reject(state.quoteError);
			return reply({
				quoteId: `ui-mock-quote-${state.quotes}`,
				credits: state.quoteCredits,
				expiresAt: new Date(Date.now() + (state.quoteExpired ? -1000 : 60_000)).toISOString(),
				requestFingerprint: "ui-mock-fingerprint",
				...retailPrice(body, state.quoteAudience ?? state.retailAudience),
			});
		}
		if (endpoint === "jobs/create") {
			state.acceptedPricing ??=
				retailPrice(body.request, state.quoteAudience ?? state.retailAudience)?.pricing ?? null;
			state.creates.push(body);
			if (state.loseFirstResponse && state.creates.length === 1)
				return route.abort("connectionreset");
			if (state.createError) return reject(state.createError);
			return reply({
				...job,
				...(state.acceptedPricing
					? { credits: state.acceptedPricing.credits, pricing: state.acceptedPricing }
					: {}),
			});
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
	await page.goto("/video");
	await expect(page.locator('[data-test="video-workspace"]')).toBeVisible();
}

async function quoteAndConfirm(page: Page, doubleClick = false) {
	await page
		.getByLabel("Describe your video", { exact: true })
		.fill("UI mock only: a slow camera above a quiet lake.");
	if (doubleClick)
		await page.locator('[data-test="video-generate"]').evaluate((button) => {
			(button as HTMLButtonElement).click();
			(button as HTMLButtonElement).click();
		});
	else await page.locator('[data-test="video-generate"]').click();
}

for (const catalogCase of [
	"available target",
	"disabled target",
	"missing target quote",
] as const) {
	test(`UI Mock: model-owned annual badges with ${catalogCase}`, async ({ context, page }) => {
		const state = scenario();
		state.retailAudience = "standard";
		if (catalogCase === "disabled target") state.disabledModelKey = "video-minimax-h3";
		if (catalogCase === "missing target quote")
			state.omittedCatalogOptionKey = retailKey({
				productKey: "video-minimax-h3",
				mode: "text-to-video",
				duration: 10,
				resolution: "768p",
				sound: true,
			});
		await setup(context, page, state);
		await selectSetting(page, "Duration", "10");
		await expect(page.locator('[data-test="video-retail-price"]').first()).toContainText(
			"Standard 119 credits",
		);
		await page.getByRole("button", { name: "Video model", exact: true }).click();
		const menu = page.locator('[data-test="video-model-menu"]');
		await expect(menu.getByRole("button", { name: "Kling 2.6", exact: true })).toContainText(
			"Annual −15.9%",
		);
		await menu.getByRole("button", { name: "MiniMax", exact: true }).click();
		const supportedModel = menu.getByRole("button", { name: "MiniMax H3", exact: true });
		if (catalogCase === "available target") {
			await expect(supportedModel).toBeEnabled();
			await expect(supportedModel.locator(".video-annual-badge")).toHaveText("Annual −17.3%");
		} else {
			await expect(supportedModel.locator(".video-annual-badge")).toHaveCount(0);
			if (catalogCase === "disabled target") await expect(supportedModel).toBeDisabled();
		}
		for (const name of ["MiniMax H3 Turbo", "MiniMax H3 Max Turbo", "MiniMax H3 Max"]) {
			const blocked = menu.getByRole("button", { name, exact: true });
			await expect(blocked).toBeDisabled();
			await expect(blocked.locator(".video-annual-badge")).toHaveCount(0);
		}
		expect(state.quotes).toBe(0);
		expect(state.creates).toHaveLength(0);
	});
}

for (const viewport of [
	{ width: 1440, height: 1050 },
	{ width: 390, height: 844 },
]) {
	test(`UI Mock: annual video prices, model badge and draft return at ${viewport.width}px`, async ({
		context,
		page,
	}, testInfo) => {
		const state = scenario();
		state.retailAudience = "annual";
		await page.setViewportSize(viewport);
		await setup(context, page, state);
		await page
			.getByLabel("Describe your video", { exact: true })
			.fill("A sailboat crosses a calm lake at sunrise.");
		await selectSetting(page, "Video model", "video-seedance-2-mini");
		await selectSetting(page, "Resolution", "720p");
		const price = page.locator('[data-test="video-retail-price"]').first();
		await expect(price).toContainText("Annual 66 credits");
		await expect(price.locator("s")).toHaveText("96 credits");
		await expect(price).toContainText("Save 30 credits (31.2%)");
		await expect(page.locator('[data-test="video-annual-banner"]')).toContainText(
			"standard 96 credits · annual 66 credits",
		);
		await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 66 credits");
		await page.locator('[data-test="video-composer"]').screenshot({
			path: testInfo.outputPath(`annual-${viewport.width}-composer.png`),
			animations: "disabled",
		});
		await page.getByRole("button", { name: "Video model", exact: true }).click();
		await expect(
			page
				.locator('[data-test="video-model-menu"]')
				.getByRole("button", { name: "Seedance 2", exact: true }),
		).toContainText("Annual −31.2%");
		await page.locator('[data-test="video-model-menu"]').screenshot({
			path: testInfo.outputPath(`annual-${viewport.width}-model.png`),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
		await page.locator('[data-generator-mode="image"]').filter({ visible: true }).click();
		await expect(page.locator('[data-generation-mode="image"]')).toBeVisible();
		await page.goBack();
		await expect(page.getByLabel("Describe your video", { exact: true })).toHaveValue(
			"A sailboat crosses a calm lake at sunrise.",
		);
		await expect(price).toContainText("Annual 66 credits");
		await selectSetting(page, "Duration", "4");
		await selectSetting(page, "Resolution", "480p");
		await expect(price).toContainText("24 credits");
		await expect(price.locator("s")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Lite", exact: true })).toHaveCount(0);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		expect(state.creates).toHaveLength(0);
	});
}

test("UI Mock: changed annual qualification refreshes the catalog and survives parameter editing", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.retailAudience = "annual";
	await setup(context, page, state);
	await selectSetting(page, "Video model", "video-seedance-2-mini");
	await selectSetting(page, "Resolution", "720p");
	const previousReads = state.catalogReads;
	state.retailAudience = "standard";
	state.quoteAudience = "standard";
	await quoteAndConfirm(page, true);
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("96");
	expect(state.creates).toHaveLength(0);
	expect(state.quotes).toBe(1);
	await expect(page.locator('[data-test="video-retail-price"]').first().locator("s")).toHaveCount(
		0,
	);
	await expect.poll(() => state.catalogReads).toBeGreaterThan(previousReads);
	await expect(page.locator('[data-test="video-confirm"]')).toBeEnabled();
	await page.getByLabel("Describe your video", { exact: true }).fill("A new sailboat scene.");
	await selectSetting(page, "Frame shape", "9:16");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 96 credits");
	await expect(page.locator('[data-test="video-annual-banner"]')).not.toContainText(
		"Your annual video pricing is active",
	);
	await page.locator('[data-test="video-composer"]').screenshot({
		path: testInfo.outputPath("annual-qualification-refreshed.png"),
		animations: "disabled",
	});
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: annual qualification refreshes while continuously foregrounded", async ({
	context,
	page,
}) => {
	const state = scenario();
	state.retailAudience = "annual";
	await page.clock.install();
	await setup(context, page, state);
	await selectSetting(page, "Video model", "video-seedance-2-mini");
	await selectSetting(page, "Resolution", "720p");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 66 credits");
	const previousReads = state.catalogReads;
	state.retailAudience = "standard";
	await page.clock.fastForward(31_000);
	await expect.poll(() => state.catalogReads).toBeGreaterThan(previousReads);
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 96 credits");
	await selectSetting(page, "Frame shape", "9:16");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 96 credits");
	expect(state.quotes).toBe(0);
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: accepted annual savings stay frozen after qualification changes and reload", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.retailAudience = "annual";
	await setup(context, page, state);
	await selectSetting(page, "Video model", "video-seedance-2-mini");
	await selectSetting(page, "Resolution", "720p");
	await page.getByLabel("Describe your video", { exact: true }).fill("A new sailboat scene.");
	state.quoteAudience = null;
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-job"]')).toContainText("66 credits reserved");
	state.retailAudience = "standard";
	await page.reload();
	await expect(page.locator('[data-test="video-job"]')).toContainText("Save 30 credits (31.2%)");
	await page.screenshot({
		path: testInfo.outputPath("annual-frozen-receipt.png"),
		fullPage: false,
		animations: "disabled",
	});
	expect(state.creates).toHaveLength(1);
});

test("UI Mock: standard annual offer opens yearly plans and closing preserves the draft", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.retailAudience = "standard";
	await setup(context, page, state);
	await selectSetting(page, "Video model", "video-seedance-2-mini");
	await selectSetting(page, "Resolution", "720p");
	await page.getByLabel("Describe your video", { exact: true }).fill("A lake at sunset.");
	const price = page.locator('[data-test="video-retail-price"]').first();
	await expect(price).toContainText("Standard 96 credits");
	await expect(price).toContainText("Annual 66 credits");
	await expect(price.locator("s")).toHaveCount(0);
	await page.locator('[data-test="video-composer"]').screenshot({
		path: testInfo.outputPath("standard-annual-offer.png"),
		animations: "disabled",
	});
	await page.getByRole("button", { name: "View annual plans", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Yearly", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page.getByLabel("Describe your video", { exact: true })).toHaveValue(
		"A lake at sunset.",
	);
	await expect(price).toContainText("Standard 96 credits");
	expect(state.quotes).toBe(0);
	expect(state.creates).toHaveLength(0);
});

async function selectSetting(page: Page, label: string, value: string) {
	if (label === "Video model") {
		await page.getByRole("button", { name: label, exact: true }).click();
		await page
			.getByRole("button", {
				name: VIDEO_MODEL_CATALOG.find((model) => model.productKey === value)!.family,
				exact: true,
			})
			.click();
		await page
			.getByRole("button", {
				name:
					getVideoVariantGroup(value)?.label ??
					VIDEO_MODEL_CATALOG.find((model) => model.productKey === value)!.label,
				exact: true,
			})
			.click();
	} else if (label === "Audio") {
		const toggle = page.getByRole("switch", { name: label, exact: true });
		if ((await toggle.getAttribute("aria-checked")) !== value) await toggle.click();
	} else {
		await page.getByRole("button", { name: "Video settings", exact: true }).click();
		const radio = page
			.getByRole("group", { name: label, exact: true })
			.locator(`input[value="${value}"]`);
		await radio.locator("..").click();
		await expect(radio).toBeChecked();
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
}, testInfo) => {
	const state = scenario();
	state.loseFirstResponse = true;
	await setup(context, page, state);
	await quoteAndConfirm(page);
	await expect(page.getByRole("button", { name: "Check the same request" })).toBeEnabled();
	await expect.poll(() => pendingConfirmations(page)).toHaveLength(1);
	await page.evaluate(() => {
		for (const key of Object.keys(sessionStorage).filter((entry) =>
			entry.startsWith("video-v1:confirmation:"),
		)) {
			const confirmation = JSON.parse(sessionStorage.getItem(key)!);
			confirmation.quote.expiresAt = "2000-01-01T00:00:00.000Z";
			sessionStorage.setItem(key, JSON.stringify(confirmation));
		}
	});
	state.available = false;
	await page.reload();
	await expect(page.getByRole("button", { name: "Check the same request" })).toBeEnabled();
	await page.screenshot({
		path: testInfo.outputPath("uncertain-replay-after-catalog-and-quote-expiry.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Check the same request" }).click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
	expect(state.quotes).toBe(1);
});

async function pendingConfirmations(page: Page) {
	return page.evaluate(() =>
		Object.keys(sessionStorage)
			.filter((key) => key.startsWith("video-v1:confirmation:"))
			.map((key) => sessionStorage.getItem(key)),
	);
}

test("UI Mock: changed pricing requires a fresh quote and explicit confirmation with a new key", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.createError = "PRICE_CHANGED";
	await setup(context, page, state);
	await quoteAndConfirm(page);
	await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toContainText(
		"Review the current cost again",
	);
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	await expect.poll(() => pendingConfirmations(page)).toEqual([]);
	await expect.poll(() => state.catalogReads).toBe(2);
	expect(state.creates).toHaveLength(1);
	await page.screenshot({
		path: testInfo.outputPath("changed-price-rejected-quote-cleared.png"),
		fullPage: true,
		animations: "disabled",
	});
	const original = state.creates[0]!;
	state.createError = null;
	state.quoteCredits = "29";
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("29 credits");
	expect(state.quotes).toBe(2);
	expect(state.creates).toHaveLength(1);
	await expect.poll(() => pendingConfirmations(page)).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("changed-price-awaiting-new-confirmation.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]!.quoteId).not.toBe(original.quoteId);
	expect(state.creates[1]!.idempotencyKey).not.toBe(original.idempotencyKey);
	expect(state.creates[1]!.request).toEqual(original.request);
});

for (const code of ["VIDEO_MODEL_PRICE_EXPIRED", "VIDEO_PRICE_EXPIRED"]) {
	test(`UI Mock: ${code} clears a rejected stored confirmation and refreshes availability`, async ({
		context,
		page,
	}, testInfo) => {
		const state = scenario();
		state.loseFirstResponse = true;
		await setup(context, page, state);
		await quoteAndConfirm(page);
		await expect(page.getByRole("button", { name: "Check the same request" })).toBeEnabled();
		await expect.poll(() => pendingConfirmations(page)).toHaveLength(1);
		state.createError = code;
		state.available = false;
		await page.getByRole("button", { name: "Check the same request" }).click();
		await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toHaveText(
			"Video pricing is temporarily unavailable. Please check back later.",
		);
		await expect.poll(() => pendingConfirmations(page)).toEqual([]);
		await expect.poll(() => state.catalogReads).toBe(2);
		await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
		await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
		expect(state.creates).toHaveLength(2);
		expect(state.creates[1]).toEqual(state.creates[0]);
		expect(state.quotes).toBe(1);
		await page.screenshot({
			path: testInfo.outputPath(`${code.toLowerCase()}-confirmation-cleared.png`),
			fullPage: true,
			animations: "disabled",
		});
		await page.reload();
		await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
		await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
		expect(state.creates).toHaveLength(2);
	});

	test(`UI Mock: ${code} during requote clears the old quote and refreshes availability`, async ({
		context,
		page,
	}, testInfo) => {
		const state = scenario();
		state.quoteExpired = true;
		await setup(context, page, state);
		await page.getByLabel("Describe your video", { exact: true }).fill("UI mock: a slow camera.");
		await page.locator('[data-test="video-generate"]').click();
		await expect(page.getByText("23 credits for this video", { exact: true })).toBeVisible();
		await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
		state.quoteError = code;
		state.available = false;
		await page.getByRole("button", { name: "Generate · 23 credits", exact: true }).click();
		await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toHaveText(
			"Video pricing is temporarily unavailable. Please check back later.",
		);
		await expect(page.getByText("23 credits for this video", { exact: true })).toHaveCount(0);
		await expect.poll(() => state.catalogReads).toBe(2);
		await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
		await expect.poll(() => pendingConfirmations(page)).toEqual([]);
		expect(state.creates).toHaveLength(0);
		expect(state.quotes).toBe(2);
		await page.screenshot({
			path: testInfo.outputPath(`${code.toLowerCase()}-requote-cleared.png`),
			fullPage: true,
			animations: "disabled",
		});
	});
}

test("UI Mock: all model settings invalidate the quote and restore the exact pending receipt", async ({
	context,
	page,
}, testInfo) => {
	const state = scenario();
	state.loseFirstResponse = true;
	state.quoteCredits = "29"; // Explicitly stage changed-price quotes for invalidation coverage.
	await page.setViewportSize({ width: 1440, height: 1100 });
	await setup(context, page, state);
	await page
		.getByLabel("Describe your video", { exact: true })
		.fill("UI mock: a gentle camera over a quiet lake.");
	await page.getByRole("button", { name: "Video model", exact: true }).click();
	await expect(page.locator(".video-model-families button")).toHaveCount(5);
	await page.getByRole("button", { name: "MiniMax", exact: true }).click();
	await expect(page.getByRole("button", { name: "MiniMax H3 Max", exact: true })).toBeDisabled();
	await page.screenshot({
		path: testInfo.outputPath("desktop-model-families-fixture.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await page.locator('[data-test="video-generate"]').click();
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
		await page.locator('[data-test="video-generate"]').click();
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
	await expect(page.getByRole("button", { name: "Video settings", exact: true })).toBeDisabled();
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("9:16");
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("6s");
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("1080P");
	await expect(page.getByRole("switch", { name: "Audio", exact: true })).toBeChecked();
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
	await expect(page.getByRole("switch", { name: "Audio", exact: true })).toBeDisabled();
	await expect(page.getByRole("switch", { name: "Audio", exact: true })).not.toBeChecked();
	await selectSetting(page, "Video model", "video-minimax-h3");
	await expect(page.getByRole("switch", { name: "Audio", exact: true })).toHaveCount(0);
	await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
	await expect(
		page.getByTitle("This model may include native audio and has no sound switch."),
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
	const fileInput = page.locator("#video-image");
	await expect(fileInput).toBeEnabled();
	await fileInput.setInputFiles({
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
	await expect(
		page.getByRole("group", { name: "Frame shape", exact: true }).getByRole("radio"),
	).toHaveCount(1);
	await page.screenshot({
		path: testInfo.outputPath("mobile-video-settings-fixture.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page
		.getByLabel("Describe movement and camera direction")
		.fill("UI mock only: move the camera slowly.");
	await page.locator('[data-test="video-generate"]').click();
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
	await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
	await page.goto("/video/history");
	await page.getByText("Generating your video", { exact: true }).click();
	await expect(page.locator('[data-test="video-job"]')).toHaveAttribute("data-stage", "GENERATING");
	await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
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
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toContainText(
		"not enough eligible paid credits",
	);
	state.quoteError = null;
	state.quoteExpired = true;
	await page.locator('[data-test="video-generate"]').click();
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

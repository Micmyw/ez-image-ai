import { expect, test, type Page } from "@playwright/test";

import en from "../../../packages/i18n/translations/en/saas.json";

const path = "/video-effects/hotel-lobby-ai";
const t = en.videoEffects;
const source = {
	name: "authorized-ui-fixture.png",
	mimeType: "image/png",
	buffer: Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU2sAAAAASUVORK5CYII=",
		"base64",
	),
};
type Scenario = {
	signedIn: boolean;
	available: boolean;
	expired: boolean;
	insufficient: boolean;
	loseFirst: boolean;
	slowUpload: boolean;
	uploads: number;
	completed: number;
	quotes: Array<Record<string, unknown>>;
	creates: Array<Record<string, unknown>>;
	playback: number;
};
const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
	signedIn: true,
	available: true,
	expired: false,
	insufficient: false,
	loseFirst: false,
	slowUpload: false,
	uploads: 0,
	completed: 0,
	quotes: [],
	creates: [],
	playback: 0,
	...patch,
});

async function setup(page: Page, state: Scenario) {
	await page
		.context()
		.addCookies([
			{ name: "consent", value: "false", url: test.info().project.use.baseURL as string },
		]);
	await page.route("**/api/auth/get-session**", (route) =>
		route.fulfill({
			json: state.signedIn
				? {
						session: {
							id: "mock-session",
							userId: "mock-owner",
							token: "local-fixture-only",
							expiresAt: "2030-01-01T00:00:00Z",
							createdAt: "2026-10-05T00:00:00Z",
							updatedAt: "2026-10-05T00:00:00Z",
						},
						user: {
							id: "mock-owner",
							name: "Local UI fixture",
							email: "ui@example.invalid",
							emailVerified: true,
							role: "user",
							isAnonymous: false,
							onboardingComplete: true,
							createdAt: "2026-10-05T00:00:00Z",
							updatedAt: "2026-10-05T00:00:00Z",
						},
					}
				: null,
		}),
	);
	await page.route("**/api/rpc/**", async (route) => {
		const url = new URL(route.request().url());
		const endpoint = url.pathname.split("/api/rpc/")[1];
		const body = route.request().method() === "POST" ? route.request().postDataJSON()?.json : null;
		const reply = (json: unknown) => route.fulfill({ json: { json } });
		const failure = (message: string) =>
			route.fulfill({
				status: 400,
				json: {
					json: {
						defined: false,
						code: "BAD_REQUEST",
						status: 400,
						message,
						data: { code: message },
					},
				},
			});
		if (endpoint === "media/getCreditAccount")
			return reply({ spendableCredits: "120", reservedCredits: "0" });
		if (endpoint === "media/getPublicCatalog") return reply({ products: [] });
		if (endpoint === "payments/listPurchases") return reply([]);
		if (endpoint === "videoV1/catalog")
			return reply({ available: false, accessAllowed: false, models: [], reasons: [] });
		if (endpoint === "videoEffects/access")
			return reply({
				effectId: "hotel-lobby-duo",
				available: state.available,
				accessAllowed: true,
				reasons: [],
				credits: state.available ? "24" : null,
				maxInputBytes: 10_000_000,
			});
		if (endpoint === "videoEffects/uploads/create") {
			state.uploads++;
			return reply({
				sessionId: `upload-${state.uploads}`,
				assetId: `asset-${state.uploads}`,
				uploadUrl: `${url.origin}/__hotel-lobby-upload`,
				method: "PUT",
				expiresAt: "2030-01-01T00:00:00Z",
			});
		}
		if (endpoint === "videoEffects/uploads/complete") {
			state.completed++;
			return reply({
				assetId: `asset-${String(body.sessionId).split("-").at(-1)}`,
				status: "VERIFYING",
				uploadStatus: "COMPLETED",
				moderationStatus: "PENDING",
				mimeType: "image/png",
				byteSize: "64",
				width: 1,
				height: 1,
			});
		}
		if (endpoint === "videoEffects/inputs/get")
			return reply({
				sealed: true,
				assetId: "restored",
				mimeType: "image/png",
				byteSize: "64",
				width: 1,
				height: 1,
				previewUrl: null,
				previewExpiresAt: null,
			});
		if (endpoint === "videoEffects/quote") {
			state.quotes.push(body);
			return reply({
				quoteId: `quote-${state.quotes.length}`,
				credits: "24",
				expiresAt: new Date(Date.now() + (state.expired ? -1000 : 60_000)).toISOString(),
			});
		}
		const job = {
			jobId: "mock-template-job",
			effectId: "hotel-lobby-duo",
			name: "Hotel Lobby duo",
			presetKey: "standard",
			templateVersion: "1",
			stage: "CREATING_SCENE",
			creditState: "RESERVED",
			credits: "24",
			canPlay: false,
			failureCode: null,
			updatedAt: "2026-10-05T00:00:00Z",
		};
		if (endpoint === "videoEffects/jobs/create") {
			state.creates.push(body);
			if (state.insufficient) return failure("INSUFFICIENT_ELIGIBLE_CREDITS");
			if (state.loseFirst && state.creates.length === 1) return route.abort("connectionreset");
			return reply(job);
		}
		if (endpoint === "videoEffects/jobs/get") return reply(job);
		if (endpoint === "videoEffects/jobs/list")
			return reply({ items: state.creates.length ? [job] : [], nextCursor: null });
		if (endpoint === "videoEffects/jobs/playback") {
			state.playback++;
			return route.abort();
		}
		// Keep every unrecognized business API inside the local Mock boundary.
		return reply({ items: [], nextCursor: null });
	});
	await page.route("**/__hotel-lobby-upload", async (route) => {
		if (state.slowUpload) await new Promise((resolve) => setTimeout(resolve, 700));
		try {
			await route.fulfill({ status: 200 });
		} catch {
			/* Canceled transfer. */
		}
	});
	await page.goto(path);
	await expect(page.locator(".ve-page h1")).toHaveText("Hotel Lobby AI Video Generator");
}
async function uploadBoth(page: Page) {
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page.locator("#ve-upload-right").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
}
async function quote(page: Page) {
	await page.getByRole("button", { name: t.getQuote, exact: true }).click();
	await expect(
		page.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true }),
	).toBeVisible();
}

test("UI Mock: anonymous template is readable, honest, private and noindex", async ({ page }) => {
	const state = scenario({ signedIn: false });
	await setup(page, state);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new RegExp(`${path}$`),
	);
	await expect(page.locator(".ve-page video")).toHaveCount(0);
	await expect(page.locator(".ve-page select, .ve-page textarea")).toHaveCount(0);
	await expect(page.locator(".ve-page")).toContainText(t.samplesPending);
	await expect(page.locator("#ve-upload-left")).toBeDisabled();
	await expect(page.getByRole("link", { name: t.signIn })).toHaveAttribute(
		"href",
		`/login?redirectTo=${encodeURIComponent(path)}`,
	);
	expect(state.uploads).toBe(0);
	expect(state.creates).toHaveLength(0);
});

for (const width of [1440, 390, 320])
	test(`UI Mock: ${width}px template layout and keyboard access`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 900 });
		await setup(page, scenario({ signedIn: false }));
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
			.toBe(true);
		const signIn = page.getByRole("link", { name: t.signIn });
		await signIn.focus();
		await expect(signIn).toBeFocused();
		await page.keyboard.press("Tab");
		await page.screenshot({
			path: testInfo.outputPath(`hotel-lobby-${width}.png`),
			fullPage: true,
		});
	});

test("UI Mock: sealed left/right roles, keyboard swap, quote invalidation, replacement and upload cancel", async ({
	page,
}) => {
	const state = scenario();
	await setup(page, state);
	await uploadBoth(page);
	await quote(page);
	const swap = page.getByRole("button", { name: t.swap });
	await swap.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: t.getQuote, exact: true })).toBeVisible();
	await quote(page);
	expect(state.quotes.at(-1)?.inputs).toEqual({ leftAssetId: "asset-2", rightAssetId: "asset-1" });
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await quote(page);
	expect(state.quotes.at(-1)?.inputs).toEqual({ leftAssetId: "asset-3", rightAssetId: "asset-1" });
	state.slowUpload = true;
	await page.locator("#ve-upload-right").setInputFiles(source);
	await page.getByRole("button", { name: t.clearPhoto.replace("{role}", t.right) }).click();
	await expect(page.getByRole("button", { name: t.getQuote, exact: true })).toBeDisabled();
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: double click and lost response restore one confirmation after refresh", async ({
	page,
}) => {
	const state = scenario({ loseFirst: true });
	await setup(page, state);
	await uploadBoth(page);
	await quote(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.evaluate((node) => {
			(node as HTMLButtonElement).click();
			(node as HTMLButtonElement).click();
		});
	await expect(page.getByRole("button", { name: t.recover })).toBeVisible();
	expect(state.creates).toHaveLength(1);
	await page.reload();
	await page.getByRole("button", { name: t.recover }).click();
	await expect(page.locator(".ve-result")).toContainText(t.stages.CREATING_SCENE);
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
	expect(state.playback).toBe(0);
	const raw = await page.evaluate(() => sessionStorage.getItem("ezpic.video-effect.v1:mock-owner"));
	expect(raw).not.toMatch(/base64|blob:|uploadUrl|signed|authorized-ui-fixture/);
	expect(JSON.parse(raw!).jobId).toBe("mock-template-job");
	await page.reload();
	await expect(page.locator(".ve-result")).toContainText(t.stages.CREATING_SCENE);
	expect(state.creates).toHaveLength(2);
});

test("UI Mock: expired quote requires another quote; insufficient eligible credits never becomes a job", async ({
	page,
}) => {
	const state = scenario({ expired: true });
	await setup(page, state);
	await uploadBoth(page);
	await page.getByRole("button", { name: t.getQuote, exact: true }).click();
	await expect(page.locator(".ve-creator")).toContainText(t.quoteExpired);
	expect(state.creates).toHaveLength(0);
	state.expired = false;
	state.insufficient = true;
	await quote(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect(page.locator(".ve-creator .ve-error")).toContainText(t.insufficient);
	await expect(page.locator(".ve-result")).toHaveCount(0);
	await page.getByRole("button", { name: t.addCredits, exact: true }).click();
	const saved = await page.evaluate(() =>
		sessionStorage.getItem("ezpic.video-effect.payment-return.v1"),
	);
	expect(JSON.parse(saved!)).toMatchObject({ ownerId: "mock-owner", path });
	await page.reload();
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
});

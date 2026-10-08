import { expect, test, type Page } from "@playwright/test";

import de from "../../../packages/i18n/translations/de/saas.json";
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
	durations?: boolean;
	annual?: boolean;
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
	ordinaryVideoJobRequests: number;
	navigationAvailable?: boolean;
	navigationAvailabilityRequests: number;
	ordinaryCatalogRequests: number;
	eligibleCredits: string;
	quoteCredits: string;
	waitForQuote?: Promise<void>;
	history?: boolean;
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
	ordinaryVideoJobRequests: 0,
	navigationAvailabilityRequests: 0,
	ordinaryCatalogRequests: 0,
	eligibleCredits: "120",
	quoteCredits: "69",
	...patch,
});

function effectPricing(duration: 5 | 10, annual = false) {
	const standardCredits = duration === 5 ? "69" : "116";
	const annualCredits = duration === 5 ? "69" : "101";
	return {
		policyVersion: "video-effect-retail-2026-10-08.1",
		audience: annual ? "annual" : "standard",
		credits: annual ? annualCredits : standardCredits,
		standardCredits,
		annualCredits,
		savedCredits: duration === 10 && annual ? "15" : "0",
		annualSavingsCredits: duration === 10 ? "15" : "0",
	};
}
async function setup(page: Page, state: Scenario) {
	await page.route("**/api/auth/organization/list**", (route) => route.fulfill({ json: [] }));
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
		if (endpoint?.startsWith("videoV1/jobs/")) state.ordinaryVideoJobRequests++;
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
		if (endpoint === "videoV1/availability") {
			state.navigationAvailabilityRequests++;
			return reply({ available: Boolean(state.navigationAvailable) });
		}
		if (endpoint === "videoV1/catalog") {
			state.ordinaryCatalogRequests++;
			return reply({ available: false, accessAllowed: false, models: [], reasons: [] });
		}
		if (endpoint === "videoEffects/access")
			return reply({
				effectId: "hotel-lobby-duo",
				available: state.available,
				accessAllowed: true,
				reasons: [],
				credits: state.available ? "69" : null,
				creditBalance: state.available
					? { totalCredits: "391", eligibleCredits: state.eligibleCredits }
					: null,
				...(state.durations
					? {
							pricing: effectPricing(5, state.annual),
							durationOptions: ([5, 10] as const).map((duration) => ({
								duration,
								credits: effectPricing(duration, state.annual).credits,
								pricing: effectPricing(duration, state.annual),
							})),
						}
					: {}),
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
			if (state.waitForQuote) await state.waitForQuote;
			return reply({
				quoteId: `quote-${state.quotes.length}`,
				credits: state.durations
					? effectPricing(body.duration === 10 ? 10 : 5, state.annual).credits
					: state.quoteCredits,
				...(state.durations
					? { pricing: effectPricing(body.duration === 10 ? 10 : 5, state.annual) }
					: {}),
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
			credits: "69",
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
			return reply({
				items: state.history
					? [{ ...job, jobId: "history-job" }]
					: state.creates.length
						? [job]
						: [],
				nextCursor: null,
			});
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

for (const signedIn of [true, false])
	test(`UI Mock: effect navigation uses only lightweight availability (signed in: ${signedIn})`, async ({
		page,
	}) => {
		const state = scenario({ signedIn, navigationAvailable: true });
		await setup(page, state);
		if (signedIn) {
			await expect(page.locator('.studio-sidebar a[href="/video"]')).toBeVisible();
			expect(state.navigationAvailabilityRequests).toBe(1);
		} else {
			await expect(page.locator(".studio-header-account a[href^='/login']")).toBeVisible();
			expect(state.navigationAvailabilityRequests).toBe(0);
		}
		expect(state.ordinaryCatalogRequests).toBe(0);
		expect(state.quotes).toHaveLength(0);
		expect(state.creates).toHaveLength(0);
	});

test("UI Mock: review-regression history navigation invalidates a pending quote", async ({
	page,
}) => {
	let release!: () => void;
	const state = scenario({
		history: true,
		waitForQuote: new Promise<void>((resolve) => {
			release = resolve;
		}),
	});
	await setup(page, state);
	await uploadBoth(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	await expect.poll(() => state.quotes.length).toBe(1);
	await page.locator(".ve-history-item").first().click();
	await expect(page).toHaveURL(/\?job=history-job/);
	await expect(page.locator(".ve-result")).toBeVisible();
	const quoted = page.waitForResponse((response) => response.url().includes("videoEffects/quote"));
	release();
	await quoted;
	await expect(page.getByRole("button", { name: t.newVideo, exact: true })).toBeEnabled();
	expect(state.creates).toHaveLength(0);
	await page.goBack();
	await expect(page).toHaveURL(path);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await expect(
		page.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true }),
	).toBeEnabled();
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: integrated guest header and mobile menu retain only the safe Hotel task return", async ({
	page,
}, info) => {
	await setup(page, scenario({ signedIn: false }));
	await page.goto(
		`${path}?job=owned-history-job&redirectTo=https%3A%2F%2Fevil.invalid&asset=private`,
	);
	const href = `/login?redirectTo=${encodeURIComponent(`${path}?job=owned-history-job`)}`;
	await expect(page.locator(".studio-header-account a[href^='/login']")).toHaveAttribute(
		"href",
		href,
	);
	// Guest effect pages expose account links in the header and mobile drawer.
	await expect(page.locator(".studio-sidebar")).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-test="header-navigation-trigger"]').click();
	await expect(page.locator(".studio-drawer-signin")).toHaveAttribute("href", href);
	await page.screenshot({
		path: info.outputPath("hotel-safe-login-mobile.png"),
		animations: "disabled",
	});
	await page.locator(".studio-drawer-signin").click();
	await expect(page).toHaveURL(
		new RegExp(`/login\\?redirectTo=${encodeURIComponent(`${path}?job=owned-history-job`)}`),
	);
});

for (const width of [1440, 390, 320])
	test(`UI Mock: ${width}px duration options show real standard and annual totals without a five-second discount`, async ({
		page,
	}, info) => {
		const state = scenario({ durations: true, annual: true });
		await page.setViewportSize({ width, height: 900 });
		await setup(page, state);
		const options = page.locator(".ve-duration");
		await expect(
			options.getByRole("button", { name: "5 seconds 69 credits", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(".ve-plan-prices")).toContainText("Standard: 69 credits");
		await expect(page.locator(".ve-annual-saving")).toHaveCount(0);
		await options.getByRole("button", { name: "10 seconds 101 credits", exact: true }).click();
		await expect(page.locator(".ve-price strong")).toHaveText("101 credits");
		await expect(page.locator(".ve-plan-prices")).toContainText("Standard: 116 credits");
		await expect(page.locator(".ve-annual-saving")).toContainText("15 credits");
		await expect(page.locator(".ve-spec")).toContainText("10 seconds");
		expect(state.quotes).toHaveLength(0);
		expect(state.creates).toHaveLength(0);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page
			.locator(".ve-workbench")
			.screenshot({ path: info.outputPath(`hotel-lobby-10s-${width}.png`) });
	});

test("UI Mock: changing duration invalidates a changed quote and retains sealed photos across refresh", async ({
	page,
}) => {
	const state = scenario({ durations: true, annual: true });
	await setup(page, state);
	await uploadBoth(page);
	await page
		.locator(".ve-duration")
		.getByRole("button", { name: "10 seconds 101 credits", exact: true })
		.click();
	state.annual = false;
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "101"), exact: true })
		.click();
	await expect(page.locator("#ve-price-change")).toBeVisible();
	expect(state.creates).toHaveLength(0);
	await page
		.locator(".ve-duration")
		.getByRole("button", { name: "5 seconds 69 credits", exact: true })
		.click();
	await expect(page.locator("#ve-price-change")).toHaveCount(0);
	await page.reload();
	await expect(
		page.locator(".ve-duration").getByRole("button", { name: "5 seconds 69 credits", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await page
		.locator(".ve-duration")
		.getByRole("button", { name: "10 seconds 116 credits", exact: true })
		.click();
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "116"), exact: true })
		.click();
	await expect(page.locator(".ve-result h2")).toHaveText(t.stages.CREATING_SCENE);
	expect(state.creates).toHaveLength(1);
	expect(state.creates[0]!.request).toMatchObject({
		duration: 10,
		inputs: { leftAssetId: "asset-1", rightAssetId: "asset-2" },
	});
});

test("UI Mock: keyboard duration selection locks during one lost-response confirmation", async ({
	page,
}) => {
	const state = scenario({ durations: true, loseFirst: true });
	await setup(page, state);
	await uploadBoth(page);
	const option = page
		.locator(".ve-duration")
		.getByRole("button", { name: "10 seconds 116 credits", exact: true });
	await option.focus();
	await page.keyboard.press("Enter");
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "116"), exact: true })
		.click();
	await expect(page.getByRole("button", { name: t.recover, exact: true })).toBeVisible();
	await expect(option).toBeDisabled();
	const first = state.creates[0];
	await page.reload();
	await page.getByRole("button", { name: t.recover, exact: true }).click();
	await expect(page.locator(".ve-result h2")).toHaveText(t.stages.CREATING_SCENE);
	expect(state.creates[1]).toEqual(first);
	expect((first!.request as Record<string, unknown>).duration).toBe(10);
});

test("UI Mock: one click quotes and accepts the displayed complete order without a separate review step", async ({
	page,
}) => {
	const state = scenario();
	await setup(page, state);
	await expect(
		page.locator(".ve-duration").getByRole("button", { name: /10 seconds/ }),
	).toBeDisabled();
	await expect(page.locator(".ve-price strong")).toHaveText("69 credits");
	await expect(page.getByRole("button", { name: t.getQuote, exact: true })).toHaveCount(0);
	const chooser = page.waitForEvent("filechooser");
	await page.locator(".ve-creator .ve-primary").click();
	await (await chooser).setFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await expect(page.locator(".ve-creator .ve-primary")).toHaveText(t.uploadRight);
	await page.locator("#ve-upload-right").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	await expect(page.locator(".ve-result")).toContainText(t.stages.CREATING_SCENE);
	expect(state.quotes).toHaveLength(1);
	expect(state.creates).toHaveLength(1);
	// A following click after a fast accepted response starts a fresh draft only.
	await page.locator(".ve-creator .ve-primary").click();
	expect(state.creates).toHaveLength(1);
	await expect(
		page.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true }),
	).toBeEnabled();
});

for (const credits of ["70", "68"])
	test(`UI Mock: a changed ${credits}-credit total requires a new explicit confirmation`, async ({
		page,
	}) => {
		const state = scenario({ quoteCredits: credits });
		await setup(page, state);
		await uploadBoth(page);
		await page
			.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
			.click();
		await expect(page.locator(".ve-price strong")).toHaveText(`${credits} credits`);
		await expect(page.locator("#ve-price-change")).toContainText(`${credits} credits`);
		expect(state.creates).toHaveLength(0);
		await page
			.getByRole("button", { name: `Confirm new total · ${credits} credits`, exact: true })
			.click();
		await expect(page.locator(".ve-result")).toContainText(t.stages.CREATING_SCENE);
		expect(state.quotes).toHaveLength(2);
		expect(state.creates).toHaveLength(1);
		expect(state.creates[0]?.quoteId).toBe("quote-2");
	});

for (const width of [1440, 390, 320])
	test(`UI Mock: ${width}px shows the price and actual video balance before uploads`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		const state = scenario({ eligibleCredits: "0" });
		await setup(page, state);
		await expect(page.locator(".ve-price strong")).toHaveText("69 credits");
		await expect(page.locator(".ve-price")).toContainText(t.eligibleBalance);
		await expect(page.locator(".ve-price")).toContainText("0 credits");
		await expect(page.locator(".ve-price")).toContainText(
			t.accountBalance.replace("{credits}", "391"),
		);
		await expect(page.locator("#ve-funding-hint")).toContainText(
			t.creditShortfall.replace("{credits}", "69"),
		);
		await expect(page.getByRole("button", { name: t.getQuote, exact: true })).toHaveCount(0);
		const purchase = page.locator(".ve-creator .ve-primary");
		await expect(purchase).toHaveText(t.addCredits);
		await expect(purchase).toBeEnabled();
		await expect(purchase).toHaveAccessibleDescription(
			new RegExp(t.creditShortfall.replace("{credits}", "69")),
		);
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
			.toBe(true);
		expect(state.quotes).toHaveLength(0);
		expect(state.creates).toHaveLength(0);
		await page.screenshot({
			path: testInfo.outputPath(`hotel-lobby-price-${width}.png`),
			fullPage: true,
		});
	});

test("UI Mock: upload guidance, eligible-credit shortfall and a refreshed balance explain each next action", async ({
	page,
}) => {
	const state = scenario({ eligibleCredits: "0", slowUpload: true });
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator("#ve-quote-hint")).toHaveText(t.waitingForPhotos);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await expect(page.locator("#ve-quote-hint")).toHaveText(t.uploadRightHint);
	await page.locator("#ve-upload-right").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
	const generate = page.getByRole("button", {
		name: t.generate.replace("{credits}", "69"),
		exact: true,
	});
	await expect(generate).toHaveCount(0);
	await expect(page.locator(".ve-creator .ve-primary")).toHaveAccessibleDescription(
		new RegExp(t.creditShortfall.replace("{credits}", "69")),
	);
	await expect(page.getByRole("button", { name: t.addCredits, exact: true })).toBeEnabled();
	expect(state.creates).toHaveLength(0);
	state.eligibleCredits = "120";
	await page.reload();
	await expect(generate).toBeEnabled();
	await expect(page.locator("#ve-funding-hint")).not.toContainText("You need");
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: price guidance renders in German with the same dynamic amounts", async ({
	page,
}) => {
	await setup(page, scenario({ eligibleCredits: "0" }));
	await page.goto(`${path}?lang=de`);
	await expect(page.locator(".ve-price strong")).toHaveText(
		de.videoEffects.credits.replace("{credits}", "69"),
	);
	await expect(page.locator(".ve-price")).toContainText(de.videoEffects.eligibleBalance);
	await expect(page.locator("#ve-funding-hint")).toContainText(
		de.videoEffects.creditShortfall.replace("{credits}", "69"),
	);
	await expect(page.locator("#ve-quote-hint")).toHaveText(de.videoEffects.uploadBothHint);
});
async function reviewChangedPrice(page: Page) {
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: t.confirmNewPrice.replace("{credits}", "70"), exact: true }),
	).toBeVisible();
}

test("UI Mock: anonymous template is readable, honest and indexable", async ({ page }) => {
	const state = scenario({ signedIn: false });
	await setup(page, state);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new RegExp(`${path}$`),
	);
	await expect(page.locator(".ve-page video")).toHaveCount(0);
	await expect(page.locator(".ve-page select, .ve-page textarea")).toHaveCount(0);
	await expect(page.locator(".ve-page")).toContainText(t.samplesPending);
	await expect(page.locator(".ve-beta")).toHaveText(t.beta);
	await expect(page.locator("#hotel-lobby-history")).toHaveCount(0);
	await expect(page.locator("#ve-upload-left")).toBeDisabled();
	await expect(page.getByRole("link", { name: t.signIn })).toHaveAttribute(
		"href",
		`/login?redirectTo=${encodeURIComponent(path)}`,
	);
	expect(state.uploads).toBe(0);
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: an ordinary signed-in account can generate and reopen its template order while ordinary video is unavailable", async ({
	page,
}) => {
	const state = scenario();
	await setup(page, state);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
	await expect(page.locator("#hotel-lobby-history")).toContainText(t.emptyHistory);
	await uploadBoth(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	const accepted = page.locator(`#hotel-lobby-history a[href="${path}?job=mock-template-job"]`);
	await expect(accepted).toContainText(t.stages.CREATING_SCENE);
	await accepted.click();
	await expect(page).toHaveURL(`${test.info().project.use.baseURL}${path}?job=mock-template-job`);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
	await expect(page.getByRole("region", { name: t.yourVideo })).toContainText(
		t.stages.CREATING_SCENE,
	);
	expect(state.creates).toHaveLength(1);
	expect(state.ordinaryVideoJobRequests).toBe(0);
});

test("UI Mock: a temporary generation closure preserves access to existing template history", async ({
	page,
}) => {
	const state = scenario({ available: false, creates: [{}] });
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeDisabled();
	await expect(page.locator(".ve-notice")).toContainText(t.unavailable);
	await expect(page.locator(".ve-notice")).not.toContainText(t.betaHint);
	await expect(page.locator("#hotel-lobby-history a")).toHaveAttribute(
		"href",
		`${path}?job=mock-template-job`,
	);
	expect(state.uploads).toBe(0);
	expect(state.ordinaryVideoJobRequests).toBe(0);
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
	const state = scenario({ quoteCredits: "70" });
	await setup(page, state);
	await uploadBoth(page);
	await reviewChangedPrice(page);
	const swap = page.getByRole("button", { name: t.swap });
	await swap.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("#ve-price-change")).toHaveCount(0);
	await reviewChangedPrice(page);
	expect(state.quotes.at(-1)?.inputs).toEqual({ leftAssetId: "asset-2", rightAssetId: "asset-1" });
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await reviewChangedPrice(page);
	expect(state.quotes.at(-1)?.inputs).toEqual({ leftAssetId: "asset-3", rightAssetId: "asset-1" });
	state.slowUpload = true;
	await page.locator("#ve-upload-right").setInputFiles(source);
	await page.getByRole("button", { name: t.clearPhoto.replace("{role}", t.right) }).click();
	await expect(page.getByRole("button", { name: t.uploadRight, exact: true })).toBeEnabled();
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: double click and lost response restore one confirmation after refresh", async ({
	page,
}) => {
	const state = scenario({ loseFirst: true });
	await setup(page, state);
	await uploadBoth(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.evaluate((node) => {
			(node as HTMLButtonElement).click();
			(node as HTMLButtonElement).click();
		});
	await expect(page.getByRole("button", { name: t.recover })).toBeVisible();
	expect(state.creates).toHaveLength(1);
	state.eligibleCredits = "0";
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

test("UI Mock: blocked recovery storage prevents a paid acceptance", async ({ page }) => {
	const state = scenario();
	await setup(page, state);
	await uploadBoth(page);
	await page.evaluate(() => {
		const original = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")!.value as (
			this: Storage,
			key: string,
			value: string,
		) => void;
		Storage.prototype.setItem = function (key: string, value: string) {
			if (key.startsWith("ezpic.video-effect")) throw new Error("blocked test storage");
			return original.call(this, key, value);
		};
	});
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	await expect(page.locator(".ve-error")).toHaveText(t.storageUnavailable);
	expect(state.quotes).toHaveLength(1);
	expect(state.creates).toHaveLength(0);
});

test("UI Mock: expired quote requires another quote; insufficient eligible credits never becomes a job", async ({
	page,
}) => {
	const state = scenario({ expired: true });
	await setup(page, state);
	await uploadBoth(page);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
		.click();
	await expect(page.locator(".ve-creator")).toContainText(t.quoteExpired);
	expect(state.creates).toHaveLength(0);
	state.expired = false;
	state.insufficient = true;
	state.eligibleCredits = "0";
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "69"), exact: true })
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

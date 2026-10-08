import { expect, test, type Page } from "@playwright/test";

import en from "../../../packages/i18n/translations/en/saas.json";

const path = "/blog/raindance-ai-trend";
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
	effectId: "raindance-solo" | "raindance-duo";
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
	eligibleCredits: string;
	quoteCredits: string;
	waitForQuote?: Promise<void>;
	waitForFirstCreate?: Promise<void>;
	firstCreateFailure?: string;
	loseCreateCalls?: number[];
};
const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
	effectId: "raindance-solo",
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
	eligibleCredits: "120",
	quoteCredits: "24",
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
		if (endpoint === "videoV1/availability") return reply({ available: false });
		if (endpoint === "videoV1/catalog")
			return reply({ available: false, accessAllowed: false, models: [], reasons: [] });
		if (endpoint === "videoEffects/access")
			return reply({
				effectId: state.effectId,
				available: state.available,
				accessAllowed: true,
				reasons: [],
				credits: state.available ? "24" : null,
				creditBalance: state.available
					? { totalCredits: "120", eligibleCredits: state.eligibleCredits }
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
			state.effectId = body.effectId;
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
			effectId: state.effectId,
			name: state.effectId === "raindance-solo" ? "Raindance solo" : "Raindance duet",
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
			const call = state.creates.length;
			if (call === 1 && state.waitForFirstCreate) await state.waitForFirstCreate;
			if (call === 1 && state.firstCreateFailure) return failure(state.firstCreateFailure);
			if (state.insufficient) return failure("INSUFFICIENT_ELIGIBLE_CREDITS");
			if (state.loseFirst && state.creates.length === 1) return route.abort("connectionreset");
			if (state.loseCreateCalls?.includes(call)) return route.abort("connectionreset");
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
	await expect(page.locator(".ve-page h1")).toHaveText(
		"Raindance AI Trend: Make Your Video + Free Prompts",
	);
}
async function uploadBoth(page: Page) {
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page.locator("#ve-upload-right").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
}

test("Raindance: indexable guide has a working solo/duet entry, copyable prompts and honest illustration", async ({
	page,
}) => {
	const state = scenario({ signedIn: false });
	await setup(page, state);
	await expect(page.locator("h1")).toHaveCount(1);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		"href",
		new RegExp(`${path}$`),
	);
	await expect(page.locator("#ve-upload-left")).toBeDisabled();
	await expect(page.locator("#ve-upload-right")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Copy prompt", exact: true })).toHaveCount(3);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const firstPrompt = await page.locator(".rd-prose pre").first().textContent();
	await page.getByRole("button", { name: "Copy prompt", exact: true }).first().click();
	await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstPrompt);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	await expect(page.locator("#ve-upload-right")).toBeDisabled();
	await expect(page.locator(".rd-scene figcaption")).toContainText("not a generated video sample");
	await expect(page.getByRole("link", { name: t.signIn, exact: true })).toHaveAttribute(
		"href",
		`/login?redirectTo=${encodeURIComponent(`${path}?mode=duo`)}`,
	);
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({
			path: test.info().outputPath(`raindance-${width}.png`),
			fullPage: width === 1440,
		});
	}
	expect(state.creates).toHaveLength(0);
});

test("Raindance: duration drafts stay separate between solo and duet", async ({ page }, info) => {
	const state = scenario({ durations: true, annual: true });
	await setup(page, state);
	await page
		.locator(".ve-duration")
		.getByRole("button", { name: "10 seconds 101 credits", exact: true })
		.click();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	await expect(
		page.locator(".ve-duration").getByRole("button", { name: "5 seconds 69 credits", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "Solo · 1 photo", exact: true }).click();
	await expect(
		page
			.locator(".ve-duration")
			.getByRole("button", { name: "10 seconds 101 credits", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page.locator(".ve-workbench").screenshot({ path: info.outputPath("raindance-10s.png") });
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "101"), exact: true })
		.click();
	await expect(page.locator(".ve-result h2")).toHaveText(t.raindance.creatingScene);
	expect(state.creates).toHaveLength(1);
	expect(state.creates[0]!.request).toMatchObject({
		effectId: "raindance-solo",
		duration: 10,
		inputs: { leftAssetId: "asset-1", rightAssetId: "asset-1" },
	});
});

test("Raindance: solo binds one upload; duet and Hotel Lobby drafts remain separate", async ({
	page,
}) => {
	const state = scenario();
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect(page.locator("#raindance-history a")).toHaveCount(1);
	expect(state.quotes[0]).toMatchObject({
		effectId: "raindance-solo",
		inputs: { leftAssetId: "asset-1", rightAssetId: "asset-1" },
	});
	expect(state.creates).toHaveLength(1);
	await page.locator("#raindance-history a").click();
	await expect(page).toHaveURL(`${test.info().project.use.baseURL}${path}?job=mock-template-job`);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.empty);
	await uploadBoth(page);
	state.quoteCredits = "25";
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect(page.locator("#ve-price-change")).toContainText("25 credits");
	expect(state.quotes[1]).toMatchObject({
		effectId: "raindance-duo",
		inputs: { leftAssetId: "asset-2", rightAssetId: "asset-3" },
	});
	await page.reload();
	await expect(page.getByRole("button", { name: "Duet · 2 photos", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
	expect(state.creates).toHaveLength(1);
	expect(state.ordinaryVideoJobRequests).toBe(0);
});

test("Raindance: lost paid response recovers the same solo confirmation", async ({ page }) => {
	const state = scenario({ loseFirst: true });
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect(page.getByRole("button", { name: t.recover, exact: true })).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: t.recover, exact: true }).click();
	await expect(page.locator("#raindance-history a")).toHaveCount(1);
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
});

test("Raindance: leaving a mode during quotation cannot accept a hidden order", async ({
	page,
}) => {
	let release!: () => void;
	const state = scenario({
		waitForQuote: new Promise<void>((resolve) => {
			release = resolve;
		}),
	});
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect.poll(() => state.quotes.length).toBe(1);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	const quoted = page.waitForResponse((response) => response.url().includes("videoEffects/quote"));
	release();
	await quoted;
	await page.getByRole("button", { name: "Solo · 1 photo", exact: true }).click();
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await expect(
		page.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true }),
	).toBeEnabled();
	expect(state.creates).toHaveLength(0);
});

for (const late of ["accepted", "INSUFFICIENT_ELIGIBLE_CREDITS", "QUOTE_EXPIRED_OR_CHANGED"])
	test(`Raindance: review-regression late ${late} preserves the next order receipt across reload`, async ({
		page,
	}) => {
		let release!: () => void;
		const state = scenario({
			waitForFirstCreate: new Promise<void>((resolve) => {
				release = resolve;
			}),
			firstCreateFailure: late === "accepted" ? undefined : late,
			loseCreateCalls: [3],
		});
		await setup(page, state);
		await expect(page.locator("#ve-upload-left")).toBeEnabled();
		await page.locator("#ve-upload-left").setInputFiles(source);
		await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
		const generate = () =>
			page
				.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
				.click();
		await generate();
		await expect.poll(() => state.creates.length).toBe(1);
		await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
		await page.getByRole("button", { name: "Solo · 1 photo", exact: true }).click();
		await page.getByRole("button", { name: t.recover, exact: true }).click();
		await expect(page.getByRole("button", { name: t.newVideo, exact: true })).toBeEnabled();
		expect(state.creates[1]).toEqual(state.creates[0]);
		await page.getByRole("button", { name: t.newVideo, exact: true }).click();
		await generate();
		await expect(page.getByRole("button", { name: t.recover, exact: true })).toBeEnabled();
		expect(state.creates).toHaveLength(3);
		const pendingKey = state.creates[2]!.idempotencyKey;
		expect(pendingKey).not.toBe(state.creates[0]!.idempotencyKey);
		const storageKey = "ezpic.video-effect.v1:raindance-solo:mock-owner";
		const storedKey = () =>
			page.evaluate(
				(key) => JSON.parse(sessionStorage.getItem(key)!).confirmation?.input.idempotencyKey,
				storageKey,
			);
		expect(await storedKey()).toBe(pendingKey);
		const oldResponse = page.waitForResponse((response) =>
			response.url().includes("videoEffects/jobs/create"),
		);
		release();
		await oldResponse;
		// Flush the browser response callback before reading its durable storage.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		expect(await storedKey()).toBe(pendingKey);
		await page.reload();
		await expect(page.getByRole("button", { name: t.recover, exact: true })).toBeEnabled();
		await page.getByRole("button", { name: t.recover, exact: true }).click();
		await expect(page.getByRole("button", { name: t.newVideo, exact: true })).toBeEnabled();
		expect(state.creates).toHaveLength(4);
		expect(state.creates[3]).toEqual(state.creates[2]);
		expect(state.quotes).toHaveLength(2);
	});

test("Raindance: review-regression mounted recovery observes an already persisted acceptance", async ({
	page,
}) => {
	let release!: () => void;
	const state = scenario({
		waitForFirstCreate: new Promise<void>((resolve) => {
			release = resolve;
		}),
	});
	await setup(page, state);
	await expect(page.locator("#ve-upload-left")).toBeEnabled();
	await page.locator("#ve-upload-left").setInputFiles(source);
	await expect(page.locator(".ve-slot-status").first()).toContainText(t.upload.sealed);
	await page
		.getByRole("button", { name: t.generate.replace("{credits}", "24"), exact: true })
		.click();
	await expect.poll(() => state.creates.length).toBe(1);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	await page.getByRole("button", { name: "Solo · 1 photo", exact: true }).click();
	await expect(page.getByRole("button", { name: t.recover, exact: true })).toBeEnabled();
	const oldResponse = page.waitForResponse((response) =>
		response.url().includes("videoEffects/jobs/create"),
	);
	release();
	await oldResponse;
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(sessionStorage.getItem("ezpic.video-effect.v1:raindance-solo:mock-owner")!)
						.jobId,
			),
		)
		.toBe("mock-template-job");
	await page.getByRole("button", { name: t.recover, exact: true }).click();
	await expect(page.getByRole("button", { name: t.newVideo, exact: true })).toBeEnabled();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
});

test("Raindance: integrated stored Duet preference reaches the header login return", async ({
	page,
}, info) => {
	await page.addInitScript(() => sessionStorage.setItem("ezpic.raindance.mode", "duo"));
	await setup(page, scenario({ signedIn: false }));
	await expect(page).toHaveURL(`${path}?mode=duo`);
	await expect(page.getByRole("button", { name: "Duet · 2 photos", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	const header = page.locator(".studio-header-account a[href^='/login']");
	const href = `/login?redirectTo=${encodeURIComponent(`${path}?mode=duo`)}`;
	await expect(header).toHaveAttribute("href", href);
	await page.screenshot({
		path: info.outputPath("raindance-restored-duet-login.png"),
		animations: "disabled",
	});
	await header.click();
	await expect(page).toHaveURL(
		new RegExp(`/login\\?redirectTo=${encodeURIComponent(`${path}?mode=duo`)}`),
	);
});

test("Raindance: insufficient balance opens credit packs and preserves duet photos, mode and duration", async ({
	page,
}) => {
	const state = scenario({ eligibleCredits: "0", durations: true });
	await setup(page, state);
	await page.getByRole("button", { name: "Duet · 2 photos", exact: true }).click();
	await page
		.locator(".ve-duration")
		.getByRole("button", { name: "10 seconds 116 credits", exact: true })
		.click();
	await uploadBoth(page);
	await page.locator(".ve-creator .ve-primary").click();
	const stored = await page.evaluate(() => ({
		marker: JSON.parse(sessionStorage.getItem("ezpic.video-effect.payment-return.v1")!),
		draft: JSON.parse(sessionStorage.getItem("ezpic.video-effect.v1:raindance-duo:mock-owner")!),
	}));
	expect(stored.marker).toMatchObject({
		ownerId: "mock-owner",
		path: `${path}?mode=duo`,
		stage: "armed",
	});
	expect(stored.draft).toMatchObject({
		effectId: "raindance-duo",
		duration: 10,
		leftAssetId: "asset-1",
		rightAssetId: "asset-2",
	});
	expect(JSON.stringify(stored)).not.toMatch(/blob:|base64|uploadUrl|signed/);
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(0);
	state.eligibleCredits = "120";
	await page.goto(`${path}?mode=duo`);
	await expect(page.locator(".ve-slot-status").last()).toContainText(t.upload.sealed);
	await expect(
		page
			.locator(".ve-duration")
			.getByRole("button", { name: "10 seconds 116 credits", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: t.generate.replace("{credits}", "116"), exact: true }),
	).toBeEnabled();
});

test("Raindance: private order and localized views stay out of indexing", async ({ page }) => {
	const state = scenario({ signedIn: false });
	await setup(page, state);
	for (const query of ["?job=private-job", "?lang=de", "?mode=duo"]) {
		await page.goto(`${path}${query}`);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			"href",
			new RegExp(`${path}$`),
		);
	}
});

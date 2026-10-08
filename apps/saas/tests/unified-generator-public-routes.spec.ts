import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { getVideoModelOptions, VIDEO_MODEL_CATALOG } from "@repo/config/video-models";

const evidence = path.resolve(__dirname, "../../../output/playwright");
type State = {
	signedIn: boolean;
	ownerId: string;
	quoteCredits: string;
	quoteExpired: boolean;
	catalogAvailable: boolean;
	catalogReads: number;
	quoteGate?: Promise<void>;
	sealError: boolean;
	uploads: number;
	creates: any[];
	quotes: any[];
	loseFirst: boolean;
	createError: string | null;
	createGate?: Promise<void>;
	sealGate?: Promise<void>;
};
async function setup(page: Page, signedIn = true) {
	const state: State = {
		signedIn,
		ownerId: "ui-owner",
		quoteCredits: "23",
		quoteExpired: false,
		catalogAvailable: true,
		catalogReads: 0,
		sealError: false,
		uploads: 0,
		creates: [],
		quotes: [],
		loseFirst: false,
		createError: null,
	};
	const product = {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Fast private image editing",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios: ["auto", "1:1"],
		skuMatrix: {
			defaultSkuKey: "nano-banana-2-lite-1k",
			dimensions: [
				{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "nano-banana-2-lite-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 5,
					aspectRatios: ["auto", "1:1"],
					controls: [],
				},
			],
		},
	};
	await page.context().route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!["127.0.0.1", "localhost"].includes(url.hostname)) return route.abort();
		const reply = (json: unknown) => route.fulfill({ json: { json } });
		if (url.pathname === "/api/auth/get-session")
			return route.fulfill({
				json: state.signedIn
					? {
							session: {
								id: "ui-session",
								userId: state.ownerId,
								token: "ui-only",
								expiresAt: new Date(Date.now() + 3600000).toISOString(),
							},
							user: {
								id: state.ownerId,
								email: "ui@localhost",
								name: "UI Reviewer",
								emailVerified: true,
								isAnonymous: false,
								onboardingComplete: true,
								role: "user",
								image: null,
							},
						}
					: null,
			});
		if (url.pathname === "/api/media/guest-capability")
			return route.fulfill({
				json: {
					version: "ui-only",
					enabled: true,
					reason: null,
					upload: { mimeTypes: ["image/jpeg", "image/png", "image/webp"], maximumBytes: 10485760 },
					products: [product],
					queueEstimate: { kind: "capacity" },
				},
			});
		if (url.pathname === "/api/rpc/media/getPublicCatalog")
			return reply({
				catalogVersion: "ui-only",
				pricingVersion: "ui-only",
				products: [{ ...product, inputKinds: ["text-to-image", "image-to-image"] }],
			});
		if (url.pathname === "/__video-ui-upload") return route.fulfill({ status: 200 });
		const endpoint = url.pathname.split("/api/rpc/videoV1/")[1];
		if (!endpoint) {
			// Keep all chargeable/auth-mutating endpoints inside the mock boundary.
			if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503 });
			return route.continue();
		}
		const body = route.request().method() === "POST" ? route.request().postDataJSON()?.json : null;
		const job = {
			jobId: "ui-video-1",
			stage: "QUEUED",
			credits: "23",
			creditState: "RESERVED",
			canPlay: false,
			failureCode: null,
			updatedAt: new Date().toISOString(),
		};
		if (endpoint === "catalog") {
			state.catalogReads++;
			return reply({
				available: state.catalogAvailable,
				accessAllowed: true,
				maxInputBytes: 10485760,
				models: VIDEO_MODEL_CATALOG.map((model) => ({
					productKey: model.productKey,
					available: state.catalogAvailable && model.status === "implemented",
					reasons: [],
					options: model.modes.flatMap((mode) => [
						...new Map(
							getVideoModelOptions(model.productKey, mode).map(
								({ duration, resolution, sound, veoTier }) => [
									`${duration}:${resolution}:${sound}:${veoTier ?? ""}`,
									{
										mode,
										duration,
										resolution,
										sound,
										...(veoTier ? { veoTier } : {}),
										available: state.catalogAvailable,
										credits: veoTier
											? { lite: "24", fast: "33", quality: "154" }[veoTier]
											: sound
												? "57"
												: duration === 10
													? "41"
													: resolution === "1080p"
														? "37"
														: model.productKey === "video-seedance-2-5"
															? "29"
															: "23",
										reasons: [],
									},
								],
							),
						).values(),
					]),
				})),
			});
		}
		if (endpoint === "quote") {
			state.quotes.push(body);
			await state.quoteGate;
			return reply({
				quoteId: `ui-quote-${state.quotes.length}`,
				credits: state.quoteCredits,
				expiresAt: new Date(Date.now() + (state.quoteExpired ? -1000 : 60000)).toISOString(),
				requestFingerprint: "ui-only",
			});
		}
		if (endpoint === "jobs/create") {
			state.creates.push(body);
			if (state.loseFirst && state.creates.length === 1) return route.abort("connectionreset");
			if (state.createError)
				return route.fulfill({
					status: 400,
					json: {
						json: {
							defined: false,
							code: "BAD_REQUEST",
							status: 400,
							message: state.createError,
							data: { code: state.createError },
						},
					},
				});
			await state.createGate;
			return reply(job);
		}
		if (endpoint === "jobs/get") return reply(job);
		if (endpoint === "jobs/list") return reply({ items: [job], nextCursor: null });
		if (endpoint === "uploads/create") {
			state.uploads++;
			return reply({
				sessionId: `ui-upload-${state.uploads}`,
				assetId: "ui-asset",
				uploadUrl: url.origin + "/__video-ui-upload",
				method: "PUT",
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			});
		}
		if (endpoint === "uploads/complete") {
			await state.sealGate;
			if (state.sealError)
				return route.fulfill({
					status: 400,
					json: {
						json: {
							defined: false,
							code: "BAD_REQUEST",
							status: 400,
							message: "VIDEO_INPUT_REJECTED",
						},
					},
				});
			return reply({
				assetId:
					body.sessionId === "ui-upload-1"
						? "ui-asset"
						: `ui-asset-${body.sessionId.split("-").at(-1)}`,
				status: "VERIFYING",
				uploadStatus: "COMPLETED",
				moderationStatus: "PENDING",
				mimeType: "image/png",
				byteSize: "68",
				width: 1,
				height: 1,
			});
		}
		return route.abort();
	});
	return state;
}
async function mode(page: Page, value: "image" | "video") {
	await page
		.locator("[data-generator-panel]:visible")
		.locator(`[data-generator-mode="${value}"]`)
		.click();
	await expect(page.locator(`[data-generator-panel="${value}"]`)).toBeVisible();
}
async function reviewChangedPrice(page: Page, state: State) {
	state.quoteCredits = "29";
	await page.locator("#video-prompt").fill("A slow camera above a quiet lake at golden hour.");
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("29 credits");
}

async function restoreHistoricalKlingConfirmation(page: Page, state: State) {
	await page.goto("/create?mode=video");
	await expect(page.locator("#video-prompt")).toBeEnabled();
	const request = {
		productKey: "video-kling-3",
		mode: "image-to-video",
		prompt: "Keep the original reference and animate the quiet lake.",
		duration: 5,
		resolution: "720p",
		aspectRatio: "9:16",
		sound: false,
		inputAssetId: "historical-sealed-reference",
	};
	const input = {
		quoteId: "historical-quote",
		idempotencyKey: "historical-confirmation-key",
		request,
	};
	await page.evaluate(
		({ key, confirmation }) => sessionStorage.setItem(key, JSON.stringify(confirmation)),
		{
			key: `video-v1:confirmation:${state.ownerId}`,
			confirmation: {
				version: 1,
				fingerprint: JSON.stringify(request),
				quote: {
					quoteId: input.quoteId,
					credits: "23",
					expiresAt: new Date(Date.now() + 3600000).toISOString(),
					requestFingerprint: "historical-request",
				},
				input,
			},
		},
	);
	await page.reload();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("same request");
	await expect(page.locator("#video-prompt")).toBeDisabled();
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("9:16");
	return input;
}

test("historical Kling confirmation rejected before admission unlocks legal framing and a new request", async ({
	page,
}) => {
	const state = await setup(page);
	state.createError = "VIDEO_MODEL_OPTION_UNAVAILABLE";
	const original = await restoreHistoricalKlingConfirmation(page, state);
	const catalogReads = state.catalogReads;
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator("#video-prompt")).toBeEnabled();
	expect(state.creates).toEqual([original]);
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText(
		"Automatic framing",
	);
	await expect.poll(() => state.catalogReads).toBeGreaterThan(catalogReads);
	expect(
		await page.evaluate(() => sessionStorage.getItem("video-v1:confirmation:ui-owner")),
	).toBeNull();
	await expect(page.locator("#video-model")).toHaveAttribute("data-product-key", "video-kling-3");
	await expect(
		page.getByLabel("Describe movement and camera direction", { exact: true }),
	).toHaveValue(original.request.prompt);
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toHaveText(
		"Upload and secure one reference image first.",
	);
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(1);
	await page.reload();
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await expect(page.locator("#video-prompt")).toHaveValue(original.request.prompt);
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText(
		"Automatic framing",
	);
	await expect(page.locator('[data-test="video-workspace"]')).toContainText(
		"Upload and secure one reference image",
	);
	state.createError = null;
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.quotes).toHaveLength(1);
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1].request).toEqual({
		...original.request,
		aspectRatio: "source",
		inputAssetId: "ui-asset",
	});
	expect(state.quotes[0]).toEqual(state.creates[1].request);
	expect(state.creates[1].idempotencyKey).not.toBe(original.idempotencyKey);
	expect(state.creates[1].quoteId).not.toBe(original.quoteId);
});

test("historical Kling confirmation with an unknown response replays the accepted request unchanged", async ({
	page,
}) => {
	const state = await setup(page);
	state.loseFirst = true;
	const original = await restoreHistoricalKlingConfirmation(page, state);
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toBeEnabled();
	await expect(page.locator("#video-prompt")).toBeDisabled();
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("9:16");
	expect(
		await page.evaluate(
			() => JSON.parse(sessionStorage.getItem("video-v1:confirmation:ui-owner")!).input,
		),
	).toEqual(original);
	expect(state.creates).toEqual([original]);
	state.catalogAvailable = false;
	await page.reload();
	await expect(page.locator("#video-prompt")).toBeDisabled();
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("9:16");
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toEqual([original, original]);
	expect(state.quotes).toHaveLength(0);
	expect(
		await page.evaluate(() => sessionStorage.getItem("video-v1:confirmation:ui-owner")),
	).toBeNull();
});

test("upfront backend price needs no prompt or quote, blank prompt is explicit, same-price generation is single-click", async ({
	page,
}) => {
	const state = await setup(page);
	await page.goto("/create?mode=video");
	const generate = page.locator('[data-test="video-generate"]');
	await expect(generate).toHaveText("Generate · 23 credits");
	await expect(page.locator("#video-prompt")).toHaveValue("");
	expect(state.quotes).toHaveLength(0);
	await generate.click();
	await expect(page.locator('[data-test="video-workspace"]').getByRole("alert")).toHaveText(
		"Enter a description",
	);
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(0);
	await page.locator('[data-test="video-settings-trigger"]').click();
	await page.getByRole("radio", { name: "10 seconds", exact: true }).check();
	await page.keyboard.press("Escape");
	await expect(generate).toHaveText("Generate · 41 credits");
	expect(state.quotes).toHaveLength(0);
	state.quoteCredits = "41";
	await page.locator("#video-prompt").fill("A slow camera above a quiet lake.");
	await generate.evaluate((button) => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.quotes).toHaveLength(1);
	expect(state.creates).toHaveLength(1);
	expect(state.creates[0].request).toMatchObject({
		duration: 10,
		prompt: "A slow camera above a quiet lake.",
	});
});

test("reference errors and reload retain image intent, explicit remove restores text and cancels a stale seal", async ({
	page,
}) => {
	const state = await setup(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/create?mode=video");
	await page.getByRole("button", { name: "Decline optional", exact: true }).click();
	await expect(page.locator("#video-mode")).toHaveCount(0);
	await page.locator("#video-prompt").fill("Keep the reference and animate it.");
	await page
		.locator("#video-image")
		.setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("bad") });
	await expect(page.locator("#video-upload-status").getByRole("alert")).toContainText("JPEG");
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-workspace"]')).toContainText(
		"Upload and secure one reference image",
	);
	expect(state.creates).toHaveLength(0);
	await page.reload();
	await expect(
		page.getByLabel("Describe movement and camera direction", { exact: true }),
	).toHaveValue("Keep the reference and animate it.");
	await expect(page.locator('[data-test="video-workspace"]')).toContainText(
		"Upload and secure one reference image",
	);
	let release!: () => void;
	state.sealGate = new Promise((resolve) => {
		release = resolve;
	});
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Verifying");
	await expect(page.locator('[data-test="video-generate"]')).toBeDisabled();
	await page.getByRole("button", { name: "Remove image", exact: true }).click();
	release();
	await expect(page.getByLabel("Describe your video", { exact: true })).toBeVisible();
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	await expect(
		page.getByLabel("Describe movement and camera direction", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-reference-added.png"),
	});
	await page.getByRole("button", { name: "Remove image", exact: true }).click();
	await expect(page.getByLabel("Describe your video", { exact: true })).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-reference-removed.png"),
	});
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates[0].request).toMatchObject({ mode: "text-to-video" });
	expect(state.creates[0].request).not.toHaveProperty("inputAssetId");
});

function referenceFile() {
	return {
		name: "reference.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"base64",
		),
	};
}

test("model, resolution and audio changes show the exact catalog price with an empty prompt", async ({
	page,
}) => {
	const state = await setup(page);
	await page.goto("/create?mode=video");
	await page.locator("#video-model").click();
	await page.getByRole("button", { name: "Seedance", exact: true }).click();
	await page.getByRole("button", { name: "Seedance 2.5", exact: true }).click();
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 29 credits");
	await page.locator('[data-test="video-settings-trigger"]').click();
	await page.getByRole("radio", { name: "1080P", exact: true }).check();
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 37 credits");
	await page.getByRole("switch", { name: "Audio", exact: true }).click();
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 57 credits");
	await expect(page.locator("#video-prompt")).toHaveValue("");
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(0);
});

test("replacing an in-flight reference ignores the first upload's late completion", async ({
	page,
}) => {
	const state = await setup(page);
	let release!: () => void;
	state.sealGate = new Promise((resolve) => {
		release = resolve;
	});
	await page.goto("/create?mode=video");
	await page.locator("#video-prompt").fill("Animate the replacement reference.");
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Verifying");
	state.sealGate = undefined;
	await page.locator("#video-image").setInputFiles({ ...referenceFile(), name: "replacement.png" });
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	release();
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates[0].request).toMatchObject({
		mode: "image-to-video",
		inputAssetId: "ui-asset-2",
	});
	expect(state.creates).toHaveLength(1);
});

async function chooseVideoGroup(page: Page, family: string, name: string) {
	await page.locator("#video-model").click();
	await page.getByRole("button", { name: family, exact: true }).click();
	await page.getByRole("button", { name, exact: true }).click();
}

async function captureVideoVariant(page: Page, filename: string) {
	await page
		.locator('[data-test="video-workspace"]')
		.evaluate((element) => element.scrollIntoView({ block: "start" }));
	await page.screenshot({ animations: "disabled", path: path.join(evidence, filename) });
}

test("real video variants default without a base button, cancel mutually exclusive tiers and remember choices", async ({
	page,
}) => {
	const state = await setup(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/create?mode=video");
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await chooseVideoGroup(page, "Veo", "Veo 3.1");
	const variants = page.getByRole("group", { name: "Model variant", exact: true });
	await expect(variants).toContainText("Current: Lite");
	await expect(variants.getByRole("button", { name: "Lite", exact: true })).toHaveCount(0);
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 24 credits");
	await captureVideoVariant(page, "ezimage-video-veo-lite.png");
	await variants.getByRole("button", { name: "Fast", exact: true }).click();
	await expect(variants.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 33 credits");
	await variants.getByRole("button", { name: "Quality", exact: true }).focus();
	await page.keyboard.press("Space");
	await expect(variants.getByRole("button", { name: "Fast", exact: true })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 154 credits");
	await captureVideoVariant(page, "ezimage-video-veo-quality.png");
	await chooseVideoGroup(page, "Seedance", "Seedance 2");
	await expect(variants).toContainText("Current: Mini");
	await variants.getByRole("button", { name: "Fast", exact: true }).click();
	await expect(page.locator("#video-model")).toHaveAttribute(
		"data-product-key",
		"video-seedance-2-fast",
	);
	await captureVideoVariant(page, "ezimage-video-seedance-variants.png");
	await chooseVideoGroup(page, "Veo", "Veo 3.1");
	await expect(variants).toContainText("Current: Quality");
	await mode(page, "image");
	await mode(page, "video");
	await expect(variants).toContainText("Current: Quality");
	await page.reload();
	await expect(variants).toContainText("Current: Quality");
	await expect(page.locator("#video-image")).toBeEnabled();
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	await expect(variants).toContainText("Current: Quality");
	await page.getByRole("button", { name: "Remove image", exact: true }).click();
	await expect(variants).toContainText("Current: Quality");
	await variants.getByRole("button", { name: "Quality", exact: true }).click();
	await expect(variants).toContainText("Current: Lite");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 24 credits");
	await chooseVideoGroup(page, "Seedance", "Seedance 2");
	await expect(variants).toContainText("Current: Fast");
	await chooseVideoGroup(page, "Kling", "Kling 3");
	await variants.getByRole("button", { name: "Pro", exact: true }).click();
	await expect(page.locator('[data-test="video-settings-trigger"]')).toContainText("1080P");
	await variants.getByRole("button", { name: "Turbo", exact: true }).click();
	await expect(page.locator("#video-model")).toHaveAttribute(
		"data-product-key",
		"video-kling-3-turbo",
	);
	await page.locator('[data-test="video-settings-trigger"]').click();
	await expect(page.getByRole("radio", { name: "4K", exact: true })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await captureVideoVariant(page, "ezimage-video-kling-variants.png");
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(0);
});

for (const width of [390, 320])
	test(`real video variants stay within ${width}px and freeze the selected tier into generation`, async ({
		page,
	}) => {
		const state = await setup(page);
		state.quoteCredits = "154";
		await page.setViewportSize({ width, height: 1000 });
		await page.goto("/create?mode=video");
		await expect(page.locator("#video-prompt")).toBeEnabled();
		await chooseVideoGroup(page, "Veo", "Veo 3.1");
		const variants = page.getByRole("group", { name: "Model variant", exact: true });
		await variants.getByRole("button", { name: "Quality", exact: true }).click();
		await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 154 credits");
		await captureVideoVariant(page, `ezimage-video-variants-${width}.png`);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			width,
		);
		await page.locator("#video-prompt").fill("A slow camera above a calm lake.");
		await page.locator('[data-test="video-generate"]').click();
		await expect(page.locator('[data-test="video-job"]')).toBeVisible();
		expect(state.quotes[0]).toMatchObject({
			productKey: "video-veo-3-1",
			veoTier: "quality",
			duration: 8,
			resolution: "720p",
		});
		expect(state.creates[0].request).toEqual(state.quotes[0]);
		expect(state.creates[0].request).not.toHaveProperty("variantSelections");
	});

for (const outcome of ["definite version rejection", "unknown accepted response"])
	test(`Veo ${outcome} preserves the selected tier and the correct confirmation identity`, async ({
		page,
	}) => {
		const state = await setup(page);
		state.quoteCredits = "154";
		state.createError = outcome === "definite version rejection" ? "INVALID_VIDEO_QUOTE" : null;
		state.loseFirst = outcome === "unknown accepted response";
		await page.goto("/create?mode=video");
		await expect(page.locator("#video-prompt")).toBeEnabled();
		await chooseVideoGroup(page, "Veo", "Veo 3.1");
		const variants = page.getByRole("group", { name: "Model variant", exact: true });
		await variants.getByRole("button", { name: "Quality", exact: true }).click();
		await page.locator("#video-prompt").fill("Keep this quality and move the camera slowly.");
		await page.locator('[data-test="video-generate"]').click();
		await expect.poll(() => state.creates.length).toBe(1);
		const original = state.creates[0];
		if (state.createError) {
			await expect(page.locator("#video-prompt")).toBeEnabled();
			await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
			await expect.poll(() => state.catalogReads).toBeGreaterThan(1);
			expect(
				await page.evaluate(() => sessionStorage.getItem("video-v1:confirmation:ui-owner")),
			).toBeNull();
			state.createError = null;
			await page.reload();
			await expect(variants).toContainText("Current: Quality");
			await page.locator('[data-test="video-generate"]').click();
			await expect(page.locator('[data-test="video-job"]')).toBeVisible();
			expect(state.creates[1].idempotencyKey).not.toBe(original.idempotencyKey);
			expect(state.quotes).toHaveLength(2);
		} else {
			await expect(page.locator('[data-test="video-confirm"]')).toBeEnabled();
			await expect(page.locator("#video-prompt")).toBeDisabled();
			await page.reload();
			await expect(variants).toContainText("Current: Quality");
			await expect(variants.getByRole("button", { name: "Quality", exact: true })).toBeDisabled();
			await page.locator('[data-test="video-confirm"]').click();
			await expect(page.locator('[data-test="video-job"]')).toBeVisible();
			expect(state.creates[1]).toEqual(original);
			expect(state.quotes).toHaveLength(1);
		}
		expect(state.creates[1].request.veoTier).toBe("quality");
	});

test("a quote resolved after leaving video is discarded and an expired quote never creates", async ({
	page,
}) => {
	const state = await setup(page);
	let release!: () => void;
	state.quoteGate = new Promise((resolve) => {
		release = resolve;
	});
	await page.goto("/create?mode=video");
	await page.locator("#video-prompt").fill("A quiet lake at golden hour.");
	await page.locator('[data-test="video-generate"]').click();
	await expect.poll(() => state.quotes.length).toBe(1);
	await mode(page, "image");
	release();
	await mode(page, "video");
	await expect(page.locator('[data-test="video-generate"]')).toBeEnabled();
	expect(state.creates).toHaveLength(0);
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	state.quoteExpired = true;
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-workspace"]')).toContainText("The quote expired");
	expect(state.creates).toHaveLength(0);
});
test("desktop and mobile compact composer, accessible model and settings menus", async ({
	page,
}) => {
	test.setTimeout(120000);
	await setup(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/create?mode=video");
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await page.getByRole("button", { name: "Decline optional", exact: true }).click();
	await expect(page.locator('[data-test="video-generate"]')).toContainText("23 credits");
	await expect(page.locator("#video-prompt")).toHaveValue("");
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-upfront-price.png"),
	});
	await page
		.locator("#video-prompt")
		.fill("A slow aerial shot over a quiet lake, warm morning light, natural motion.");
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-desktop.png"),
	});
	await page.locator("#video-model").click();
	await expect(page.locator('[data-test="video-model-menu"]')).toBeVisible();
	await expect(page.locator(".video-model-families [data-model-icon]")).toHaveCount(5);
	await expect(page.locator('.video-model-list [data-model-icon="kling"]')).toHaveCount(2);
	await expect(page.getByRole("button", { name: "Kling 2.6", exact: true })).toContainText(
		"5 seconds / 10 seconds",
	);
	await expect(page.locator('#video-model [data-model-icon="kling"]')).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-models.png"),
	});
	await page.keyboard.press("Escape");
	await expect(page.locator("#video-model")).toBeFocused();
	await page.locator('[data-test="video-settings-trigger"]').click();
	await page.getByRole("radio", { name: "9:16", exact: true }).check();
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-settings.png"),
	});
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-test="video-settings-trigger"]')).toBeFocused();
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.screenshot({
			animations: "disabled",
			path: path.join(evidence, `ezimage-video-mobile-${width}.png`),
		});
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.locator('[data-test="video-settings-trigger"]').click();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.keyboard.press("Escape");
	}
});

test("desktop and mobile video navigation exposes real destinations and preserves keyboard access", async ({
	page,
}) => {
	await setup(page, false);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/create");
	const menu = page.locator('[data-test="studio-video-menu"]');
	await menu.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("link", { name: "AI Video Generator", exact: false }).first(),
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-navigation-desktop.png"),
	});
	await page.keyboard.press("Escape");
	await expect(menu).toBeFocused();
	await page.setViewportSize({ width: 390, height: 900 });
	await page.locator('[data-test="header-navigation-trigger"]').click();
	const group = page.locator(
		'[data-test="header-navigation-drawer"] [data-navigation-group="video"]',
	);
	await group.locator("summary").click();
	for (const href of [
		"/create?mode=video",
		"/video-effects/hotel-lobby-ai",
		"/blog/raindance-ai-trend",
		"/docs/video-beta",
	]) {
		await expect(group.locator(`a[href="${href}"]`)).toBeVisible();
	}
	await expect(group.locator('a[href*="rumpelstiltskin"]')).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-navigation-mobile-390.png"),
	});
	await page.setViewportSize({ width: 320, height: 900 });
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-navigation-mobile-320.png"),
	});
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await group.locator('a[href="/create?mode=video"]').click();
	await expect(page.locator('[data-test="header-navigation-drawer"]')).toBeHidden();
	await expect(page.locator('[data-generator-panel="video"]')).toBeVisible();
});

test("logout and account changes isolate drafts and immutable receipts, including closed-catalog recovery", async ({
	page,
}) => {
	const state = await setup(page);
	state.loseFirst = true;
	await page.goto("/create?mode=video");
	await page.locator("#video-prompt").fill("Only account A may restore this request.");
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("same request");
	state.signedIn = false;
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Sign in to generate", exact: true }),
	).toBeVisible();
	await expect(page.locator("#video-prompt")).toHaveValue("");
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	state.signedIn = true;
	state.ownerId = "ui-owner-b";
	await page.reload();
	await expect(page.locator("#video-prompt")).toHaveValue("");
	await expect(page.locator('[data-test="video-generate"]')).toHaveText("Generate · 23 credits");
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	state.ownerId = "ui-owner";
	state.catalogAvailable = false;
	await page.reload();
	await expect(page.locator("#video-prompt")).toHaveValue(
		"Only account A may restore this request.",
	);
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
	expect(state.quotes).toHaveLength(1);
});

test("a rejected reference upload blocks generation until reselected, and image-only models require an upload", async ({
	page,
}) => {
	const state = await setup(page);
	state.sealError = true;
	await page.goto("/create?mode=video");
	await page.locator("#video-prompt").fill("Animate my reference.");
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("could not be uploaded");
	await page.locator('[data-test="video-generate"]').click();
	expect(state.quotes).toHaveLength(0);
	expect(state.creates).toHaveLength(0);
	await page.locator("#video-model").click();
	await page.getByRole("button", { name: "Seedance", exact: true }).click();
	await page.getByRole("button", { name: "Seedance 1 Pro Fast", exact: true }).click();
	await page.getByRole("button", { name: "Remove image", exact: true }).click();
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator("#video-model")).toHaveAttribute(
		"data-product-key",
		"video-seedance-1-pro-fast",
	);
	await expect(
		page.getByLabel("Describe movement and camera direction", { exact: true }),
	).toBeVisible();
	expect(state.creates).toHaveLength(0);
	state.sealError = false;
	await page.locator("#video-image").setInputFiles(referenceFile());
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	await page.locator('[data-test="video-generate"]').click();
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates[0].request).toMatchObject({
		productKey: "video-seedance-1-pro-fast",
		mode: "image-to-video",
		inputAssetId: "ui-asset-2",
	});
});
test("mode drafts, history navigation and portal focus stay isolated", async ({ page }) => {
	await setup(page, false);
	await page.goto("/create");
	await expect(page.locator("#landing-edit-prompt")).toBeEnabled();
	await page.locator("#landing-edit-prompt").fill("An image draft kept through video mode.");
	await mode(page, "video");
	await page.locator("#video-prompt").fill("A different video draft.");
	await page.locator("#video-model").click();
	await page.goBack();
	await expect(page.locator('[data-test="video-model-menu"]')).toBeHidden();
	await expect(
		page.locator('[data-generator-panel="image"] [data-generator-mode="image"]'),
	).toBeFocused();
	await expect(page.locator("#landing-edit-prompt")).toHaveValue(
		"An image draft kept through video mode.",
	);
	await page.goForward();
	await expect(page.locator("#video-prompt")).toHaveValue("A different video draft.");
	let releaseDraftModule!: () => void;
	const draftModuleReady = new Promise<void>((resolve) => {
		releaseDraftModule = resolve;
	});
	let draftModuleRequested = false;
	await page.route("**/_next/static/**/*.js", async (route) => {
		const response = await route.fetch();
		const source = await response.text();
		if (source.includes("ezpic.editor-upgrade.v1")) {
			draftModuleRequested = true;
			await draftModuleReady;
		}
		await route.fulfill({ response });
	});
	try {
		await page.getByRole("button", { name: "Sign in to generate", exact: true }).click();
		await expect.poll(() => draftModuleRequested).toBe(true);
		await expect(page.locator("[data-generation-mode]")).toHaveAttribute("inert", "");
		await expect(page.locator("[data-generation-mode]")).toHaveAttribute("aria-busy", "true");
	} finally {
		releaseDraftModule();
	}
	await page.unrouteAll({ behavior: "wait" });
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	const destination = new URL(new URL(page.url()).searchParams.get("redirectTo")!, "http://local");
	expect(destination.searchParams.get("videoResume")).toBe("1");
	expect(destination.searchParams.get("resume")).toBe("text");
	expect(
		await page.evaluate(
			() => JSON.parse(sessionStorage.getItem("ezpic.editor-upgrade.v1")!).draft.input.prompt,
		),
	).toBe("An image draft kept through video mode.");
	expect(
		await page.evaluate(
			() => JSON.parse(sessionStorage.getItem("video-v1:guest-handoff")!).draft.prompt,
		),
	).toBe("A different video draft.");
});
test("price invalidation, known rejection and immutable unknown-response retry", async ({
	page,
}) => {
	const state = await setup(page);
	await page.goto("/create?mode=video");
	await reviewChangedPrice(page, state);
	await page.locator("#video-prompt").fill("Changed prompt invalidates the old quote.");
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	await reviewChangedPrice(page, state);
	state.createError = "INSUFFICIENT_CREDITS";
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	state.createError = null;
	state.creates = [];
	state.loseFirst = true;
	await reviewChangedPrice(page, state);
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("same request");
	await page.reload();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("same request");
	await page.locator('[data-test="video-confirm"]').evaluate((button) => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	expect(state.creates).toHaveLength(2);
	expect(state.creates[1]).toEqual(state.creates[0]);
});
test("upload and in-flight creation survive switching, retaining the job after Back", async ({
	page,
}) => {
	const state = await setup(page);
	let seal!: () => void;
	state.sealGate = new Promise((resolve) => {
		seal = resolve;
	});
	await page.goto("/create");
	await page.locator("#landing-edit-prompt").fill("Image remains unchanged.");
	await mode(page, "video");
	await page.locator("#video-image").setInputFiles({
		name: "reference.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await expect(page.locator("#video-upload-status")).toContainText("Verifying");
	await mode(page, "image");
	seal();
	await mode(page, "video");
	await expect(page.locator("#video-upload-status")).toContainText("Image secured");
	await reviewChangedPrice(page, state);
	let create!: () => void;
	state.createGate = new Promise((resolve) => {
		create = resolve;
	});
	await page.locator('[data-test="video-confirm"]').click();
	await expect.poll(() => state.creates.length).toBe(1);
	await mode(page, "image");
	create();
	await expect(page).toHaveURL(/videoJob=ui-video-1/);
	expect(new URL(page.url()).searchParams.get("mode")).toBeNull();
	await expect(page.locator("#landing-edit-prompt")).toHaveValue("Image remains unchanged.");
	await mode(page, "video");
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
	await page.goBack();
	await mode(page, "video");
	await expect(page.locator('[data-test="video-job"]')).toBeVisible();
});

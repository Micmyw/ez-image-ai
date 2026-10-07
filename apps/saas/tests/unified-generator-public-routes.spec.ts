import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { getVideoModelOptions, VIDEO_MODEL_CATALOG } from "@repo/config/video-models";

const evidence = path.resolve(__dirname, "../../../output/playwright");
type State = {
	signedIn: boolean;
	creates: any[];
	quotes: any[];
	loseFirst: boolean;
	createError: string | null;
	createGate?: Promise<void>;
	sealGate?: Promise<void>;
};
async function setup(page: Page, signedIn = true) {
	const state: State = { signedIn, creates: [], quotes: [], loseFirst: false, createError: null };
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
								userId: "ui-owner",
								token: "ui-only",
								expiresAt: new Date(Date.now() + 3600000).toISOString(),
							},
							user: {
								id: "ui-owner",
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
		if (endpoint === "catalog")
			return reply({
				available: true,
				accessAllowed: true,
				maxInputBytes: 10485760,
				models: VIDEO_MODEL_CATALOG.map((model) => ({
					productKey: model.productKey,
					available: model.status === "implemented",
					reasons: [],
					options: model.modes.flatMap((mode) => [
						...new Map(
							getVideoModelOptions(model.productKey, mode).map(
								({ duration, resolution, sound }) => [
									`${duration}:${resolution}:${sound}`,
									{
										mode,
										duration,
										resolution,
										sound,
										available: true,
										credits: "23",
										reasons: [],
									},
								],
							),
						).values(),
					]),
				})),
			});
		if (endpoint === "quote") {
			state.quotes.push(body);
			return reply({
				quoteId: `ui-quote-${state.quotes.length}`,
				credits: "23",
				expiresAt: new Date(Date.now() + 60000).toISOString(),
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
		if (endpoint === "uploads/create")
			return reply({
				sessionId: "ui-upload",
				assetId: "ui-asset",
				uploadUrl: url.origin + "/__video-ui-upload",
				method: "PUT",
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			});
		if (endpoint === "uploads/complete") {
			await state.sealGate;
			return reply({
				assetId: "ui-asset",
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
async function quote(page: Page) {
	await page.locator("#video-prompt").fill("A slow camera above a quiet lake at golden hour.");
	await page.locator('[data-test="video-quote"]').click();
	await expect(page.locator('[data-test="video-confirm"]')).toContainText("23 credits");
}
test("desktop and mobile compact composer, accessible model and settings menus", async ({
	page,
}) => {
	test.setTimeout(120000);
	await setup(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/create?mode=video");
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await page.getByRole("button", { name: "Decline optional", exact: true }).click();
	await page
		.locator("#video-prompt")
		.fill("A slow aerial shot over a quiet lake, warm morning light, natural motion.");
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidence, "ezimage-video-desktop.png"),
	});
	await page.locator("#video-model").click();
	await expect(page.locator('[data-test="video-model-menu"]')).toBeVisible();
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
	await page.getByRole("button", { name: "Sign in to generate", exact: true }).click();
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	const destination = new URL(new URL(page.url()).searchParams.get("redirectTo")!, "http://local");
	expect(destination.searchParams.get("videoResume")).toBe("1");
	expect(destination.searchParams.get("resume")).toBe("text");
	expect(
		await page.evaluate(
			() => JSON.parse(sessionStorage.getItem("ezpic.editor-upgrade.v1")!).draft.input.prompt,
		),
	).toBe("An image draft kept through video mode.");
});
test("price invalidation, known rejection and immutable unknown-response retry", async ({
	page,
}) => {
	const state = await setup(page);
	await page.goto("/create?mode=video");
	await quote(page);
	await page.locator("#video-prompt").fill("Changed prompt invalidates the old quote.");
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	await quote(page);
	state.createError = "INSUFFICIENT_CREDITS";
	await page.locator('[data-test="video-confirm"]').click();
	await expect(page.locator("#video-prompt")).toBeEnabled();
	await expect(page.locator('[data-test="video-confirm"]')).toHaveCount(0);
	state.createError = null;
	state.creates = [];
	state.loseFirst = true;
	await quote(page);
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
	await page
		.locator("#video-image")
		.setInputFiles({
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
	await quote(page);
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

import { expect, type Locator, type Page, test } from "@playwright/test";

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const capability = {
	version: "landing-e2e-v2",
	enabled: true,
	reason: null,
	upload: {
		mimeTypes: ["image/jpeg", "image/png", "image/webp"],
		maximumBytes: 10 * 1024 * 1024,
	},
	products: [
		{
			key: "image-fast",
			label: "Standard Edit",
			description: "Private prompt-based image editing at the Standard tier",
			credits: "5",
			accessHint: "guest-trial",
			aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
		},
		{
			key: "image-quality",
			label: "Quality Edit",
			description: "Private prompt-based image editing at the Quality tier",
			credits: "40",
			accessHint: "paid-account",
			aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
		},
	],
	queueEstimate: { kind: "capacity" },
} as const;

test.beforeEach(async ({ page }) => {
	await page.route("**/api/media/guest-capability", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(capability),
		});
	});
});

test("the landing generator reports capability checking before it becomes ready", async ({
	page,
}) => {
	const capabilityRequested = deferred<void>();
	const capabilityGate = deferred<void>();
	await page.route("**/api/media/guest-capability", async (route) => {
		capabilityRequested.resolve();
		await capabilityGate.promise;
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(capability) });
	});

	await page.goto("/");
	await capabilityRequested.promise;
	try {
		await expect(stage(page, "checking")).toBeVisible();
		await expect(page.getByText(/wait while edit availability is checked/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeDisabled();
	} finally {
		capabilityGate.resolve();
	}
	await expect(stage(page, "ready")).toBeVisible();
});

test("a failed capability check can be retried without reloading the page", async ({ page }) => {
	let attempts = 0;
	await page.route("**/api/media/guest-capability", async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
			return;
		}
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(capability) });
	});

	await page.goto("/");
	await expect(stage(page, "failed")).toBeVisible();
	const retryName = /check edit availability again/i;
	await expect(
		page.locator('[data-test="landing-generator"]').getByRole("button", { name: retryName }),
	).toBeEnabled();

	await page.locator("#examples").scrollIntoViewIfNeeded();
	const dock = page.locator('[data-test="floating-editor-dock"]');
	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	const floatingRetry = dock.getByRole("button", { name: retryName });
	await expect(floatingRetry).toBeEnabled();
	await floatingRetry.click();
	await expect(stage(page, "ready")).toBeVisible();
	expect(attempts).toBe(2);
});

test("an inconsistent enabled capability without products fails closed", async ({ page }) => {
	await page.route("**/api/media/guest-capability", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ ...capability, products: [] }),
		});
	});

	await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();
	await expect(page.getByText(/editing is unavailable right now/i)).toBeVisible();
	await expect(page.getByRole("group", { name: /edit tier/i })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeDisabled();
});

test("the public root exposes the image editor before authentication", async ({ page }) => {
	await page.goto("/");

	await expect(page).toHaveURL(/\/$/);
	await expect(page).toHaveTitle(/EzPic AI Image Editor/i);
	const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
	expect(canonical).not.toBeNull();
	expect(new URL(canonical!).origin).toBe(new URL(page.url()).origin);
	await expect(
		page.getByRole("heading", {
			level: 1,
			name: /ai image editor with prompts/i,
		}),
	).toBeVisible();
	await expect(page.getByLabel(/source image/i)).toBeAttached();
	await expect(
		page.getByRole("button", { name: /drop an image here or choose a file/i }),
	).toBeVisible();
	await expect(page.getByLabel(/describe your edit/i)).toBeVisible();
	await expect(page.getByRole("radio", { name: /standard edit/i })).toBeChecked();
	await expect(page.getByRole("radio", { name: /quality edit/i })).not.toBeChecked();
	await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeVisible();
	await expect(page.getByRole("banner").getByRole("link", { name: /sign in/i })).toHaveAttribute(
		"href",
		"/login",
	);
	expect(
		await page
			.locator("main section[id]")
			.evaluateAll((sections) => sections.map((section) => section.id)),
	).toEqual([
		"image-editor",
		"before-after",
		"examples",
		"creator-workflows",
		"how-it-works",
		"pricing",
		"faq",
	]);
	const storyWall = page.locator('[data-test="user-story-wall"]');
	await expect(storyWall).toContainText(/six composite creator profiles/i);
	await expect(storyWall.locator("#creator-workflows-disclaimer")).toContainText(
		/not customer testimonials, published case studies, or promised results/i,
	);
	await expect(page.locator("body")).not.toContainText(
		/raphael|openrouter|sourceful|riverflow|providerModelId|providerCostMicros/i,
	);
});

test("the editor follows the user as a compact dock and expands without losing input", async ({
	page,
}) => {
	await page.goto("/");
	await expect(stage(page, "ready")).toBeVisible();

	const dock = page.locator('[data-test="floating-editor-dock"]');
	await expect(dock).toHaveCount(0);

	await page.locator("#examples").scrollIntoViewIfNeeded();
	await expect(dock).toBeVisible();
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toHaveCount(0);

	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toBeVisible();

	const floatingPrompt = dock.getByLabel(/describe your edit/i);
	await floatingPrompt.fill("Turn the background into a quiet lilac studio");
	await expect(page.getByLabel(/describe your edit/i).first()).toHaveValue(
		"Turn the background into a quiet lilac studio",
	);

	await page.keyboard.press("Escape");
	await expect(dock.locator('[data-test="floating-editor-expanded"]')).toHaveCount(0);
	await expect(dock.getByRole("button", { name: /open the quick editor/i })).toBeFocused();

	await dock.getByRole("button", { name: /open the quick editor/i }).click();
	await expect(floatingPrompt).toBeFocused();
	await page.locator('[data-test="landing-generator"]').scrollIntoViewIfNeeded();
	await expect(dock).toHaveCount(0);
	await expect(page.getByLabel(/describe your edit/i).first()).toBeFocused();
});

test("the landing generator supports tier choice plus drop, replace, and removal", async ({
	page,
}) => {
	await page.goto("/");

	const standard = page.getByRole("radio", { name: /standard edit/i });
	const quality = page.getByRole("radio", { name: /quality edit/i });
	const action = page.getByRole("button", { name: /try one standard edit free/i });
	await expect(standard).toBeChecked();
	await expect(action).toBeDisabled();
	await expect(page.getByText(/add a source image to continue/i)).toBeVisible();

	await quality.check();
	await expect(quality).toBeChecked();
	await expect(
		page.getByText(
			/quality edit continues after sign-in and requires a creator or studio account/i,
		),
	).toBeVisible();
	await page.getByRole("button", { name: /open output settings/i }).click();
	const automaticAspectRatio = page.getByRole("radio", { name: "Automatic", exact: true });
	const landscapeAspectRatio = page.getByRole("radio", { name: "16:9", exact: true });
	await expect(automaticAspectRatio).toBeChecked();
	await page.getByText("16:9", { exact: true }).click();
	await expect(landscapeAspectRatio).toBeChecked();
	await page.keyboard.press("Escape");

	const dropZone = page.getByRole("button", {
		name: /drop an image here or choose a file/i,
	});
	await dropPng(page, dropZone, "dropped-source.png");
	await expect(page.getByRole("img", { name: /preview of dropped-source\.png/i })).toBeVisible();
	await expect(page.getByText(/describe the edit you want to continue/i)).toBeVisible();

	await page.getByLabel(/source image/i).setInputFiles(pngFile("replacement-source.png"));
	await expect(
		page.getByRole("img", { name: /preview of replacement-source\.png/i }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /replace image/i })).toBeVisible();

	await page.getByLabel(/describe your edit/i).fill("Keep the subject and replace the background");
	await expect(page.getByRole("button", { name: /continue with quality edit/i })).toBeEnabled();

	await page.getByRole("button", { name: /remove image/i }).click();
	await expect(page.getByRole("img", { name: /preview of replacement-source\.png/i })).toHaveCount(
		0,
	);
	await expect(quality).toBeChecked();
	await expect(page.getByLabel(/describe your edit/i)).toHaveValue(
		"Keep the subject and replace the background",
	);
});

test("the selected tier crosses each private-upload stage without leaking routing details", async ({
	page,
}) => {
	const intentGate = deferred<void>();
	const uploadGate = deferred<void>();
	const verificationGate = deferred<void>();
	const intentRequested = deferred<void>();
	const uploadRequested = deferred<void>();
	const verificationRequested = deferred<void>();
	const handoffRequested = deferred<void>();
	let intentBody: Record<string, unknown> | undefined;
	let completionBody: Record<string, unknown> | undefined;
	let handoffBody = "";

	await page.route("**/api/media/guest-drafts/upload-intents", async (route) => {
		intentBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		intentRequested.resolve();
		await intentGate.promise;
		const appOrigin = new URL(route.request().url()).origin;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				sessionId: "landing-session",
				assetId: "landing-asset",
				uploadUrl: `${appOrigin}/__landing-upload/source`,
				completionToken: "c".repeat(43),
				expiresAt: "2026-09-01T00:00:00.000Z",
			}),
		});
	});
	await page.route("**/__landing-upload/source", async (route) => {
		uploadRequested.resolve();
		await uploadGate.promise;
		await route.fulfill({ status: 200, body: "" });
	});
	await page.route("**/api/media/guest-drafts/upload-completions", async (route) => {
		completionBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		verificationRequested.resolve();
		await verificationGate.promise;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				status: "READY",
				claimToken: "d".repeat(43),
				continueUrl: "/draft/continue",
				productKey: "image-quality",
				accessHint: "paid-account",
			}),
		});
	});
	await page.route("**/draft/continue", async (route) => {
		handoffBody = route.request().postData() ?? "";
		handoffRequested.resolve();
		await route.fulfill({ status: 204 });
	});

	await page.goto("/");
	await page.getByRole("radio", { name: /quality edit/i }).check();
	await page.getByRole("button", { name: /open output settings/i }).click();
	await page.getByText("16:9", { exact: true }).click();
	await page.keyboard.press("Escape");
	await page.getByLabel(/source image/i).setInputFiles(pngFile("quality-source.png"));
	await page.getByLabel(/describe your edit/i).fill("Preserve the product details");
	await page.getByRole("button", { name: /continue with quality edit/i }).click();

	await intentRequested.promise;
	await expect(stage(page, "preparing")).toBeVisible();
	expect(intentBody).toMatchObject({ productKey: "image-quality" });
	intentGate.resolve();

	await uploadRequested.promise;
	await expect(stage(page, "uploading")).toBeVisible();
	uploadGate.resolve();

	await verificationRequested.promise;
	await expect(stage(page, "verifying")).toBeVisible();
	expect(completionBody).toMatchObject({ productKey: "image-quality", aspectRatio: "16:9" });
	await expect(page.locator("body")).not.toContainText(
		/openrouter|sourceful|riverflow|providerModelId|providerCostMicros/i,
	);
	verificationGate.resolve();

	await handoffRequested.promise;
	await expect(stage(page, "handoff")).toBeVisible();
	expect(handoffBody).toContain("intent=continue-account-draft");
});

test("a retryable failure preserves the image, prompt, and selected tier", async ({ page }) => {
	let attempts = 0;
	const secondAttempt = deferred<Record<string, unknown>>();
	await page.route("**/api/media/guest-drafts/upload-intents", async (route) => {
		attempts += 1;
		if (attempts === 2) {
			secondAttempt.resolve(
				JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
			);
		}
		await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
	});

	await page.goto("/");
	const quality = page.getByRole("radio", { name: /quality edit/i });
	const prompt = page.getByLabel(/describe your edit/i);
	await quality.check();
	await page.getByLabel(/source image/i).setInputFiles(pngFile("retry-source.png"));
	await prompt.fill("Keep this prompt through the retry");
	await page.getByRole("button", { name: /continue with quality edit/i }).click();

	await expect(stage(page, "failed")).toBeVisible();
	await expect(page.getByRole("img", { name: /preview of retry-source\.png/i })).toBeVisible();
	await expect(prompt).toHaveValue("Keep this prompt through the retry");
	await expect(quality).toBeChecked();
	await page.getByRole("button", { name: /retry quality edit/i }).click();
	await expect(secondAttempt.promise).resolves.toMatchObject({ productKey: "image-quality" });
});

test("the landing page proves edits with an interactive comparison and visual examples", async ({
	page,
}) => {
	await page.goto("/");

	const comparison = page.getByRole("slider", {
		name: /compare original and edited illustration/i,
	});
	await expect(comparison).toBeVisible();
	await expect(comparison).toHaveValue("52");

	await page.getByRole("button", { name: /show original/i }).click();
	await expect(comparison).toHaveValue("0");
	await page.getByRole("button", { name: /show edit direction/i }).click();
	await expect(comparison).toHaveValue("100");
	await comparison.fill("36");
	await expect(comparison).toHaveValue("36");

	const examples = page.locator("#examples article");
	await expect(examples).toHaveCount(12);
	await expect(page.locator("#examples img")).toHaveCount(12);
	expect(
		await page
			.locator("#examples img")
			.evaluateAll((images) =>
				images.every((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
			),
	).toBe(true);

	const prompt = page.getByLabel(/describe your edit/i);
	await page.getByRole("button", { name: /use the mediterranean quiet prompt/i }).click();
	await expect(prompt).toHaveValue(/sunlit mediterranean retreat/i);
	await expect(prompt).toBeFocused();
});

test("creator workflows become static when reduced motion is requested", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");

	const workflows = page.locator("#creator-workflows");
	await expect(workflows.locator(".creator-workflows-track").first()).toHaveCSS(
		"animation-name",
		"none",
	);
	await expect(workflows.locator(".creator-workflows-duplicate").first()).toBeHidden();
	await expect(workflows.locator('button[aria-controls="creator-workflows-motion"]')).toBeHidden();
});

test("creator workflow movement can be paused and resumed", async ({ page }) => {
	await page.goto("/");

	const workflows = page.locator("#creator-workflows");
	const track = workflows.locator(".creator-workflows-track--one");
	const pauseButton = workflows.getByRole("button", { name: /pause movement/i });
	await workflows.scrollIntoViewIfNeeded();
	await expect(track).toHaveCSS("animation-play-state", "running");

	await pauseButton.click();
	await expect(track).toHaveCSS("animation-play-state", "paused");
	const resumeButton = workflows.getByRole("button", { name: /resume movement/i });
	await resumeButton.click();
	await expect(track).toHaveCSS("animation-play-state", "running");
});

function pngFile(name: string) {
	return {
		name,
		mimeType: "image/png",
		buffer: Buffer.from(ONE_PIXEL_PNG, "base64"),
	};
}

async function dropPng(page: Page, dropZone: Locator, name: string) {
	const dataTransfer = await page.evaluateHandle(
		({ base64, fileName }) => {
			const binary = atob(base64);
			const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
			return transfer;
		},
		{ base64: ONE_PIXEL_PNG, fileName: name },
	);
	await dropZone.dispatchEvent("dragenter", { dataTransfer });
	await dropZone.dispatchEvent("dragover", { dataTransfer });
	await dropZone.dispatchEvent("drop", { dataTransfer });
	await dataTransfer.dispose();
}

function stage(page: Page, value: string) {
	return page.locator(`[data-test="landing-stage"][data-stage="${value}"]`);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("the landing tool stays usable at desktop and narrow mobile widths", async ({
	page,
}, testInfo) => {
	for (const viewport of [
		{ width: 1440, height: 1000 },
		{ width: 390, height: 844 },
		{ width: 320, height: 800 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByLabel(/describe your edit/i)).toBeVisible();
		await expect(
			page.getByRole("button", { name: /drop an image here or choose a file/i }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeVisible();
		if (viewport.width < 768) {
			await expect(page.locator('[data-test="mobile-section-nav"]')).toBeVisible();
			await expect(page.getByText("5 credits", { exact: true }).first()).toBeVisible();
		}
		const [sourceRect, promptRect, tierRect] = await Promise.all([
			box(page.getByRole("button", { name: /drop an image here or choose a file/i })),
			box(page.getByLabel(/describe your edit/i)),
			box(page.getByRole("group", { name: /edit tier/i })),
		]);
		expect(sourceRect.x).toBeLessThan(promptRect.x);
		expect(Math.abs(sourceRect.y - promptRect.y)).toBeLessThan(2);
		expect(
			Math.max(sourceRect.y + sourceRect.height, promptRect.y + promptRect.height),
		).toBeLessThan(tierRect.y);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
			`${viewport.width}px horizontal overflow`,
		).toBe(true);
		const [firstExample, secondExample] = await Promise.all([
			box(page.locator("#examples article").nth(0)),
			box(page.locator("#examples article").nth(1)),
		]);
		expect(firstExample.x).toBeLessThan(secondExample.x);
		expect(Math.abs(firstExample.y - secondExample.y)).toBeLessThan(2);
		await page.getByRole("radio", { name: /quality edit/i }).check();
		await page.getByLabel(/source image/i).setInputFiles(pngFile(`source-${viewport.width}.png`));
		await page.getByLabel(/describe your edit/i).fill("Keep the subject sharp");
		await expect(page.getByRole("button", { name: /continue with quality edit/i })).toBeEnabled();
		await testInfo.attach(`landing-${viewport.width}`, {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	}
});

test("the before-and-after control has a visible keyboard focus treatment", async ({ page }) => {
	await page.goto("/");
	const slider = page.getByRole("slider", { name: /compare original and edited illustration/i });
	await slider.focus();
	await expect(slider).toBeFocused();
	const frame = page.locator('[data-test="before-after-frame"]');
	await expect(frame).toBeVisible();
	expect(await frame.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});

async function box(locator: Locator) {
	return locator.evaluate((element) => {
		const { x, y, width, height } = element.getBoundingClientRect();
		return { x, y, width, height };
	});
}

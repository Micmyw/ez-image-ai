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
			description: "Fast everyday edits",
			credits: "5",
			accessHint: "guest-trial",
		},
		{
			key: "image-quality",
			label: "Quality Edit",
			description: "Higher-fidelity edits",
			credits: "40",
			accessHint: "paid-account",
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

test("the public root exposes the image editor before authentication", async ({ page }) => {
	const separateServiceRequests: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "3001") {
			separateServiceRequests.push(request.url());
		}
	});

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
	).toEqual(["image-editor", "before-after", "examples", "how-it-works", "pricing", "faq"]);
	await expect(page.locator("body")).not.toContainText(
		/raphael|openrouter|sourceful|riverflow|providerModelId|providerCostMicros/i,
	);
	expect(separateServiceRequests).toEqual([]);
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
	await expect(page.getByText(/creator or studio account required/i)).toBeVisible();

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
	const handoffGate = deferred<void>();
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
		await handoffGate.promise;
		await route.fulfill({ contentType: "text/html", body: "<main>handoff complete</main>" });
	});

	await page.goto("/");
	await page.getByRole("radio", { name: /quality edit/i }).check();
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
	expect(completionBody).toMatchObject({ productKey: "image-quality" });
	await expect(page.locator("body")).not.toContainText(
		/openrouter|sourceful|riverflow|providerModelId|providerCostMicros/i,
	);
	const handoffVisible = expect(stage(page, "handoff")).toBeVisible();
	verificationGate.resolve();

	await handoffVisible;
	await handoffRequested.promise;
	expect(handoffBody).toContain("intent=continue-account-draft");
	handoffGate.resolve();
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
	await expect(examples).toHaveCount(6);
	await expect(page.locator("#examples img")).toHaveCount(6);
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
		const [sourceRect, promptRect, tierRect] = await Promise.all([
			box(page.getByRole("button", { name: /drop an image here or choose a file/i })),
			box(page.getByLabel(/describe your edit/i)),
			box(page.getByRole("group", { name: /edit tier/i })),
		]);
		if (viewport.width >= 1024) {
			expect(sourceRect.x).toBeLessThan(promptRect.x);
			expect(promptRect.x).toBeLessThan(tierRect.x);
		} else {
			expect(sourceRect.y).toBeLessThan(promptRect.y);
			expect(promptRect.y).toBeLessThan(tierRect.y);
		}
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
			`${viewport.width}px horizontal overflow`,
		).toBe(true);
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

async function box(locator: Locator) {
	return locator.evaluate((element) => {
		const { x, y, width, height } = element.getBoundingClientRect();
		return { x, y, width, height };
	});
}

import { expect, test } from "@playwright/test";

const saasUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const marketingUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";

test("generator sits between the hero and feature proof", async ({ page }) => {
	await page.goto("/");
	const generator = page.getByRole("heading", {
		level: 1,
		name: /ai image editor with prompts, without the usual restrictions/i,
	});
	await expect(generator).toBeVisible();
	await expect(page.locator("section#examples")).toBeVisible();
	const order = await page
		.locator("main section[id]")
		.evaluateAll((nodes) => nodes.map(({ id }) => id));
	expect(order.indexOf("image-editor")).toBe(0);
	expect(order.indexOf("examples")).toBeGreaterThan(order.indexOf("before-after"));
});

test("guest selects a suggestion, uploads a Standard source, and hands off by POST", async ({
	page,
}) => {
	const intentEndpoint = new URL("/api/media/guest-drafts/upload-intents", saasUrl).toString();
	const uploadEndpoint = new URL("/e2e/guest-draft-upload", saasUrl).toString();
	const completionEndpoint = new URL(
		"/api/media/guest-drafts/upload-completions",
		saasUrl,
	).toString();
	const continueEndpoint = new URL("/draft/continue", saasUrl).toString();
	const claimToken = "q".repeat(43);
	const completionToken = "c".repeat(43);
	let intentPayload: Record<string, unknown> | undefined;
	let completionPayload: Record<string, unknown> | undefined;
	let uploaded = false;
	let handoff: { method: string; postData: string | null; url: string } | undefined;
	const corsHeaders = {
		"Access-Control-Allow-Headers": "content-type",
		"Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
		"Access-Control-Allow-Origin": marketingUrl,
	};

	await page.route(intentEndpoint, async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: corsHeaders });
			return;
		}
		intentPayload = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: corsHeaders,
			body: JSON.stringify({
				sessionId: "guest-upload-session-1",
				assetId: "asset-guest-upload-1",
				uploadUrl: uploadEndpoint,
				completionToken,
				expiresAt: "2099-08-29T00:00:00.000Z",
			}),
		});
	});
	await page.route(uploadEndpoint, async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: corsHeaders });
			return;
		}
		uploaded = route.request().method() === "PUT";
		await route.fulfill({ status: 200, headers: corsHeaders });
	});
	await page.route(completionEndpoint, async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: corsHeaders });
			return;
		}
		completionPayload = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: corsHeaders,
			body: JSON.stringify({ status: "READY", claimToken, continueUrl: "/draft/continue" }),
		});
	});
	await page.route(continueEndpoint, async (route) => {
		handoff = {
			method: route.request().method(),
			postData: route.request().postData(),
			url: route.request().url(),
		};
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<title>Sign in to continue</title><h1>Sign in to continue</h1>",
		});
	});

	await page.goto("/");
	const prompt = page.getByLabel(/describe your edit/i);
	await page.getByRole("button", { name: /replace the background/i }).click();
	await expect(prompt).toHaveValue(/replace the background/i);
	await expect.poll(() => intentPayload).toBeUndefined();

	await page.getByLabel("Source image", { exact: true }).setInputFiles({
		name: "source.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7X2wWQAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await expect(page.getByRole("img", { name: /preview of source\.png/i })).toBeVisible();
	await page.getByRole("button", { name: /try one standard edit free/i }).click();

	await expect
		.poll(() => intentPayload)
		.toMatchObject({
			capabilityVersion: expect.any(String),
			contentType: "image/png",
			bytes: expect.any(Number),
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			turnstileToken: "local-guest-upload",
		});
	await expect.poll(() => uploaded).toBe(true);
	await expect
		.poll(() => completionPayload)
		.toMatchObject({
			sessionId: "guest-upload-session-1",
			completionToken,
			capabilityVersion: intentPayload?.capabilityVersion,
			sha256: intentPayload?.sha256,
			prompt: expect.stringMatching(/replace the background/i),
		});
	expect(JSON.stringify({ intentPayload, completionPayload })).not.toMatch(
		/quote|reservation|provider|job|productKey/i,
	);
	await expect
		.poll(() => handoff)
		.toEqual({
			method: "POST",
			postData: `intent=continue-marketing-draft&claimToken=${claimToken}`,
			url: continueEndpoint,
		});
	await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
	expect(new URL(handoff!.url).search).toBe("");
});

test("guest receives accessible file errors without creating a draft", async ({ page }) => {
	let draftRequests = 0;
	await page.route(new URL("/api/media/drafts", saasUrl).toString(), async (route) => {
		draftRequests += 1;
		await route.abort();
	});
	await page.goto("/");

	const sourceInput = page.getByLabel("Source image", { exact: true });
	expect(await sourceInput.evaluate((input: HTMLInputElement) => input.labels?.length ?? 0)).toBe(
		1,
	);
	await sourceInput.setInputFiles({
		name: "animated.gif",
		mimeType: "image/gif",
		buffer: Buffer.from("GIF89a"),
	});

	await expect(page.locator("#marketing-reference-error")).toContainText(/jpeg, png, or webp/i);
	await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeVisible();
	expect(draftRequests).toBe(0);
});

test("editor controls support a basic keyboard and screen-reader workflow", async ({ page }) => {
	let draftRequests = 0;
	await page.route(new URL("/api/media/drafts", saasUrl).toString(), async (route) => {
		draftRequests += 1;
		await route.abort();
	});
	await page.goto("/");

	const sourceInput = page.getByLabel("Source image", { exact: true });
	const prompt = page.getByLabel(/describe your edit/i);
	const suggestion = page.getByRole("button", { name: /replace the background/i });
	const standardOffer = page.getByRole("button", { name: /try one standard edit free/i });

	await expect(sourceInput).toHaveAttribute("aria-required", "true");
	await expect(sourceInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
	await expect(prompt).toHaveAttribute("required", "");
	await expect(page.getByRole("link", { name: /quality edit.*creator or studio/i })).toBeVisible();
	await expect(page.getByRole("radiogroup", { name: /edit mode/i })).toHaveCount(0);

	await suggestion.focus();
	await expect(suggestion).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(prompt).toHaveValue(/replace the background/i);
	expect(draftRequests).toBe(0);

	await standardOffer.focus();
	await expect(standardOffer).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.locator("#marketing-reference-error")).toContainText(/choose a source image/i);
	expect(draftRequests).toBe(0);
});

test("guest promotion exposes only the metered Standard handoff", async ({ page }) => {
	let legacyDraftRequests = 0;
	await page.route(new URL("/api/media/drafts", saasUrl).toString(), async (route) => {
		legacyDraftRequests += 1;
		await route.abort();
	});

	await page.goto("/");
	await expect(page.getByRole("button", { name: /try one standard edit free/i })).toBeEnabled();
	await expect(page.getByRole("link", { name: /quality edit.*creator or studio/i })).toBeVisible();
	await expect(page.getByRole("radio", { name: /quality edit/i })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /continue to edit/i })).toHaveCount(0);
	expect(legacyDraftRequests).toBe(0);
});

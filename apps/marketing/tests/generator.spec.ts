import { expect, test } from "@playwright/test";
import pg from "pg";

const runId = process.env.E2E_RUN_ID;
const saasUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const marketingUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

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

test("guest selects a suggestion, uploads, chooses Quality, and hands off by POST", async ({
	page,
}) => {
	const draftEndpoint = new URL("/api/media/drafts", saasUrl).toString();
	const continueEndpoint = new URL("/draft/continue", saasUrl).toString();
	const claimToken = "q".repeat(43);
	let draftPayload: Record<string, unknown> | undefined;
	let handoff: { method: string; postData: string | null; url: string } | undefined;

	await page.route(draftEndpoint, async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({
				status: 204,
				headers: {
					"Access-Control-Allow-Headers": "content-type",
					"Access-Control-Allow-Methods": "POST, OPTIONS",
					"Access-Control-Allow-Origin": marketingUrl,
				},
			});
			return;
		}
		draftPayload = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Access-Control-Allow-Origin": marketingUrl },
			body: JSON.stringify({ claimToken, continueUrl: "/draft/continue" }),
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
	await expect.poll(() => draftPayload).toBeUndefined();

	await page.getByLabel(/source image/i).setInputFiles({
		name: "source.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7X2wWQAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await expect(page.getByRole("img", { name: /preview of source\.png/i })).toBeVisible();
	await page.getByLabel(/quality edit/i).check();
	await page.getByRole("button", { name: /continue to edit/i }).click();

	await expect
		.poll(() => draftPayload)
		.toMatchObject({
			productKey: "image-quality",
			input: { kind: "image-to-image", prompt: expect.stringMatching(/replace the background/i) },
			upload: { contentType: "image/png", base64: expect.any(String) },
		});
	expect(JSON.stringify(draftPayload)).not.toMatch(/quote|reservation|provider|job/i);
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

	const sourceInput = page.getByLabel(/source image/i);
	expect(await sourceInput.evaluate((input: HTMLInputElement) => input.labels?.length ?? 0)).toBe(
		1,
	);
	await sourceInput.setInputFiles({
		name: "animated.gif",
		mimeType: "image/gif",
		buffer: Buffer.from("GIF89a"),
	});

	await expect(page.locator("#marketing-reference-error")).toContainText(/jpeg, png, or webp/i);
	await expect(page.getByRole("button", { name: /continue to edit/i })).toBeVisible();
	expect(draftRequests).toBe(0);
});

test("editor controls support a basic keyboard and screen-reader workflow", async ({ page }) => {
	let draftRequests = 0;
	await page.route(new URL("/api/media/drafts", saasUrl).toString(), async (route) => {
		draftRequests += 1;
		await route.abort();
	});
	await page.goto("/");

	const sourceInput = page.getByLabel(/source image/i);
	const prompt = page.getByLabel(/describe your edit/i);
	const suggestion = page.getByRole("button", { name: /replace the background/i });
	const quality = page.getByLabel(/quality edit/i);

	await expect(sourceInput).toHaveAttribute("aria-required", "true");
	await expect(sourceInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
	await expect(prompt).toHaveAttribute("required", "");
	await expect(page.getByRole("radiogroup", { name: /edit mode/i })).toBeVisible();

	await suggestion.focus();
	await expect(suggestion).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(prompt).toHaveValue(/replace the background/i);
	expect(draftRequests).toBe(0);

	await quality.focus();
	await page.keyboard.press("Space");
	await expect(quality).toBeChecked();

	await page.getByRole("button", { name: /continue to edit/i }).click();
	await expect(page.locator("#marketing-reference-error")).toContainText(/choose a source image/i);
	expect(draftRequests).toBe(0);
});

test("draft handoff posts to SaaS and redirects without prompt data", async ({
	page,
}, testInfo) => {
	if (process.env.E2E_DRAFT_HANDOFF !== "true" || !runId) {
		throw new Error(
			"E2E_DRAFT_HANDOFF=true and E2E_RUN_ID are required; this scenario never skips",
		);
	}
	const prompt = `[e2e:draft] [run:${runId}] [retry:${testInfo.retry}] A private launch concept`;
	let claimToken = "";
	page.on("request", (request) => {
		if (request.url().endsWith("/draft/continue") && request.method() === "POST") {
			claimToken = new URLSearchParams(request.postData() ?? "").get("claimToken") ?? "";
		}
	});
	await page.goto("/");
	await page.getByLabel(/describe your edit/i).fill(prompt);
	await page.getByLabel(/source image/i).setInputFiles({
		name: "source.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7X2wWQAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await page.getByRole("button", { name: /continue to edit/i }).click();
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
	expect(page.url()).not.toContain(encodeURIComponent(prompt));
	expect(page.url()).not.toContain("private");
	expect(claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const activeDraft = (
		await pool.query(
			`SELECT id, "claimTokenHash", status FROM generation_draft WHERE "inputSnapshot"->>'prompt'=$1`,
			[prompt],
		)
	).rows[0] as { id: string; claimTokenHash: string; status: string };
	expect(activeDraft.claimTokenHash).not.toBe(claimToken);
	expect(activeDraft.claimTokenHash).toMatch(/^[a-f0-9]{64}$/);

	await page.getByLabel(/email/i).fill(`media-e2e-funded-${runId}@example.test`);
	await page.locator('input[type="password"]').fill(process.env.E2E_USER_PASSWORD!);
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/create$/);
	await expect(page.getByLabel(/prompt/i)).toHaveValue(prompt);
	expect(page.url()).not.toContain("private");

	const claimed = (
		await pool.query(`SELECT status FROM generation_draft WHERE id=$1`, [activeDraft.id])
	).rows[0] as { status: string };
	expect(claimed.status).toBe("SUBMITTED");
	const replay = await page.request.post(new URL("/draft/continue", saasUrl).toString(), {
		headers: {
			Origin: new URL(marketingUrl).origin,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		form: { intent: "continue-marketing-draft", claimToken },
		maxRedirects: 0,
	});
	expect(replay.status()).toBe(303);
	const replayCookie = replay.headers()["set-cookie"];
	expect(replayCookie).toContain("media_draft_claim=");
	expect(
		Number(
			(
				await pool.query(
					`SELECT count(*) FROM generation_draft WHERE id=$1 AND status='SUBMITTED'`,
					[activeDraft.id],
				)
			).rows[0].count,
		),
	).toBe(1);
});

test.afterAll(async () => pool.end());

import { expect, test } from "@playwright/test";

import { captureGrowthEvents } from "./growth-events";

const saasUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const marketingUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";

test("consent-gated local fixture records the complete marketing draft funnel once", async ({
	page,
}) => {
	const events = await captureGrowthEvents(page);
	const outboundGrowthPayloads: string[] = [];
	page.on("request", (request) => {
		const body = request.postData() ?? "";
		if (body.includes("landing_viewed") || body.includes("marketing_draft_created")) {
			outboundGrowthPayloads.push(body);
		}
	});

	const draftEndpoint = new URL("/api/media/drafts", saasUrl).toString();
	const continueEndpoint = new URL("/draft/continue", saasUrl).toString();
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
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Access-Control-Allow-Origin": marketingUrl },
			body: JSON.stringify({ claimToken: "q".repeat(43), continueUrl: "/draft/continue" }),
		});
	});
	await page.route(continueEndpoint, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<h1>Handoff fixture</h1>",
		});
	});

	await page.goto("/");
	const suggestion = page.getByRole("button", { name: /replace the background/i });
	await suggestion.click();
	expect(events).toEqual([]);

	await page.getByRole("button", { name: /allow optional/i }).click();
	await expect.poll(() => events.map(({ name }) => name)).toEqual(["landing_viewed"]);
	await suggestion.click();
	await suggestion.click();

	const chooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: /drop an image here or choose a file/i }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles({
		name: "private-source.png",
		mimeType: "image/png",
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7X2wWQAAAABJRU5ErkJggg==",
			"base64",
		),
	});
	await page.getByLabel(/quality edit/i).check();
	await page.getByRole("button", { name: /continue to edit/i }).click();
	await expect(page.getByRole("heading", { name: "Handoff fixture" })).toBeVisible();

	await expect
		.poll(() => events.map(({ name }) => name))
		.toEqual([
			"landing_viewed",
			"example_prompt_selected",
			"source_upload_started",
			"source_upload_completed",
			"marketing_draft_created",
			"auth_handoff_started",
		]);
	const serialized = JSON.stringify(events);
	expect(serialized).not.toMatch(
		/private-source|replace the background|qqqqq|https?:|asset|jobId|provider|model|cost|email|token/i,
	);
	expect(outboundGrowthPayloads).toEqual([]);
});

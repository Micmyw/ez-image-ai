import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { buildColoringPrompt } from "../modules/coloring/lib/coloring-prompt";

const route = "/photo-to-coloring-page";
test.setTimeout(120_000);
test.use({
	storageState: { cookies: [], origins: [] },
	contextOptions: { reducedMotion: "reduce" },
});

const product = {
	key: "image-nano-banana-2-lite",
	label: "Nano Banana 2 Lite",
	description: "Private image editing",
	credits: "5",
	accessHint: "guest-trial",
	aspectRatios: ["auto", "1:1"],
	skuMatrix: {
		defaultSkuKey: "nano-banana-2-lite-1k",
		dimensions: [{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] }],
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

for (const source of ["upload", "guest result"] as const) {
	test(`passes the selected ${source} and coloring instruction through the existing handoff (local fixtures)`, async ({
		page,
		baseURL,
	}, testInfo) => {
		const photoPath = resolve(__dirname, "../public/images/coloring/dog-photo.webp");
		const photo = readFileSync(photoPath);
		const sha256 = createHash("sha256").update(photo).digest("hex");
		let intent: Record<string, unknown> | null = null;
		let upload: { method: string; contentType: string; bytes: number; sha256: string } | null =
			null;
		let completion: Record<string, unknown> | null = null;
		let handoff = "";
		// Receive the real browser upload locally: CDP omits file-backed XHR request bodies.
		const uploadServer = createServer((request, response) => {
			response.setHeader("Access-Control-Allow-Origin", baseURL!);
			response.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
			response.setHeader("Access-Control-Allow-Headers", "Content-Type");
			if (request.method === "OPTIONS") {
				response.writeHead(204).end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const received = Buffer.concat(chunks);
				upload = {
					method: request.method!,
					contentType: request.headers["content-type"]!,
					bytes: received.length,
					sha256: createHash("sha256").update(received).digest("hex"),
				};
				response.writeHead(200).end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			uploadServer.once("error", reject);
			uploadServer.listen(0, "127.0.0.1", resolve);
		});
		try {
			const uploadUrl = `http://127.0.0.1:${(uploadServer.address() as AddressInfo).port}/upload`;
			await page.route("**/__coloring-test-upload", (request) =>
				request.continue({ url: uploadUrl }),
			);
			await page.route("**/api/media/guest-drafts/upload-intents", (request) => {
				intent = request.request().postDataJSON();
				return request.fulfill({
					json: {
						sessionId: "coloring-test-session",
						assetId: "coloring-test-asset",
						uploadUrl: new URL("/__coloring-test-upload", baseURL).href,
						completionToken: "c".repeat(43),
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				});
			});
			await page.route("**/api/media/guest-drafts/upload-completions", (request) => {
				completion = request.request().postDataJSON();
				return request.fulfill({
					json: {
						status: "READY",
						claimToken: "d".repeat(43),
						continueUrl: "/draft/continue",
						productKey: product.key,
						skuKey: product.skuMatrix.defaultSkuKey,
						accessHint: product.accessHint,
					},
				});
			});
			await page.route("**/draft/continue", (request) => {
				handoff = request.request().postData() ?? "";
				return request.fulfill({ status: 204 });
			});
			if (source === "guest result") {
				await page.route("**/api/rpc/media/getGuestAssetAccessUrl**", (request) => {
					expect(request.request().postDataJSON().json).toMatchObject({
						assetId: "selected-guest-output",
						jobId: "selected-guest-job",
						disposition: "inline",
					});
					return request.fulfill({
						json: {
							json: {
								assetId: "selected-guest-output",
								expiresIn: 60,
								url: new URL("/__coloring-authorized-source", baseURL).href,
							},
						},
					});
				});
				await page.route("**/__coloring-authorized-source", (request) =>
					request.fulfill({ body: photo, contentType: "image/webp" }),
				);
				const response = await page.goto(
					`${route}?guestAsset=selected-guest-output&guestJob=selected-guest-job#image-editor`,
				);
				expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
				await expect(page.locator('[data-test="landing-source-panel"] img')).toBeVisible();
				await expect(page.locator('[data-test="coloring-source-print"]')).toBeVisible();
				for (const width of [390, 320]) {
					await page.setViewportSize({ width, height: 1000 });
					expect(
						await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
					).toBe(true);
					await page.screenshot({ path: testInfo.outputPath("imported-" + width + ".png") });
				}
			} else {
				await page.goto(route);
				await expect(page.locator('[data-test="landing-generate"]')).toBeDisabled();
				await page.locator("#landing-source-image").setInputFiles(photoPath);
			}
			await expect(page.locator("#landing-edit-prompt")).toHaveValue(buildColoringPrompt());
			await page.getByRole("radio", { name: "Simple", exact: true }).check();
			await page.getByRole("button", { name: "Apply coloring settings", exact: true }).click();
			await expect(page.locator('[data-test="landing-generate"]')).toBeEnabled();
			expect(intent).toBeNull();
			expect(upload).toBeNull();
			expect(handoff).toBe("");
			await page.locator('[data-test="landing-generate"]').click();
			await expect.poll(() => handoff).toContain("claimToken=");
			expect(intent).toMatchObject({
				productKey: product.key,
				contentType: "image/webp",
				bytes: photo.length,
				sha256,
			});
			expect(upload).toEqual({
				method: "PUT",
				contentType: "image/webp",
				bytes: photo.length,
				sha256,
			});
			expect(completion).toMatchObject({
				sessionId: "coloring-test-session",
				productKey: product.key,
				sha256,
				prompt: buildColoringPrompt("simple", "remove"),
			});
			expect(handoff).toContain("intent=continue-marketing-draft");
		} finally {
			await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
		}
	});
}

test("keeps expired guest images out of the editor and offers recovery without generating", async ({
	page,
}) => {
	await page.route("**/api/rpc/media/getGuestAssetAccessUrl**", (request) =>
		request.fulfill({
			status: 404,
			json: { json: { code: "NOT_FOUND", status: 404, message: "Not found" } },
		}),
	);
	await page.goto(`${route}?guestAsset=expired&guestJob=guest#image-editor`);
	await expect(page.locator("#image-editor").getByRole("alert")).toContainText(
		"could not be opened",
	);
	await expect(page.locator('[data-test="coloring-source-print"]')).toHaveCount(0);
	await page.getByRole("button", { name: "Upload my own photo", exact: true }).click();
	await expect(page.locator("#landing-edit-prompt")).toHaveValue(buildColoringPrompt());
	await expect(page.locator('[data-test="landing-generate"]')).toBeDisabled();
});

test.beforeEach(async ({ page, baseURL }) => {
	expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(baseURL!).hostname);
	await page.route("**/api/**", async (request) => {
		const path = new URL(request.request().url()).pathname;
		if (
			path === "/api/media/guest-capability" ||
			path === "/api/rpc/media/getPublicCatalog" ||
			(path.startsWith("/api/auth/") && request.request().method() === "GET")
		)
			return request.continue();
		return request.abort();
	});
	await page.route("**/api/media/guest-capability", (request) =>
		request.fulfill({
			json: {
				version: "coloring-local-fixture",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [product],
				queueEstimate: { kind: "capacity" },
			},
		}),
	);
	await page.route("**/api/rpc/media/getPublicCatalog**", (request) =>
		request.fulfill({
			json: {
				json: {
					catalogVersion: "coloring-local-fixture",
					pricingVersion: "local",
					products: [{ ...product, inputKinds: ["image-to-image", "text-to-image"] }],
				},
			},
		}),
	);
});

test("serves English content, canonical, schema, assets and localized noindex views", async ({
	page,
	request,
	baseURL,
}) => {
	const response = await page.goto(route);
	expect(response?.status()).toBe(200);
	await expect(page.locator("h1")).toHaveText("Turn a photo into a coloring page");
	await expect(page).toHaveTitle("Turn Photo into Coloring Page | EzImageAI");
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}${route}`);
	const html = await response!.text();
	expect(html).toContain("generating a new image first is not required");
	const schema = await page.locator('script[type="application/ld+json"]').allTextContents();
	expect(
		schema.some((data) =>
			JSON.parse(data)["@graph"]?.some(
				(item: { "@type": string }) => item["@type"] === "WebApplication",
			),
		),
	).toBe(true);
	for (const image of await page.locator(".coloring-comparison img").all()) {
		await expect(image).toBeVisible();
		expect(
			await image.evaluate(
				(element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
			),
		).toBe(true);
	}
	const sitemap = await request.get("/sitemap.xml");
	expect(await sitemap.text()).toContain(`${baseURL}${route}`);
	const localized = await page.goto(`${route}?lang=de`);
	expect(localized?.headers()["x-robots-tag"]).toBe("noindex, follow");
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}${route}`);
	await expect(page.getByRole("heading", { name: "Eigenes Foto hochladen" })).toBeVisible();
});

test("uploads an existing photo and applies settings without submitting a generation", async ({
	page,
}) => {
	let submissionCount = 0;
	page.on("request", (request) => {
		if (/createGeneration|upload-intent|draft\/handoff/.test(request.url())) submissionCount++;
	});
	await page.goto(route);
	const prompt = page.locator("#landing-edit-prompt");
	await expect(prompt).toHaveValue(/Turn the uploaded photo into a printable/);
	await page
		.locator("#landing-source-image")
		.setInputFiles(resolve(__dirname, "../public/images/coloring/dog-photo.webp"));
	await expect(page.getByRole("button", { name: "Replace image", exact: true })).toBeVisible();
	const preview = page.locator('[data-test="landing-source-panel"] img');
	const before = await preview.getAttribute("src");
	await prompt.fill("My own custom instruction");
	await page.getByRole("radio", { name: "Simple", exact: true }).check();
	await page.getByLabel("Background", { exact: true }).selectOption("keep");
	await expect(prompt).toHaveValue("My own custom instruction");
	await page.getByRole("button", { name: "Apply coloring settings", exact: true }).click();
	await expect(prompt).toHaveValue(/large closed areas/);
	await expect(prompt).toHaveValue(/Keep the recognizable scene/);
	await expect(preview).toHaveAttribute("src", before!);
	expect(submissionCount).toBe(0);
});

test("fits desktop and small phones and keeps homepage/editor headings intact", async ({
	page,
}, testInfo) => {
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto(route);
		await expect(
			page.getByRole("button", { name: "Apply coloring settings", exact: true }),
		).toBeEnabled();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: testInfo.outputPath(`coloring-${width}.png`), fullPage: true });
	}
	for (const [url, heading] of [
		["/", /AI Image Editor No Restrictions/i],
		["/image-to-image", /Image to Image/i],
	] as const) {
		await page.goto(url);
		await expect(page.locator("h1")).toHaveText(heading);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
	}
});

test("prints only the image with A4 or Letter sizing and handles a failed image", async ({
	page,
}, testInfo) => {
	await page.goto(route);
	await page.evaluate(() => {
		new MutationObserver(() => {
			for (const frame of document.querySelectorAll<HTMLIFrameElement>(
				"iframe[data-image-print]",
			)) {
				if (frame.contentWindow)
					frame.contentWindow.print = () => frame.setAttribute("data-print-called", "true");
			}
		}).observe(document.body, { childList: true });
	});
	for (const [paper, dimensions] of [
		["a4", "A4"],
		["letter", "letter"],
	]) {
		await page.getByLabel("Paper size", { exact: true }).selectOption(paper);
		await page.getByRole("button", { name: "Print / Save PDF", exact: true }).click();
		const frame = page.locator("iframe[data-image-print]");
		await expect(frame).toHaveAttribute("data-print-called", "true");
		const printed = page.frameLocator("iframe[data-image-print]");
		await expect(printed.locator("body > img")).toHaveCount(1);
		await expect(printed.locator("body")).toHaveText("");
		expect(await printed.locator("style").textContent()).toContain(`size: ${dimensions} portrait`);
		expect(await printed.locator("style").textContent()).toContain("object-fit: contain");
		await frame.evaluate((element) => {
			element.style.cssText = "position:relative;width:800px;height:1100px;border:0";
		});
		await frame.screenshot({ path: testInfo.outputPath(`print-${paper}.png`) });
		await frame.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow!.dispatchEvent(new Event("afterprint")),
		);
		await expect(frame).toHaveCount(0);
	}
	await page.route("**/images/coloring/dog-coloring-page.webp", (request) => request.abort());
	await page.getByRole("button", { name: "Print / Save PDF", exact: true }).click();
	await expect(page.locator(".coloring-example").getByRole("alert")).toContainText(
		"could not be prepared for printing",
	);
	await expect(page.locator("iframe[data-image-print]")).toHaveCount(0);
});

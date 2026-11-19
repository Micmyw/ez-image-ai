import { createHash } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PRODUCT_KEY = "image-nano-banana-2-lite";
const SKU_KEY = "nano-banana-2-lite-1k";
const CLAIM_TOKEN = "d".repeat(43);
// Synthetic browser-cookie evidence is checked only by the mocked intent endpoint.
const GUEST_COOKIE = `${"b".repeat(43)}.${"s".repeat(43)}`;
const capability = {
	version: "guest-conversion-browser-v1",
	enabled: true,
	reason: null,
	upload: {
		mimeTypes: ["image/jpeg", "image/png", "image/webp"],
		maximumBytes: 10 * 1024 * 1024,
	},
	products: [
		{
			key: PRODUCT_KEY,
			label: "Nano Banana 2 Lite",
			description: "Private image editing",
			credits: "5",
			accessHint: "guest-trial",
			aspectRatios: ["auto", "1:1"],
			skuMatrix: {
				defaultSkuKey: SKU_KEY,
				dimensions: [
					{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
				],
				cells: [
					{
						skuKey: SKU_KEY,
						label: "1K",
						parameterValues: { resolution: "1k" },
						credits: 5,
						aspectRatios: ["auto", "1:1"],
						controls: [],
					},
				],
			},
		},
	],
	queueEstimate: { kind: "capacity" },
};

test("guest selection prepares before Generate and reuses the upload with the edited prompt", async ({
	page,
	baseURL,
}) => {
	const fixture = await installGuestBoundaries(page, baseURL, [1]);
	try {
		await openComposer(page, "/");
		const prompt = page.locator("#landing-edit-prompt");
		await prompt.fill("");
		const file = pngFile("early-reference.png");
		await page.locator("#landing-source-image").setInputFiles(file);
		await expect(page.getByRole("img", { name: "Preview of early-reference.png" })).toBeVisible();
		await expect.poll(() => fixture.preparations.length).toBe(1);
		await expect(prompt).toHaveValue("");
		expect(fixture.events).toEqual(["intent:1", "put:1", "preparation:1"]);
		expect(fixture.completions).toHaveLength(0);
		expect(fixture.handoffs).toHaveLength(0);

		const sha256 = hash(file.buffer);
		expect(fixture.intents[0]?.cookie).toContain(`ezpic_guest=${GUEST_COOKIE}`);
		expect(fixture.intents[0]?.body).toEqual(
			expect.objectContaining({
				requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				capabilityVersion: capability.version,
				productKey: PRODUCT_KEY,
				contentType: "image/png",
				bytes: file.buffer.length,
				sha256,
			}),
		);
		expect(fixture.uploads[0]).toEqual({
			session: 1,
			contentType: "image/png",
			bytes: file.buffer,
		});
		expect(fixture.preparations[0]).toEqual(
			expect.objectContaining({
				sessionId: "fixture-session-1",
				completionToken: completionToken(1),
				capabilityVersion: capability.version,
				sha256,
			}),
		);
		expect(fixture.preparations[0]).not.toHaveProperty("prompt");
		expect(fixture.preparations[0]).not.toHaveProperty("skuKey");

		await prompt.fill("Keep the subject and replace the background with a blue studio.");
		await expect(page.getByRole("img", { name: "Preview of early-reference.png" })).toBeVisible();
		await page.locator('[data-test="landing-generate"]').click();
		await expect(page.locator('[data-test="landing-stage"]')).toHaveAttribute(
			"data-stage",
			"preparing",
		);
		expect(fixture.completions).toHaveLength(0);
		fixture.releasePreparation(1);
		await expectInlineResult(page, fixture, "/");
		await page.reload();
		await expectInlineResult(page, fixture, "/");

		expect(fixture.completions).toEqual([
			expect.objectContaining({
				sessionId: "fixture-session-1",
				completionToken: completionToken(1),
				capabilityVersion: capability.version,
				productKey: PRODUCT_KEY,
				skuKey: SKU_KEY,
				sha256,
				prompt: "Keep the subject and replace the background with a blue studio.",
			}),
		]);
		expect(fixture.intents).toHaveLength(1);
		expect(fixture.uploads).toHaveLength(1);
		expect(fixture.preparations).toHaveLength(1);
		expect(fixture.handoffs).toEqual([
			expect.objectContaining({ intent: "continue-marketing-draft", claimToken: CLAIM_TOKEN }),
		]);
		expect(fixture.unexpectedMutations).toEqual([]);
	} finally {
		fixture.releaseAll();
	}
});

test("a confirmed image rejection offers an independent portrait pack without submitting a job", async ({
	page,
	baseURL,
}) => {
	const fixture = await installGuestBoundaries(page, baseURL, []);
	await page.route("**/api/media/guest-drafts/upload-completions", (route) =>
		route.fulfill({ json: { status: "FAILED", code: "GUEST_UPLOAD_CONTENT_REJECTED" } }),
	);
	let accessReads = 0;
	await page.route("**/api/rpc/portraitPacks/status", (route) => {
		accessReads++;
		return route.fulfill({ json: { json: { state: "guestTrial", remaining: 2, cards: null } } });
	});
	await openComposer(page);
	await page.locator("#landing-source-image").setInputFiles(pngFile("reference.png"));
	await page.locator("#landing-edit-prompt").fill("Edit this reference for the test.");
	await page.locator('[data-test="landing-generate"]').click();
	const invitation = page.getByRole("dialog", { name: "Want to open a portrait pack?" });
	await expect(invitation).toBeVisible();
	expect(accessReads).toBe(0);
	await invitation.getByRole("button", { name: "Try a pack" }).click();
	await expect(page.locator('[data-test="portrait-pack-open"]')).toBeEnabled();
	expect(accessReads).toBe(1);
	expect(fixture.submissions).toHaveLength(0);
});

test("replacing a preparing guest photo switches preview immediately and serializes upload identities", async ({
	page,
	baseURL,
}) => {
	const fixture = await installGuestBoundaries(page, baseURL, [1, 2]);
	try {
		await page.setViewportSize({ width: 390, height: 844 });
		await openComposer(page);
		const prompt = page.locator("#landing-edit-prompt");
		await prompt.fill("");
		await page.locator("#landing-source-image").setInputFiles(pngFile("first-reference.png"));
		await expect.poll(() => fixture.preparations.length).toBe(1);
		const secondFile = await coloredPng(page, "second-reference.png");
		await page.locator("#landing-source-image").setInputFiles(secondFile);
		const secondPreview = page.getByRole("img", { name: "Preview of second-reference.png" });
		await expect(secondPreview).toBeVisible();
		await expect(page.getByRole("img", { name: "Preview of first-reference.png" })).toHaveCount(0);
		const previewUrl = await secondPreview.getAttribute("src");
		await prompt.fill("Turn this second photo into a watercolor portrait.");
		expect(fixture.intents).toHaveLength(1);
		expect(fixture.completions).toHaveLength(0);

		fixture.releasePreparation(1);
		await expect.poll(() => fixture.preparations.length).toBe(2);
		await expect(secondPreview).toHaveAttribute("src", previewUrl!);
		await expect(prompt).toHaveValue("Turn this second photo into a watercolor portrait.");
		expect(fixture.events).toEqual([
			"intent:1",
			"put:1",
			"preparation:1",
			"sealed:1",
			"intent:2",
			"put:2",
			"preparation:2",
		]);
		expect(fixture.intents[1]?.body.requestId).not.toBe(fixture.intents[0]?.body.requestId);
		expect(fixture.intents[1]?.body.sha256).toBe(hash(secondFile.buffer));
		expect(fixture.intents[1]?.body.sha256).not.toBe(fixture.intents[0]?.body.sha256);
		expect(fixture.uploads[1]?.bytes).toEqual(secondFile.buffer);

		await page.locator('[data-test="landing-generate"]').click();
		await expect(page.locator('[data-test="landing-stage"]')).toHaveAttribute(
			"data-stage",
			"preparing",
		);
		expect(fixture.completions).toHaveLength(0);
		fixture.releasePreparation(2);
		await expectInlineResult(page, fixture, "/create");
		expect(fixture.completions).toEqual([
			expect.objectContaining({
				sessionId: "fixture-session-2",
				completionToken: completionToken(2),
				sha256: hash(secondFile.buffer),
				prompt: "Turn this second photo into a watercolor portrait.",
			}),
		]);
		expect(fixture.intents).toHaveLength(2);
		expect(fixture.uploads).toHaveLength(2);
		expect(fixture.preparations).toHaveLength(2);
		expect(fixture.handoffs).toHaveLength(1);
		expect(fixture.unexpectedMutations).toEqual([]);
	} finally {
		fixture.releaseAll();
	}
});

type RequestBody = Record<string, unknown>;

// Real composer, normalization, SHA-256, XHR, inline submission and result; only service
// boundaries are mocked. SEALED is a durable-review-intent fixture, not approval.
async function installGuestBoundaries(page: Page, baseURL: string | undefined, held: number[]) {
	if (!baseURL) throw new Error("GUEST_CONVERSION_LOOPBACK_BASE_URL_REQUIRED");
	const target = new URL(baseURL);
	if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname))
		throw new Error("GUEST_CONVERSION_LOOPBACK_BASE_URL_REQUIRED");
	const origin = target.origin;
	const intents: { body: RequestBody; cookie: string }[] = [];
	const uploads: { session: number; contentType: string; bytes: Buffer | null }[] = [];
	const preparations: RequestBody[] = [];
	const completions: RequestBody[] = [];
	const handoffs: Record<string, string>[] = [];
	const submissions: RequestBody[] = [];
	const navigations: string[] = [];
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname);
	});
	const events: string[] = [];
	const unexpectedMutations: string[] = [];
	const gates = new Map(held.map((session) => [session, deferred()]));

	await page.addInitScript(() => {
		const live = new Set<string>();
		let nextId = 0;
		Object.defineProperty(window, "turnstile", {
			value: {
				render(_container: HTMLElement, options: { callback: (token: string) => void }) {
					const id = `fixture-widget-${++nextId}`;
					live.add(id);
					queueMicrotask(() => {
						if (live.has(id)) options.callback(`fixture-turnstile-${id}`);
					});
					return id;
				},
				remove(id: string) {
					live.delete(id);
				},
			},
			configurable: true,
		});
	});
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== origin) return route.abort("blockedbyclient");
		const pathname = url.pathname;
		const method = request.method();
		if (pathname === "/api/media/guest-capability" && method === "GET") {
			return route.fulfill({
				json: capability,
				headers: {
					"Cache-Control": "no-store",
					"Set-Cookie": `ezpic_guest=${GUEST_COOKIE}; HttpOnly; SameSite=Lax; Path=/`,
				},
			});
		}
		if (pathname === "/api/rpc/media/getPublicCatalog") {
			return route.fulfill({
				json: {
					json: {
						catalogVersion: "guest-conversion-browser-v1",
						pricingVersion: "guest-conversion-browser-v1",
						products: capability.products.map((product) => ({
							...product,
							inputKinds: ["text-to-image", "image-to-image"],
						})),
					},
				},
			});
		}
		if (pathname === "/api/rpc/payments/getImagePassOffer" && method === "POST") {
			// RPCLink transports this public read with POST; no checkout is created.
			return route.fulfill({
				json: { json: { available: false } },
				headers: { "Cache-Control": "no-store" },
			});
		}
		if (pathname === "/api/auth/get-session") return route.fulfill({ json: null });
		if (pathname === "/api/auth/organization/list") return route.fulfill({ json: [] });
		if (pathname.startsWith("/api/analytics/")) return route.fulfill({ status: 204 });
		if (pathname === "/api/media/guest-drafts/upload-intents" && method === "POST") {
			const body = request.postDataJSON() as RequestBody;
			const session = intents.push({ body, cookie: (await request.headerValue("cookie")) ?? "" });
			events.push(`intent:${session}`);
			return route.fulfill({
				json: {
					sessionId: `fixture-session-${session}`,
					assetId: `fixture-asset-${session}`,
					uploadUrl: `${origin}/__guest-conversion-upload/${session}`,
					completionToken: completionToken(session),
					expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
				},
			});
		}
		if (pathname.startsWith("/__guest-conversion-upload/") && method === "PUT") {
			const session = Number(pathname.split("/").at(-1));
			uploads.push({
				session,
				contentType: (await request.headerValue("content-type")) ?? "",
				bytes: request.postDataBuffer(),
			});
			events.push(`put:${session}`);
			return route.fulfill({ status: 200, body: "" });
		}
		if (pathname === "/api/media/guest-drafts/upload-preparations" && method === "POST") {
			const body = request.postDataJSON() as RequestBody;
			preparations.push(body);
			const session = Number(String(body.sessionId).replace("fixture-session-", ""));
			events.push(`preparation:${session}`);
			await gates.get(session)?.promise;
			events.push(`sealed:${session}`);
			return route.fulfill({ json: { status: "SEALED" } });
		}
		if (pathname === "/api/media/guest-drafts/upload-completions" && method === "POST") {
			completions.push(request.postDataJSON() as RequestBody);
			return route.fulfill({
				json: {
					status: "READY",
					claimToken: CLAIM_TOKEN,
					continueUrl: "/draft/continue",
					productKey: PRODUCT_KEY,
					skuKey: SKU_KEY,
					accessHint: "guest-trial",
				},
			});
		}
		if (pathname === "/draft/continue" && method === "POST") {
			handoffs.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
			return route.fulfill({ json: { status: "BOOTSTRAP_REQUIRED" } });
		}
		if (pathname === "/api/auth/sign-in/anonymous" && method === "POST") {
			return route.fulfill({ json: { user: { id: "fixture-guest", isAnonymous: true } } });
		}
		if (pathname === "/draft/continue" && method === "GET") {
			return route.fulfill({ json: { status: "READY" } });
		}
		if (pathname === "/api/rpc/media/getGuestEligibility") {
			return route.fulfill({
				json: {
					json: {
						capabilityVersion: capability.version,
						eligible: submissions.length === 0,
						reason: submissions.length ? "EXISTING_TRIAL" : "AVAILABLE",
						existingJobId: submissions.length ? "fixture-guest-job" : null,
						trialAllowance: { limit: 1, remaining: submissions.length ? 0 : 1, resetsAt: null },
						claimedDraft: submissions.length
							? null
							: {
									sourceAssetId: "fixture-source",
									prompt: completions.at(-1)?.prompt,
									productKey: PRODUCT_KEY,
									skuKey: SKU_KEY,
									aspectRatio: "auto",
								},
					},
				},
			});
		}
		if (
			pathname === "/api/rpc/media/submitGuestGeneration" ||
			pathname === "/api/rpc/media/getGuestJob"
		) {
			if (pathname.endsWith("submitGuestGeneration")) submissions.push(request.postDataJSON().json);
			return route.fulfill({
				json: {
					json: {
						jobId: "fixture-guest-job",
						stage: "READY",
						resultAssetId: "fixture-result",
						projectedDispatchAt: new Date().toISOString(),
						estimateExpiresAt: new Date(Date.now() + 60_000).toISOString(),
						resultExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
						watermarked: true,
						trialConsumed: true,
						linkReady: true,
					},
				},
			});
		}
		if (pathname === "/api/rpc/media/getGuestAssetAccessUrl") {
			return route.fulfill({ json: { json: { url: `${origin}/__guest-inline-result.png` } } });
		}
		if (pathname === "/__guest-inline-result.png") {
			return route.fulfill({
				contentType: "image/png",
				body: Buffer.from(ONE_PIXEL_PNG, "base64"),
			});
		}
		// The local Next development overlay resolves source frames through this
		// exact diagnostic endpoint. Other non-GET requests remain blocked below.
		if (pathname === "/__nextjs_original-stack-frames" && method === "POST")
			return route.continue();
		if (!["GET", "HEAD"].includes(method)) unexpectedMutations.push(`${method} ${pathname}`);
		// Never let an unexpected API call create an account, job, payment, or provider task.
		if (pathname.startsWith("/api/") || !["GET", "HEAD"].includes(method)) {
			return route.fulfill({ status: 503, json: { message: "UNCONFIGURED_BROWSER_FIXTURE" } });
		}
		return route.continue();
	});
	return {
		intents,
		uploads,
		preparations,
		completions,
		handoffs,
		submissions,
		navigations,
		events,
		unexpectedMutations,
		releasePreparation: (session: number) => gates.get(session)?.resolve(),
		releaseAll: () => {
			for (const gate of gates.values()) gate.resolve();
		},
	};
}

async function openComposer(page: Page, pathname = "/create") {
	await page.goto(`${pathname}?mode=image&model=${PRODUCT_KEY}`);
	await expect(page.locator('[data-test="landing-model-trigger"]')).toContainText(
		"Nano Banana 2 Lite",
	);
	await expect(page.locator('[data-test="landing-stage"]')).toHaveAttribute("data-stage", "ready");
}

async function expectInlineResult(
	page: Page,
	fixture: Awaited<ReturnType<typeof installGuestBoundaries>>,
	pathname: string,
) {
	await expect(
		page.locator('[data-test="landing-guest-trial"] #guest-result-region img'),
	).toBeVisible();
	expect(new URL(page.url()).pathname).toBe(pathname);
	expect(fixture.navigations.every((path) => path === pathname)).toBe(true);
	expect(fixture.submissions).toHaveLength(1);
	expect(fixture.submissions[0]?.prompt).toBe(fixture.completions.at(-1)?.prompt);
	await expect(page.getByRole("button", { name: "Start my image edit" })).toHaveCount(0);
	await test.info().attach(`inline-guest-${pathname === "/" ? "home" : "create"}`, {
		body: await page.locator('[data-test="landing-guest-trial"]').screenshot(),
		contentType: "image/png",
	});
}

function pngFile(name: string) {
	return { name, mimeType: "image/png", buffer: Buffer.from(ONE_PIXEL_PNG, "base64") };
}

async function coloredPng(page: Page, name: string) {
	const base64 = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 2;
		canvas.height = 2;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("BROWSER_CANVAS_REQUIRED");
		context.fillStyle = "#3165cd";
		context.fillRect(0, 0, 2, 2);
		return canvas.toDataURL("image/png").split(",")[1]!;
	});
	return { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

function hash(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}

function completionToken(session: number) {
	return String(session).padStart(43, "c");
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

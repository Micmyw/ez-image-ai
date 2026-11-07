import assert from "node:assert/strict";
import path from "node:path";

export async function runEffectScenarios({ page, expect, origin, png, messages, directory }) {
	await page.clock.install();
	await page.addInitScript(() => {
		const calls = { access: 0, previews: [], quotes: [], creates: [], uploads: 0 };
		const pending = {};
		window.fixture = {
			calls,
			pending,
			changedPrice: null,
			failCreate: false,
			failPreview: sessionStorage.getItem("fixture-fail-preview") === "true",
		};
		window.fixture.api = {
			access: async () => {
				calls.access++;
				return {
					available: true,
					accessAllowed: true,
					maxInputBytes: 10000000,
					reasons: [],
					credits: "92",
					durationOptions: [
						{ duration: 5, credits: "92" },
						{ duration: 10, credits: "178" },
					],
					pricingValidUntil: new Date(Date.now() + 30000).toISOString(),
					creditBalance: { eligibleCredits: "0", totalCredits: "0" },
				};
			},
			uploads: {
				create: async () => {
					const sessionId = `session-${++calls.uploads}`;
					return { sessionId, uploadUrl: `/upload/${sessionId}` };
				},
				complete: ({ sessionId }) =>
					new Promise((resolve) => {
						pending[sessionId] = () => resolve({ assetId: `photo-${sessionId}` });
					}),
			},
			inputs: {
				get: async ({ assetId }) => {
					calls.previews.push(assetId);
					if (window.fixture.failPreview) throw new Error("NETWORK_UNKNOWN");
					return {
						assetId,
						previewUrl: "/photo.png",
						previewExpiresAt: new Date(Date.now() + 300000).toISOString(),
					};
				},
			},
			quote: async (request) => {
				calls.quotes.push(request);
				return {
					quoteId: "fixture-quote",
					credits: window.fixture.changedPrice ?? (request.duration === 10 ? "178" : "92"),
					expiresAt: new Date(Date.now() + 600000).toISOString(),
				};
			},
			jobs: {
				create: async (input) => {
					calls.creates.push(input);
					if (window.fixture.failCreate) throw new Error("NETWORK_UNKNOWN");
					return { jobId: "fixture-job" };
				},
			},
		};
	});
	await page.goto(origin);
	await expect(page.locator(".ve-price strong")).toHaveText("92 credits");
	await page.getByRole("button", { name: "10 seconds 178 credits" }).click();
	await expect(page.locator(".ve-price strong")).toHaveText("178 credits");
	await page.getByRole("button", { name: "5 seconds 92 credits" }).click();
	assert.deepEqual(
		await page.evaluate(() => [window.fixture.calls.access, window.fixture.calls.quotes.length]),
		[1, 0],
	);
	const upload = (index) =>
		page
			.locator('input[type="file"]')
			.nth(index)
			.setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
	await upload(0);
	await expect(page.locator(".ve-upload img").first()).toHaveAttribute("src", /^blob:/);
	await expect(page.locator('input[type="file"]').nth(1)).toBeEnabled();
	await upload(1);
	await page.waitForFunction(() => Object.keys(window.fixture.pending).length === 2);
	await page.evaluate(() => Object.values(window.fixture.pending).forEach((resolve) => resolve()));
	await expect(page.getByRole("button", { name: "Generate video · 92 credits" })).toBeEnabled();
	assert.equal(await page.locator('.ve-upload img[src^="blob:"]').count(), 2);
	assert.equal(await page.evaluate(() => window.fixture.calls.previews.length), 0);
	// Invalid replacement must preserve the previous sealed photo.
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles({ name: "bad.gif", mimeType: "image/gif", buffer: png });
	assert.equal(await page.locator('.ve-upload img[src^="blob:"]').count(), 2);
	await page.getByRole("button", { name: "Generate video · 92 credits" }).click();
	await expect(page.getByText("Fixture job accepted")).toBeVisible();
	assert.deepEqual(
		await page.evaluate(() => [
			window.fixture.calls.quotes.length,
			window.fixture.calls.creates.length,
		]),
		[1, 1],
	);
	// Restored metadata survives transient preview failures and can retry without an upload.
	await page.evaluate(() => sessionStorage.setItem("fixture-fail-preview", "true"));
	await page.reload();
	await expect(page.getByRole("button", { name: messages.retryPreview })).toHaveCount(2);
	assert.ok(
		await page.evaluate(
			() =>
				JSON.parse(sessionStorage.getItem("ezpic.video-effect.v1:raindance-duo:fixture-owner"))
					.leftAssetId,
		),
	);
	await page.evaluate(() => {
		window.fixture.failPreview = false;
		sessionStorage.removeItem("fixture-fail-preview");
	});
	await page.getByRole("button", { name: messages.retryPreview }).first().click();
	await page.getByRole("button", { name: messages.retryPreview }).first().click();
	await expect(page.locator(".ve-upload img")).toHaveCount(2);
	await page.getByRole("button", { name: messages.newVideo }).click();
	const beforeIdle = await page.evaluate(() => [
		window.fixture.calls.access,
		window.fixture.calls.previews.length,
	]);
	await page.clock.fastForward(6 * 60_000);
	assert.deepEqual(
		await page.evaluate(() => [window.fixture.calls.access, window.fixture.calls.previews.length]),
		beforeIdle,
	);
	await page.screenshot({ path: path.join(directory, "ready.png"), fullPage: true });
	await page.evaluate(() => {
		window.fixture.changedPrice = "150";
		window.fixture.failCreate = true;
	});
	await page.getByRole("button", { name: "Generate video · 92 credits" }).click();
	await expect(page.locator("#ve-price-change")).toContainText("150");
	assert.equal(await page.evaluate(() => window.fixture.calls.creates.length), 0);
	await page.getByRole("button", { name: /Confirm.*150/ }).click();
	await expect(page.getByRole("button", { name: messages.recover })).toBeEnabled();
	assert.equal(await page.evaluate(() => window.fixture.calls.quotes.length), 1);
	const key = await page.evaluate(() => window.fixture.calls.creates[0].idempotencyKey);
	await page.reload();
	await page.getByRole("button", { name: messages.recover }).click();
	await expect(page.getByText("Fixture job accepted")).toBeVisible();
	assert.equal(await page.evaluate(() => window.fixture.calls.creates[0].idempotencyKey), key);
	assert.equal(await page.evaluate(() => window.fixture.calls.quotes.length), 0);
	await page.getByRole("button", { name: messages.raindance.solo }).click();
	await expect(page.locator('input[type="file"]')).toHaveCount(1);
	await page.getByRole("button", { name: messages.raindance.duo }).click();
	await expect(page.locator('input[type="file"]')).toHaveCount(2);
	assert.equal(await page.evaluate(() => window.fixture.calls.access), 3); // initial duo, accepted refresh, first solo
	return [
		"local duration price switch",
		"parallel upload and local thumbnails",
		"invalid replacement preserves photo",
		"stale balance does not block admission",
		"transient preview failure preserves draft",
		"no access or still-preview polling after six idle minutes",
		"changed price reuses quote",
		"same-key recovery",
		"cached Solo/Duet return",
	];
}

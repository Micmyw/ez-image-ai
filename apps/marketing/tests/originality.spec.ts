import { expect, test } from "@playwright/test";

const forbiddenPublicArtifactPattern =
	/raphael(?:\.app)?|seedream|providerModelId|providerCostMicros|providerTaskId|fal-ai|replicate\.com/i;

test("built public marketing resources use only EzPic expression and owned media", async ({
	page,
}) => {
	const responses: Array<{ url: string; body: string }> = [];
	page.on("response", async (response) => {
		const type = response.request().resourceType();
		if (!["document", "script", "stylesheet"].includes(type) || response.status() >= 400) return;
		try {
			responses.push({ url: response.url(), body: await response.text() });
		} catch {
			// Redirected or opaque resources have no readable public body to inspect.
		}
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

	for (const resource of responses) {
		expect(resource.url, resource.url).not.toMatch(forbiddenPublicArtifactPattern);
		expect(resource.body, resource.url).not.toMatch(forbiddenPublicArtifactPattern);
	}
	await assertOwnedMedia(page);
});

async function assertOwnedMedia(page: import("@playwright/test").Page): Promise<void> {
	const origin = new URL(page.url()).origin;
	const mediaUrls = await page
		.locator("img[src], source[src], video[src], video[poster]")
		.evaluateAll((elements) =>
			elements.flatMap((element) =>
				["src", "poster"]
					.map((attribute) => element.getAttribute(attribute))
					.filter((value): value is string => Boolean(value)),
			),
		);
	for (const value of mediaUrls) {
		const url = new URL(value, origin);
		expect(["data:", "blob:"].includes(url.protocol) || url.origin === origin, value).toBe(true);
	}
}

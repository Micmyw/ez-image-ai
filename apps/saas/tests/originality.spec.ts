import { expect, test } from "@playwright/test";

const forbiddenPublicArtifactPattern =
	/raphael(?:\.app)?|providerModelId|providerCostMicros|providerTaskId|KIE_API_KEY|OPENROUTER_API_KEY|api\.kie\.ai|openrouter(?:\.ai)?|gpt-image-2-image-to-image|seedream\/5-pro-image-to-image|fal-ai|replicate\.com/i;

test("public SaaS shell resources contain no competitor or internal route expression", async ({
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

	await page.goto("/try");
	await expect(page.getByRole("heading")).toBeVisible();
	for (const resource of responses) {
		expect(resource.url, resource.url).not.toMatch(forbiddenPublicArtifactPattern);
		expect(resource.body, resource.url).not.toMatch(forbiddenPublicArtifactPattern);
	}
});

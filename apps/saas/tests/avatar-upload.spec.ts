import { expect, test } from "@playwright/test";

import { E2E_PNG } from "../../../tooling/e2e/src/fixtures";

test("crops an avatar and uploads the exact signed PNG before updating the profile", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.goto("/settings/general");
	await page
		.locator('input[type="file"]')
		.setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: E2E_PNG });
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("cropper-selection")).toBeVisible();
	const putResponse = page.waitForResponse((response) => response.request().method() === "PUT");
	const profileResponse = page.waitForResponse((response) =>
		response.url().includes("/api/auth/update-user"),
	);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	const upload = await putResponse;
	expect(upload.ok()).toBe(true);
	expect(upload.request().headers()["content-type"]).toBe("image/png");
	const signedHeaders = new URL(upload.url()).searchParams.get("X-Amz-SignedHeaders");
	expect(signedHeaders).toContain("content-length");
	expect(signedHeaders).toContain("content-type");
	expect((await profileResponse).ok()).toBe(true);
	await expect(dialog).not.toBeVisible();
	await page.reload();
	await expect(page.locator('input[type="file"]')).toBeAttached();
});

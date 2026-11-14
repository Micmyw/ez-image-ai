import { expect, test } from "@playwright/test";

test.describe("login page", () => {
	test("should load and show all relevant login form components", async ({ page }) => {
		await page.goto("/login");

		// Main heading and subtitle
		await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
		await expect(page.getByText("Please enter your credentials to sign in.")).toBeVisible();

		// Login mode switch (Magic link / Password)
		await expect(page.getByRole("tab", { name: "Magic link" })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Password" })).toBeVisible();

		// Email field
		await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
		await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
		const googleBox = await page
			.getByRole("button", { name: "Continue with Google" })
			.boundingBox();
		const emailBox = await page.getByRole("textbox", { name: /email/i }).boundingBox();
		expect(googleBox!.y).toBeLessThan(emailBox!.y);

		// Switch to password mode so password-specific UI is visible
		await page.getByRole("tab", { name: "Password" }).click();

		// Password field and forgot password link
		const passwordInput = page.locator('input[autocomplete="current-password"]');
		await expect(passwordInput).toBeVisible();
		await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();

		// Submit button (password mode)
		await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

		// "Or continue with" divider
		await expect(page.getByText("Or continue with")).toBeVisible();

		// Passkey button
		await expect(page.getByRole("button", { name: "Login with passkey" })).toBeVisible();

		// Sign up link
		await expect(page.getByRole("link", { name: /Create an account/ })).toBeVisible();
		await expect(page.getByText("Don't have an account yet?")).toBeVisible();
	});

	test("should switch between magic link and password auth modes", async ({ page }) => {
		await page.goto("/login");

		const passwordInput = page.locator('input[autocomplete="current-password"]');

		// Ensure password mode: click Password tab then assert
		await page.getByRole("tab", { name: "Password" }).click();
		await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
		await expect(passwordInput).toBeVisible();

		// Switch to magic link mode
		await page.getByRole("tab", { name: "Magic link" }).click();
		await expect(page.getByRole("button", { name: "Send magic link" })).toBeVisible();
		await expect(passwordInput).toBeHidden();

		// Switch back to password mode
		await page.getByRole("tab", { name: "Password" }).click();
		await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
		await expect(passwordInput).toBeVisible();
	});

	test("keeps the real local draft visible on login and after a cancelled callback", async ({
		page,
	}) => {
		await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
		await page.goto("/login");
		const draftId = "10000000-0000-4000-8000-000000000001";
		await page.evaluate(async (id) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open("ezpic-auth-drafts", 1);
				request.onupgradeneeded = () =>
					request.result.createObjectStore("drafts", { keyPath: "id" });
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const bytes = Uint8Array.from(
					atob(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aob8AAAAASUVORK5CYII=",
					),
					(character) => character.charCodeAt(0),
				);
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction("drafts", "readwrite");
					transaction.objectStore("drafts").put({
						version: 1,
						id,
						savedAt: Date.now(),
						file: new File([bytes], "local-draft.png", { type: "image/png" }),
						returnPath: "/create",
						originPath: "/",
						sourceOwnerId: null,
						boundOwnerId: null,
						parentJobId: null,
						values: {
							productKey: "image-nano-banana-2-lite",
							skuKey: "nano-banana-2-lite-1k",
							prompt: "Keep my image and this exact prompt",
							sourceAssetId: "",
							aspectRatio: "16:9",
							outputFormat: "png",
						},
					});
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
				});
			} finally {
				database.close();
			}
		}, draftId);
		const redirectTo = `/create?authDraft=${draftId}`;
		await page.goto(`/login?${new URLSearchParams({ redirectTo, authError: "cancelled" })}`);
		const preview = page.locator('[data-auth-draft="saved"]');
		await expect(preview).toBeVisible();
		await expect(preview.getByRole("img")).toBeVisible();
		await expect(preview).toContainText("Keep my image and this exact prompt");
		await expect(preview.getByRole("link")).toHaveAttribute("href", `/?authDraft=${draftId}`);
		await page.reload();
		await expect(preview).toBeVisible();
	});
});

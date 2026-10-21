import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
	createAdminCapabilitiesFixture,
	loginAdminCapabilities,
} from "./helpers/admin-capabilities";
import { verifyAdminProtocols } from "./helpers/admin-protocols";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("administrator capabilities on an isolated local database", () => {
	test.skip(
		process.env.E2E_ADMIN_CAPABILITIES !== "true",
		"Opt in with E2E_ADMIN_CAPABILITIES=true and the matching local test database.",
	);
	test.describe.configure({ timeout: 180_000 });

	test("renders all five admin pages and excludes ordinary customers", async ({
		page,
		browser,
		baseURL,
	}, testInfo) => {
		const fixture = await createAdminCapabilitiesFixture(baseURL!);
		const customerContext = await browser.newContext({
			baseURL,
			storageState: { cookies: [], origins: [] },
		});
		try {
			await loginAdminCapabilities(page, fixture.admin, "/admin/analytics");
			for (const [route, heading] of [
				["analytics", "业务统计"],
				["payments", "Payments and refunds"],
				["notifications", "Payment and support notifications"],
				["support", "Support inbox"],
				["agent", "Agent API and access"],
			]) {
				await page.locator(`a[href="/admin/${route}"]`).first().click();
				await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
				await expect(page.getByText(/^(?:Loading|正在加载)(?:\.{3}|…)$/)).toHaveCount(0);
				if (route === "analytics") {
					await expect(page.locator("dt").filter({ hasText: /^注册用户$/ })).toBeVisible();
					const recentUsers = page
						.locator("dt")
						.filter({ hasText: /^近 24 小时新增用户$/ })
						.locator("..")
						.locator("dd");
					// Both unique fixture identities were registered just before signing in.
					expect(Number(await recentUsers.innerText())).toBeGreaterThanOrEqual(2);
				}
				await expect(
					page.getByText(/The request could not be completed\.|请求未能完成。/),
				).toHaveCount(0);
				await testInfo.attach(`admin-${route}`, {
					body: await page.screenshot({ fullPage: true }),
					contentType: "image/png",
				});
			}
			const customerPage = await customerContext.newPage();
			await loginAdminCapabilities(customerPage, fixture.customer, "/settings/support");
			await customerPage.goto("/admin/analytics");
			await expect(customerPage).not.toHaveURL(/\/admin(?:\/|$)/, { timeout: 30_000 });
			await expect(
				customerPage.getByRole("heading", { name: "业务统计", exact: true }),
			).toHaveCount(0);
		} finally {
			await customerContext.close();
			await page.context().clearCookies();
			await fixture.cleanup();
		}
	});

	test("creates an owned ticket and shows the administrator reply to the customer", async ({
		page,
		browser,
		baseURL,
	}, testInfo) => {
		const fixture = await createAdminCapabilitiesFixture(baseURL!);
		const adminContext = await browser.newContext({
			baseURL,
			storageState: { cookies: [], origins: [] },
		});
		try {
			const subject = `Local support test ${randomUUID()}`;
			const body = "Please check the status of my local test order.";
			const reply = "This is a local support reply; no payment was processed.";
			await loginAdminCapabilities(page, fixture.customer, "/settings/support");
			await page.getByLabel("Subject", { exact: true }).fill(subject);
			await page.getByLabel("Message", { exact: true }).fill(body);
			await page.getByRole("button", { name: "Create ticket", exact: true }).click();
			await expect(page.getByText("Your ticket was created.", { exact: true })).toBeVisible();
			await expect(page.getByRole("heading", { name: subject, exact: true })).toBeVisible();
			await expect(page.getByText(body, { exact: true })).toBeVisible();

			const ticketId = await fixture.ticketId(subject);
			const adminPage = await adminContext.newPage();
			await loginAdminCapabilities(adminPage, fixture.admin, "/admin/analytics");
			await adminPage.goto(`/admin/support?ticketId=${encodeURIComponent(ticketId)}`);
			await expect(adminPage.getByRole("heading", { name: subject, exact: true })).toBeVisible();
			await adminPage.getByLabel("Reply to customer", { exact: true }).fill(reply);
			await adminPage.getByRole("button", { name: "Send reply", exact: true }).click();
			await expect(adminPage.getByText(reply, { exact: true })).toBeVisible();

			await page.getByRole("button", { name: "Refresh", exact: true }).last().click();
			await expect(page.getByText(reply, { exact: true })).toBeVisible();
			await expect(page.getByText("Support team", { exact: true })).toBeVisible();
			await testInfo.attach("customer-support-reply", {
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			});
		} finally {
			await adminContext.close();
			await page.context().clearCookies();
			await fixture.cleanup();
		}
	});

	test("records a credit grant and issues a scoped one-time key that can be revoked", async ({
		page,
		baseURL,
	}, testInfo) => {
		const fixture = await createAdminCapabilitiesFixture(baseURL!);
		try {
			await loginAdminCapabilities(page, fixture.admin, "/admin/analytics");
			await page.goto("/admin/payments");
			await page.getByLabel("Owner ID", { exact: true }).fill(fixture.customer.id);
			await page.getByLabel("Credits", { exact: true }).fill("25");
			await page
				.getByLabel("Reason", { exact: true })
				.fill("Isolated browser verification credit grant");
			await page
				.getByRole("checkbox", {
					name: `Confirm: Grant 25 credits for ${fixture.customer.id}.`,
					exact: true,
				})
				.check();
			await page.getByRole("button", { name: "Apply credit adjustment", exact: true }).click();
			await expect(page.getByText("Available credits: 25", { exact: false })).toBeVisible();
			expect(await fixture.credits()).toEqual({ spendable: "25", entries: 1 });
			await testInfo.attach("admin-credit-grant", {
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			});

			await page.goto("/admin/agent");
			const accountName = `Local scoped agent ${randomUUID()}`;
			await page.getByRole("button", { name: "Create service account", exact: true }).click();
			let dialog = page.getByRole("dialog");
			await dialog.getByLabel("Account name", { exact: true }).fill(accountName);
			await dialog.getByLabel("User or organization ID", { exact: true }).fill(fixture.customer.id);
			await dialog.getByRole("checkbox", { name: "admin.tickets.read", exact: true }).check();
			await dialog.getByRole("button", { name: "保存", exact: true }).click();
			await expect(dialog).toHaveCount(0);
			const article = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: accountName, exact: true }) });
			await expect(article).toBeVisible();
			expect(await fixture.serviceAccount(accountName)).toMatchObject({
				scope: { kind: "user", userId: fixture.customer.id },
				permissions: ["admin.tickets.read"],
			});

			await article.getByRole("button", { name: "Issue key", exact: true }).click();
			dialog = page.getByRole("dialog");
			await dialog.getByLabel("Key name", { exact: true }).fill("Local browser key");
			await dialog
				.getByLabel("Expires at", { exact: true })
				.fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
			await dialog.getByRole("button", { name: "Issue key", exact: true }).click();
			await expect(
				dialog.getByText("Copy this token now. After closing, it cannot be displayed again.", {
					exact: true,
				}),
			).toBeVisible();
			const token = await dialog.locator("code").innerText();
			expect(/^ez_admin_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
			const storedInBrowser = await page.evaluate(
				(secret) => Object.values(localStorage).some((value) => value.includes(secret)),
				token,
			);
			expect(storedInBrowser).toBe(false);
			// Do not capture a screenshot or attach the one-time test credential.
			await dialog.getByRole("button", { name: "I stored the key — close", exact: true }).click();
			await verifyAdminProtocols(baseURL!, token);
			await page.reload();
			await expect(article).toBeVisible();
			expect((await page.locator("body").innerText()).includes(token)).toBe(false);
			await article.getByRole("button", { name: "Revoke key", exact: true }).click();
			await page
				.getByRole("dialog")
				.getByRole("button", { name: "Revoke key", exact: true })
				.click();
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(article.getByText("Revoked", { exact: true })).toBeVisible();
			expect((await fixture.serviceAccount(accountName)).keys).toEqual([
				{ name: "Local browser key", revoked: true },
			]);
			const revokedResponse = await fetch(new URL("/api/admin/agent/operations", baseURL), {
				headers: { Authorization: `Bearer ${token}` },
				redirect: "error",
			});
			expect(revokedResponse.status).toBe(401);
			await testInfo.attach("admin-revoked-key", {
				body: await page.screenshot({ fullPage: true }),
				contentType: "image/png",
			});
		} finally {
			await page.context().clearCookies();
			await fixture.cleanup();
		}
	});
});

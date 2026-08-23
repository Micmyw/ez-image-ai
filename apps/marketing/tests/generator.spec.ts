import { expect, test } from "@playwright/test";
import pg from "pg";

const runId = process.env.E2E_RUN_ID;
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

test("generator sits between the hero and feature proof", async ({ page }) => {
	await page.goto("/");
	const generator = page.getByRole("heading", { name: /start with the thought/i });
	await expect(generator).toBeVisible();
	await expect(page.locator("section#features")).toBeVisible();
	const order = await page
		.locator("h1, #generator-title, section#features h2")
		.evaluateAll((nodes) => nodes.map((node) => node.id || node.tagName));
	expect(order.indexOf("generator-title")).toBeGreaterThan(0);
});

test("draft handoff posts to SaaS and redirects without prompt data", async ({ page }) => {
	if (process.env.E2E_DRAFT_HANDOFF !== "true" || !runId) {
		throw new Error(
			"E2E_DRAFT_HANDOFF=true and E2E_RUN_ID are required; this scenario never skips",
		);
	}
	const prompt = `[e2e:draft] [run:${runId}] A private launch concept`;
	let claimToken = "";
	page.on("request", (request) => {
		if (request.url().endsWith("/draft/continue") && request.method() === "POST") {
			claimToken = new URLSearchParams(request.postData() ?? "").get("claimToken") ?? "";
		}
	});
	await page.goto("/");
	await page.getByLabel(/describe your idea/i).fill(prompt);
	await page.getByRole("button", { name: /continue/i }).click();
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
	const replay = await page.request.post("http://localhost:3000/draft/continue", {
		headers: {
			Origin: "http://localhost:3001",
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

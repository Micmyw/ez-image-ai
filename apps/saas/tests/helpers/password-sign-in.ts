import { setTimeout as delay } from "node:timers/promises";

import type { Page } from "@playwright/test";

/** Keep real production auth limits; only honor one explicit, bounded server cooldown. */
export async function submitPasswordSignIn(
	page: Pick<Page, "waitForResponse" | "locator" | "url">,
	wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
	const origin = new URL(page.url()).origin;
	for (let attempt = 0; attempt < 2; attempt++) {
		const [response] = await Promise.all([
			page.waitForResponse(
				(candidate) => {
					const url = new URL(candidate.url());
					return (
						url.origin === origin &&
						url.pathname === "/api/auth/sign-in/email" &&
						candidate.request().method() === "POST"
					);
				},
				{ timeout: 15_000 },
			),
			page.locator('button[type="submit"]').click(),
		]);
		if (response.status() === 200) return;
		if (response.status() !== 429 || attempt > 0)
			throw new Error(`PASSWORD_SIGN_IN_HTTP_${response.status()}`);

		// Better Auth's sign-in rule is 3 requests per 10 seconds. Do not guess a
		// delay when the server provides no valid instruction or a different limit.
		const retryAfter = response.headers()["x-retry-after"];
		const seconds = Number(retryAfter);
		if (!retryAfter || !/^\d+(?:\.\d+)?$/.test(retryAfter) || seconds > 10)
			throw new Error("PASSWORD_SIGN_IN_INVALID_RETRY_AFTER");
		await wait(Math.ceil(seconds) * 1_000 + 100);
	}
}

import { FREE_ACCOUNT_SIGN_IN_CREDITS } from "@repo/config/client";
import { getBaseUrl } from "@shared/lib/base-url";
import { describe, expect, it } from "vitest";

import { getGuestMediaConfig } from "../../../../packages/config/guest-media";
import { MODEL_PAGES, modelPath } from "../../modules/models/lib/model-pages";
import { getAllPublishedBlogPosts } from "../../modules/public-content/lib/content";
import { buildLlmsText } from "./llms-text";
import { GET } from "./route";

describe("EzImageAI llms.txt", () => {
	it("publishes a plain-text product description with absolute links", async () => {
		const response = GET();
		const body = await response.text();
		const origin = getBaseUrl();
		const guest = getGuestMediaConfig({}, undefined);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(body).toBe(buildLlmsText());
		expect(body.startsWith("# EzImageAI\n")).toBe(true);
		expect(body).toContain("AI image editor");
		expect(body).toContain("flexible prompt editing");
		expect(body).toContain("中文：");
		expect(body).not.toMatch(/rap video|no restrictions|unrestricted|uncensored|unlimited/i);
		expect(body).not.toContain("/zh");
		expect(body).not.toContain("/refund");
		expect(body).not.toContain("/acceptable-use");
		expect(body).not.toContain("/report-abuse");
		expect(body).not.toContain("/blog/how-to-make-hotel-lobby-ai-video");

		expect(guest.maximumBytes).toBe(10 * 1024 * 1024);
		expect(guest.mimeTypes).toEqual(["image/jpeg", "image/png", "image/webp"]);
		expect(guest.retentionMs).toBe(24 * 60 * 60 * 1000);
		expect(guest.productKey).toBe("image-minimax-h3");
		expect(guest.skuKey).toBe("minimax-h3-1k");
		expect(body).toContain("JPEG, PNG, or WebP");
		expect(body).toContain("10 MB");
		expect(body).toContain("24 hours");
		expect(body).toContain("30-day");
		expect(body).toContain("Nano Banana 2 Lite 1K");
		expect(body).toContain(`${FREE_ACCOUNT_SIGN_IN_CREDITS} sign-in credits`);
		expect(body).toContain("Pro is $19 per month or $114 per year for 700 monthly credits");
		expect(body).toContain("Ultimate is $49 per month or $294 per year for 1,800 monthly credits");
		expect(body).toContain("Max is $79 per month or $474 per year for 3,000 monthly credits");
		expect(body).toContain("Free includes 0 monthly credits");

		for (const path of [
			"/",
			"/pricing",
			"/models",
			"/contact",
			"/privacy",
			"/terms",
			"/docs",
			"/blog",
		]) {
			expect(body).toContain(new URL(path, origin).href);
		}
		expect(body).toContain(new URL("/contact#report-content", origin).href);
		expect(body).toContain(new URL("/?lang=de", origin).href);
		expect(body).toContain(new URL("/?lang=es", origin).href);
		expect(body).toContain(new URL("/?lang=fr", origin).href);
		for (const model of MODEL_PAGES) {
			expect(body).toContain(model.name);
			expect(body).toContain(new URL(modelPath(model.key), origin).href);
		}
		const posts = getAllPublishedBlogPosts("en");
		expect(posts.length).toBeGreaterThan(0);
		for (const post of posts) {
			expect(post.published).toBe(true);
			expect(body).toContain(new URL(`/blog/${post.slug}`, origin).href);
		}
	});
});

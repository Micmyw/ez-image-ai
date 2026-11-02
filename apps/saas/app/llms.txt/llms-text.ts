import {
	FREE_ACCOUNT_SIGN_IN_CREDITS,
	PLAN_ENTITLEMENTS,
	type PlanEntitlement,
} from "@repo/config/client";
import { getBaseUrl } from "@shared/lib/base-url";

import { MODEL_PAGES, modelPath } from "../../modules/models/lib/model-pages";
import { getAllPublishedBlogPosts } from "../../modules/public-content/lib/content";

const PUBLIC_PLAN_NAMES = {
	free: "Free",
	creator: "Pro",
	ultimate: "Ultimate",
	studio: "Max",
} as const satisfies Record<PlanEntitlement["id"], string>;

const PUBLIC_PAGES = [
	[
		"/",
		"AI image editor for flexible prompt editing, optional reference images, and signed-in text-to-image.",
	],
	["/pricing", "Free, Pro, Ultimate, and Max plans, monthly credits, and upload limits."],
	["/models", "Image models available in the editor."],
	["/create", "Signed-in image editor."],
	["/image-to-image", "Edit an image from a reference and a prompt."],
	["/photo-to-coloring-page", "Turn a photo into a coloring page."],
	["/examples", "Example prompts and results."],
	["/effects", "Photo effect starting points."],
	["/blog", "Published articles."],
	["/changelog", "Product changes."],
	["/docs", "Product documentation."],
	["/contact", "Support for accounts, billing, and generation."],
	["/privacy", "Account media, guest trials, retention, and privacy choices."],
	[
		"/terms",
		"Service terms, acceptable use, and how refund requests are reviewed. There is no separate refund or acceptable-use URL.",
	],
	[
		"/contact#report-content",
		"Report prohibited content. Email support@ezimageai.com with the subject Content report.",
	],
] as const;

export function buildLlmsText(origin = getBaseUrl()): string {
	const free = plan("free");
	const paid = PLAN_ENTITLEMENTS.filter((entry) => entry.id !== "free");
	const posts = getAllPublishedBlogPosts("en");
	const models = MODEL_PAGES.map((model) => model.name).join(", ");
	const lines = [
		"# EzImageAI",
		"",
		"> EzImageAI is an AI image editor with a browser-based studio for flexible prompt editing, an optional reference image, and signed-in text-to-image.",
		"",
		"中文：AI 图片编辑器，支持灵活的提示词编辑、可选参考图片，以及登录后的文字生图。Deutsch、Español 和 Français 使用页面上的 ?lang= 参数。",
		"",
		"## Product facts",
		"",
		'- Product: EzImageAI edits and generates images from prompts. "No Restrictions" means flexible prompt editing. It is not an exemption from content safety, the law, model capabilities, or plan and usage limits.',
		`- Uploads: JPEG, PNG, or WebP. A reference image is optional. Guest trials accept up to ${megabytes(10 * 1024 * 1024)}. The Free plan accepts up to ${megabytes(free.maximumInputBytes)}. ${paidPlanNames()} accept up to ${paidUploadLimit(paid)}. Signed-in text-to-image does not require a source image. An uploaded reference must belong to the account.`,
		"- Guest trial: when the sponsored queue is available, a visitor can create a private, watermarked Nano Banana 2 Lite 1K result in a temporary anonymous session. The trial does not create a subscription or charge a payment. Guest trial media is scheduled for deletion no later than 24 hours after the trial job is created.",
		`- Credits and plans: eligible accounts receive ${FREE_ACCOUNT_SIGN_IN_CREDITS} sign-in credits. Free includes ${free.monthlyCredits} monthly credits and Nano Banana 2 Lite. ${paidPlanSummary(paid)} Current prices and the credit cost of a generation are shown on the pricing page and in the editor.`,
		`- Models: ${models}.`,
		"- Privacy: source images and results stay private to the account or temporary guest session. EzImageAI does not publish them in a public gallery. New references uploaded in the signed-in editor expire after 24 hours. Registered library media and generated outputs use a 30-day retention target. Failed-job cleanup is 7 days.",
		"- Safety: prompts are screened with Waffo. Source images and generated outputs are checked with SeeAPI. Prohibited content is not allowed.",
		"",
		"## Public pages",
		"",
		...PUBLIC_PAGES.map(
			([path, description]) => `- [${pageLabel(path)}](${absolute(origin, path)}): ${description}`,
		),
		...MODEL_PAGES.map(
			(model) =>
				`- [${model.name}](${absolute(origin, modelPath(model.key))}): ${model.family} image model.`,
		),
		`- [Deutsch](${absolute(origin, "/?lang=de")}): German homepage. Other translated pages use the same ?lang=de query.`,
		`- [Español](${absolute(origin, "/?lang=es")}): Spanish homepage.`,
		`- [Français](${absolute(origin, "/?lang=fr")}): French homepage.`,
		"",
		"## Published articles",
		"",
		...posts.map(
			(post) => `- [${post.title}](${absolute(origin, `/blog/${post.slug}`)}): ${post.description}`,
		),
		"",
	];
	return lines.join("\n");
}

function plan(id: PlanEntitlement["id"]): PlanEntitlement {
	const entitlement = PLAN_ENTITLEMENTS.find((entry) => entry.id === id);
	if (!entitlement) throw new Error(`Missing ${id} plan`);
	return entitlement;
}

function paidPlanNames(): string {
	const names = PLAN_ENTITLEMENTS.filter((entry) => entry.id !== "free").map(
		(entry) => PUBLIC_PLAN_NAMES[entry.id],
	);
	if (names.length < 2) return names.join("");
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function paidUploadLimit(plans: readonly PlanEntitlement[]): string {
	const limits = [...new Set(plans.map((entry) => entry.maximumInputBytes))];
	if (limits.length !== 1) {
		return plans
			.map((entry) => `${PUBLIC_PLAN_NAMES[entry.id]} ${megabytes(entry.maximumInputBytes)}`)
			.join(", ");
	}
	return megabytes(limits[0]!);
}

function paidPlanSummary(plans: readonly PlanEntitlement[]): string {
	const sentences = plans.map((entry) => {
		const monthly = price(entry, "month");
		const yearly = price(entry, "year");
		return `${PUBLIC_PLAN_NAMES[entry.id]} is ${monthly} or ${yearly} for ${entry.monthlyCredits.toLocaleString("en-US")} monthly credits`;
	});
	return `${sentences.join(". ")}.`;
}

function price(entry: PlanEntitlement, interval: "month" | "year"): string {
	const amount = entry.prices.find((candidate) => candidate.interval === interval);
	if (!amount || amount.currency !== "USD" || !Number.isInteger(amount.amount)) {
		throw new Error(`Missing USD ${interval} price for ${entry.id}`);
	}
	return `$${amount.amount} per ${interval === "month" ? "month" : "year"}`;
}

function megabytes(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	if (!Number.isInteger(megabytes))
		throw new Error(`Upload limit is not a whole number of megabytes: ${bytes}`);
	return `${megabytes} MB`;
}

function absolute(origin: string, path: string): string {
	return new URL(path, origin).href;
}

function pageLabel(path: string): string {
	switch (path) {
		case "/":
			return "AI image editor";
		case "/pricing":
			return "Pricing";
		case "/models":
			return "Image models";
		case "/create":
			return "Editor";
		case "/image-to-image":
			return "Image to image";
		case "/photo-to-coloring-page":
			return "Photo to coloring page";
		case "/examples":
			return "Examples";
		case "/effects":
			return "Photo effects";
		case "/blog":
			return "Blog";
		case "/changelog":
			return "Changelog";
		case "/docs":
			return "Documentation";
		case "/contact":
			return "Contact";
		case "/privacy":
			return "Privacy policy";
		case "/terms":
			return "Terms of service";
		case "/contact#report-content":
			return "Report content";
		default:
			return path;
	}
}

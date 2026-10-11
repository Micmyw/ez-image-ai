import type { BlogPost } from "../../modules/public-content/lib/blog-types";

export const tescoMealPlanningDocuments = [
	{
		id: "tesco-ai-meal-planning-assistant",
		slug: "tesco-ai-meal-planning-assistant",
		locale: "en",
		title: "Tesco AI Meal Planner: What the 2026 Rollout Confirms",
		description:
			"Tesco reports a wider AI meal planner rollout from September 2026. See the confirmed timeline, access unknowns and difference from Your Clubcard Prices.",
		publishedAt: "2026-10-11",
		articleType: "news",
		categoryId: "ai-news",
		tags: ["AI news", "Tesco", "meal planning", "Clubcard"],
		authorId: "ezimageai-editorial",
		relatedEffectIds: [],
		sources: [
			{
				title: "Tesco PLC — Interim Results 2026/27, published 8 October 2026",
				url: "https://www.tescoplc.com/interim-results-202627/",
				accessedAt: "2026-10-11",
			},
		],
		published: true,
		body: `Tesco's 8 October interim results confirm its AI meal planning assistant began a wider customer rollout in September 2026.

For shoppers looking for the new feature, the key question is whether their own account has access. A rollout announcement alone cannot answer that. This article separates the confirmed timeline from details we have not verified in a live Tesco account.

## What Tesco has confirmed

The rollout followed an employee trial:

- **April 2026:** an initial trial with approximately 280,000 Tesco employees.
- **September 2026:** the start of a wider customer rollout.

The interim statement does not specify full eligibility, the access path or a rollout completion date. It does not establish access for every Clubcard member.

## How to look for the assistant

**The current entry point is unverified here.** We have not tested the feature in a live Tesco account, so we cannot name a confirmed menu, button or invitation screen.

If you want to check access, start with the Tesco app or website you normally use. Look for Tesco's own announcements about meal planning and any eligibility guidance they link to. This is a way to look for current information, not a tested sequence of taps for opening the assistant.

If no entry appears, ask Tesco support whether your account is included and where the current entry point is. A missing button is not enough to identify the reason: without published eligibility guidance, it could reflect the rollout, the account or an interface change. Avoid repeatedly changing account settings based on unofficial screenshots.

## How it differs from Your Clubcard Prices

**Your Clubcard Prices** is a separate personalised-offer feature. Tesco reports it reached around 2.5 million customers; this is not a meal-assistant access count.

When checking a suggestion, compare its ingredient list with offers actually shown in your basket. Check access to the assistant separately from access to personalised prices.

## What to check before relying on a suggestion

Once you have access, try a small, ordinary planning task before building a full weekly shop around it. Decide what would make the output useful to you: a manageable preparation time, ingredients you already own or a short shopping list. Check the result against those requirements.

Review ingredient quantities, serving sizes and any requirements relevant to your household. Confirm product availability, pack sizes and the actual basket total before ordering. Treat a recipe idea and a checkout price as separate things to verify; a useful dinner suggestion can still be an expensive or impractical purchase.

We have not measured the assistant's recipe quality, speed or savings. There are no firsthand screenshots or performance results in this article. Those questions need real product testing, with the date and account context recorded, rather than conclusions drawn from a launch announcement.

## Source and future updates

Find the report in Sources below. Checked **11 October 2026**; report dated **8 October 2026**. Future updates will use Tesco guidance or a documented live test to revisit access and availability.

Browse [AI News](/blog?category=ai-news) for more reports, or return to the [EzImageAI Blog](/blog) for our image editing and prompt guides.`,
	},
] as const satisfies readonly BlogPost[];

import { z } from "zod";

import type { ModerationDecision, ModerationEvidence } from "./types";

export const SIGHTENGINE_TEXT_MODELS = ["general", "self-harm"];
export const SIGHTENGINE_IMAGE_MODELS = [
	"nudity-2.1",
	"weapon",
	"gore-2.0",
	"violence",
	"self-harm",
];

const score = z.number().min(0).max(1);
export const sightengineSuccessSchema = z
	.object({
		status: z.literal("success"),
		error: z.never().optional(),
	})
	.passthrough();
const requestSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
	operations: z.number().int().nonnegative(),
});
const textCategories = [
	"sexual",
	"discriminatory",
	"insulting",
	"violent",
	"toxic",
	"self-harm",
] as const;
const textSchema = sightengineSuccessSchema.extend({
	request: requestSchema,
	moderation_classes: z
		.object({
			available: z.array(z.string()).max(100),
			sexual: score,
			discriminatory: score,
			insulting: score,
			violent: score,
			toxic: score,
			"self-harm": score,
		})
		.refine((value) => textCategories.every((category) => value.available.includes(category))),
});
const imageSchema = sightengineSuccessSchema.extend({
	request: requestSchema,
	nudity: z.object({
		sexual_activity: score,
		sexual_display: score,
		erotica: score,
		very_suggestive: score,
		suggestive: score,
		mildly_suggestive: score,
		none: score,
	}),
	weapon: z.object({
		classes: z.object({ firearm: score, firearm_gesture: score, firearm_toy: score, knife: score }),
		firearm_action: z.object({ aiming_threat: score, aiming_camera: score }),
	}),
	gore: z.object({
		prob: score,
		classes: z.object({
			very_bloody: score,
			body_organ: score,
			serious_injury: score,
			corpse: score,
		}),
	}),
	violence: z.object({
		prob: score,
		classes: z.object({ physical_violence: score, firearm_threat: score, combat_sport: score }),
	}),
	"self-harm": z.object({ prob: score }),
});

interface CategoryRule {
	score: number;
	reasonCode: string;
	reviewOnly?: boolean;
}

// Thresholds are versioned application policy, not claims about provider accuracy.
// Review never grants access: existing quote/asset gates accept ALLOW only.
function evaluate(
	rules: CategoryRule[],
	ruleVersion: string,
	evidence: ModerationEvidence,
): ModerationDecision {
	const rejected = rules.find((rule) => !rule.reviewOnly && rule.score >= 0.85);
	if (rejected)
		return { decision: "REJECT", reasonCode: rejected.reasonCode, ruleVersion, evidence };
	const review = rules.find((rule) => rule.score >= 0.4);
	if (review) return { decision: "REVIEW", reasonCode: review.reasonCode, ruleVersion, evidence };
	return { decision: "ALLOW", reasonCode: "NO_POLICY_MATCH", ruleVersion, evidence };
}

export function assessSightengineText(response: unknown, ruleVersion: string): ModerationDecision {
	const data = textSchema.parse(response);
	const categories = data.moderation_classes;
	return evaluate(
		[
			{ score: categories.sexual, reasonCode: "SEXUAL_CONTENT" },
			{ score: categories.discriminatory, reasonCode: "HATE_CONTENT" },
			{ score: categories.violent, reasonCode: "VIOLENT_CONTENT" },
			{ score: categories["self-harm"], reasonCode: "SELF_HARM_CONTENT" },
			{
				score: Math.max(categories.insulting, categories.toxic),
				reasonCode: "ABUSIVE_CONTENT",
				reviewOnly: true,
			},
		],
		ruleVersion,
		{
			requestId: data.request.id,
			operations: data.request.operations,
			models: [...SIGHTENGINE_TEXT_MODELS],
			scores: Object.fromEntries(
				textCategories.map((category) => [category, categories[category]]),
			),
		},
	);
}

export function assessSightengineImage(response: unknown, ruleVersion: string): ModerationDecision {
	const data = imageSchema.parse(response);
	const scores: Record<string, number> = {};
	for (const [prefix, values] of [
		["nudity", data.nudity],
		["weapon.classes", data.weapon.classes],
		["weapon.firearm_action", data.weapon.firearm_action],
		["gore.classes", data.gore.classes],
		["violence.classes", data.violence.classes],
	] as const) {
		for (const [category, value] of Object.entries(values)) scores[`${prefix}.${category}`] = value;
	}
	scores["gore.prob"] = data.gore.prob;
	scores["violence.prob"] = data.violence.prob;
	scores["self-harm.prob"] = data["self-harm"].prob;
	return evaluate(
		[
			{
				score: Math.max(
					data.nudity.sexual_activity,
					data.nudity.sexual_display,
					data.nudity.erotica,
				),
				reasonCode: "SEXUAL_CONTENT",
			},
			{ score: Math.max(...Object.values(data.gore.classes)), reasonCode: "GRAPHIC_CONTENT" },
			{
				score: Math.max(
					data.violence.classes.physical_violence,
					data.violence.classes.firearm_threat,
				),
				reasonCode: "VIOLENT_CONTENT",
			},
			{ score: data.weapon.firearm_action.aiming_threat, reasonCode: "WEAPON_THREAT" },
			{ score: data["self-harm"].prob, reasonCode: "SELF_HARM_CONTENT" },
			{ score: data.nudity.very_suggestive, reasonCode: "SUGGESTIVE_CONTENT", reviewOnly: true },
			{
				score: Math.max(
					data.weapon.classes.firearm,
					data.weapon.classes.knife,
					data.weapon.firearm_action.aiming_camera,
				),
				reasonCode: "WEAPON_CONTENT",
				reviewOnly: true,
			},
			{ score: data.gore.prob, reasonCode: "GRAPHIC_CONTENT", reviewOnly: true },
			// Combat sports alone are not treated as harmful physical violence.
			{
				score: data.violence.classes.combat_sport < 0.4 ? data.violence.prob : 0,
				reasonCode: "VIOLENT_CONTENT",
				reviewOnly: true,
			},
		],
		ruleVersion,
		{
			requestId: data.request.id,
			operations: data.request.operations,
			models: [...SIGHTENGINE_IMAGE_MODELS],
			scores,
		},
	);
}

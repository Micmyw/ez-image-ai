import { config } from "../config";
import type { PlanPrice } from "../types";

export type PlanId = keyof typeof config.plans;
export type RecurringInterval = Extract<PlanPrice, { type: "subscription" }>["interval"];

export function isPlanId(planId: string): planId is PlanId {
	return Object.prototype.hasOwnProperty.call(config.plans, planId);
}

export function getPaidPlan(planId: PlanId) {
	const plan = config.plans[planId];

	if (!plan || !("prices" in plan)) {
		return null;
	}

	return plan;
}

export function findPriceByPlanId(
	planId: PlanId,
	selection: {
		type: PlanPrice["type"];
		interval?: RecurringInterval;
	},
) {
	const plan = getPaidPlan(planId);

	if (!plan) {
		return null;
	}

	return (
		plan.prices.find((price) => {
			if (price.type !== selection.type) {
				return false;
			}

			if (price.type === "subscription") {
				return price.interval === selection.interval;
			}

			return true;
		}) ?? null
	);
}

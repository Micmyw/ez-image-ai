import type { PlanId as ProductPlanId } from "@repo/config";

export type PlanId = Exclude<ProductPlanId, "free">;

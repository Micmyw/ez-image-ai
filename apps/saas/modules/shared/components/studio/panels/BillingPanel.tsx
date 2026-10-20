"use client";

import { useSession } from "@auth/hooks/use-session";
import { ActivePlan } from "@payments/components/ActivePlan";
import { ChangePlan } from "@payments/components/ChangePlan";
import { usePurchases } from "@payments/hooks/purchases";

export function BillingPanel() {
	const { user } = useSession();
	const { activePlan } = usePurchases();
	if (!user) return null;
	return (
		<div className="space-y-6 studio-billing-plans">
			<ActivePlan />
			<ChangePlan userId={user.id} activePlanId={activePlan?.id} />
		</div>
	);
}

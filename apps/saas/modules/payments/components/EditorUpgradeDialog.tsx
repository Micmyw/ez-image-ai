"use client";

import { getPlanEntitlement } from "@repo/config/client";
import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { useTranslations } from "next-intl";

export function EditorUpgradeDialog({
	open,
	onOpenChange,
	onContinue,
	storageUnavailable = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onContinue: () => void;
	storageUnavailable?: boolean;
}) {
	const t = useTranslations("media.upgradeDialog");
	const creator = planValues("creator");
	const studio = planValues("studio");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				<ul className="gap-2 text-sm grid">
					<li>{t("creator", creator)}</li>
					<li>{t("studio", studio)}</li>
				</ul>
				{storageUnavailable && (
					<p className="text-sm text-destructive" role="alert">
						{t("storageUnavailable")}
					</p>
				)}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						{t("cancel")}
					</Button>
					<Button type="button" variant="primary" onClick={onContinue}>
						{t("continue")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function planValues(planId: "creator" | "studio") {
	const entitlement = getPlanEntitlement(planId);
	return {
		credits: entitlement.monthlyCredits,
		concurrency: entitlement.maximumConcurrentJobs,
		megabytes: Math.round(entitlement.maximumInputBytes / 1024 / 1024),
	};
}

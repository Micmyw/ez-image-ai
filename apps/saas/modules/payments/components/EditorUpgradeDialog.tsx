"use client";

import { ImageModelIcon } from "@media/components/ImageModelIcon";
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
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function EditorUpgradeDialog({
	open,
	onOpenChange,
	onContinue,
	storageUnavailable = false,
	modelLabel,
	modelProductKey,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onContinue: () => void;
	storageUnavailable?: boolean;
	modelLabel?: string;
	modelProductKey?: string;
}) {
	const t = useTranslations("media.upgradeDialog");
	const creator = planValues("creator");
	const ultimate = planValues("ultimate");
	const studio = planValues("studio");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayProps={{
					className: "z-[90] bg-black/55 backdrop-blur-[2px]",
					"data-test": "editor-upgrade-backdrop",
				}}
				className="studio-theme gap-5 border-white/10 p-6 shadow-2xl z-[91] max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[#201827] text-[#f2ecfa]"
				style={{ width: "calc(100vw - 2rem)", maxWidth: "36rem" }}
			>
				<DialogHeader className="space-y-3 text-left">
					<span className="size-10 bg-white/5 text-violet-200 grid place-items-center rounded-xl">
						{modelProductKey ? (
							<ImageModelIcon productKey={modelProductKey} size={24} />
						) : (
							<SparklesIcon className="size-5" aria-hidden />
						)}
					</span>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription className="leading-6 text-[#bfb3cd]">
						{modelLabel ? t("modelDescription", { model: modelLabel }) : t("description")}
					</DialogDescription>
				</DialogHeader>
				<ul className="gap-2 text-sm sm:grid-cols-3 grid">
					{(
						[
							["creator", creator],
							["ultimate", ultimate],
							["studio", studio],
						] as const
					).map(([plan, values]) => (
						<li key={plan} className="border-white/10 bg-white/[0.035] p-3 rounded-xl border">
							<p className="font-semibold text-violet-200">{t(`planNames.${plan}`)}</p>
							<p className="mt-2 text-lg font-semibold sm:text-base tabular-nums">
								{t("monthlyCredits", values)}
							</p>
							<p className="mt-1 text-xs leading-5 text-[#bfb3cd]">{t("planDetails", values)}</p>
						</li>
					))}
				</ul>
				<p className="text-xs leading-5 text-[#bfb3cd]">{t("description")}</p>
				{storageUnavailable && (
					<p className="text-sm text-destructive" role="alert">
						{t("storageUnavailable")}
					</p>
				)}
				<DialogFooter className="gap-2 sm:space-x-0">
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

function planValues(planId: "creator" | "ultimate" | "studio") {
	const entitlement = getPlanEntitlement(planId);
	return {
		credits: entitlement.monthlyCredits,
		concurrency: entitlement.maximumConcurrentJobs,
		megabytes: Math.round(entitlement.maximumInputBytes / 1024 / 1024),
	};
}

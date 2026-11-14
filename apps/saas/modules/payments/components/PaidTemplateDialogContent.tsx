"use client";

import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
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

import "./paid-template-dialog.css";

export function PaidTemplateDialogContent({
	open,
	onOpenChange,
	onImagePass,
	onPlans,
	busy = false,
	storageUnavailable = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImagePass: () => void;
	onPlans: () => void;
	busy?: boolean;
	storageUnavailable?: boolean;
}) {
	const t = useTranslations("imagePass.paidTemplate");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayProps={{ className: "z-[90] bg-black/55 backdrop-blur-[2px]" }}
				className="studio-theme paid-template-dialog border-white/10 z-[91] max-h-[calc(100dvh-2rem)] overflow-y-auto bg-[#201827] text-[#f2ecfa]"
				data-test="paid-template-dialog"
			>
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription className="leading-6 text-[#bfb3cd]">
						{t("description")}
					</DialogDescription>
				</DialogHeader>
				<div className="border-amber-200/25 bg-amber-200/5 p-5 rounded-2xl border">
					<p className="text-3xl font-semibold">${IMAGE_PASS_OFFER_SUMMARY.amount}</p>
					<p className="mt-2 font-medium">
						{t("images", { count: IMAGE_PASS_OFFER_SUMMARY.units })}
					</p>
					<p className="mt-2 text-sm text-[#bfb3cd]">{t("oneTime")}</p>
				</div>
				{storageUnavailable && (
					<p role="alert" className="text-sm text-red-200">
						{t("storageUnavailable")}
					</p>
				)}
				<DialogFooter className="gap-2 sm:flex-col sm:space-x-0 flex-col">
					<Button
						type="button"
						variant="primary"
						size="lg"
						disabled={busy}
						onClick={onImagePass}
						data-test="paid-template-image-pass"
					>
						{t("buy", { amount: IMAGE_PASS_OFFER_SUMMARY.amount })}
					</Button>
					<Button type="button" size="lg" disabled={busy} variant="secondary" onClick={onPlans}>
						{t("plans")}
					</Button>
					<Button
						type="button"
						size="lg"
						disabled={busy}
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						{t("keepEditing")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

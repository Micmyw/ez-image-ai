"use client";

import { isEditorProductKey } from "@media/lib/editor-recovery";
import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
import { Button } from "@repo/ui/components/button";
import { trackGenerationJourney } from "@shared/lib/generation-journey";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { imagePassOfferQueryOptions } from "../lib/image-pass-offer-query";
import { currentImagePassOfferCoversSelection } from "../lib/selected-image-pass-offer";

export function SelectedImagePassOffer({
	productKey,
	skuKey,
	outputFormat,
	onContinue,
	disabled = false,
}: {
	productKey?: string;
	skuKey?: string;
	outputFormat?: string;
	onContinue: () => void;
	disabled?: boolean;
}) {
	if (!currentImagePassOfferCoversSelection({ productKey, skuKey, outputFormat })) return null;
	return (
		<AvailableImagePassOffer
			productKey={productKey!}
			skuKey={skuKey!}
			onContinue={onContinue}
			disabled={disabled}
		/>
	);
}

function AvailableImagePassOffer({
	productKey,
	skuKey,
	onContinue,
	disabled,
}: {
	productKey: string;
	skuKey: string;
	onContinue: () => void;
	disabled: boolean;
}) {
	const t = useTranslations("imagePass.selectedOffer");
	const offer = useQuery(imagePassOfferQueryOptions());
	const element = useRef<HTMLElement | null>(null);
	const available = Boolean(offer.data?.available && !offer.isError);
	useEffect(() => {
		const target = element.current;
		if (!available || !target || typeof IntersectionObserver === "undefined") return;
		let visible = false;
		const record = () => {
			if (
				!visible ||
				document.visibilityState !== "visible" ||
				!isEditorProductKey(productKey) ||
				!target.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })
			)
				return;
			void trackGenerationJourney(
				{ stage: "purchase_offer_viewed", publicModel: productKey },
				{ dedupeKey: `selected-image-pass:${productKey}:${skuKey}` },
			);
		};
		const observer = new IntersectionObserver(([entry]) => {
			visible = Boolean(entry?.isIntersecting);
			record();
		});
		observer.observe(target);
		document.addEventListener("visibilitychange", record);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", record);
		};
	}, [available, productKey, skuKey]);
	if (!offer.data?.available || offer.isError) return null;
	return (
		<aside
			ref={element}
			className="mt-3 space-y-2 border-violet-400/30 bg-violet-400/10 p-4 rounded-xl border"
			data-test="selected-image-pass-offer"
		>
			<p className="text-sm font-semibold">
				{t("title", {
					amount: IMAGE_PASS_OFFER_SUMMARY.amount,
					units: IMAGE_PASS_OFFER_SUMMARY.units,
				})}
			</p>
			<p className="text-xs leading-5 text-muted-foreground">{t("description")}</p>
			<Button type="button" variant="primary" onClick={onContinue} disabled={disabled}>
				{t("action")}
			</Button>
		</aside>
	);
}

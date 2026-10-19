"use client";

import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { imagePassOfferQueryOptions } from "../lib/image-pass-offer-query";

export function ImagePassBanner({ registered = false }: { registered?: boolean }) {
	const t = useTranslations("imagePass");
	const offer = IMAGE_PASS_OFFER_SUMMARY;
	const availability = useQuery(imagePassOfferQueryOptions());
	if (availability.isError || availability.isPending || availability.data?.available !== true)
		return null;
	return (
		<aside
			aria-label={t("bannerLabel")}
			className="border-violet-300/20 text-white border-b bg-[#271e39]"
			data-test="image-pass-banner"
		>
			<div className="gap-x-4 gap-y-2 py-3 text-sm container flex flex-wrap items-center justify-center text-center">
				<p>
					<strong className="font-semibold">
						{t("bannerTitle", {
							units: offer.units,
							amount: offer.amount,
							currency: offer.currency,
						})}
					</strong>
					<span className="ml-2 text-xs text-[#c9bdd9]">{t("bannerDetail")}</span>
				</p>
				<Link
					href={registered ? "/image-pass" : "/signup?redirectTo=%2Fimage-pass"}
					className="min-h-9 gap-1 bg-white px-3 text-xs font-semibold hover:bg-violet-100 focus-visible:outline-violet-200 inline-flex items-center rounded-lg text-[#34246f] focus-visible:outline-2 focus-visible:outline-offset-2"
				>
					{t("buy")}
					<span aria-hidden="true">↗</span>
				</Link>
			</div>
		</aside>
	);
}

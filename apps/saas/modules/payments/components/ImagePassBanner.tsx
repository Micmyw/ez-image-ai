"use client";

import { IMAGE_PASS_OFFER_SUMMARY } from "@repo/config/image-pass-summary";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

import { imagePassOfferQueryOptions } from "../lib/image-pass-offer-query";

import styles from "./ImagePassBanner.module.css";

const dismissalKey = `ezpic:image-pass-banner:${IMAGE_PASS_OFFER_SUMMARY.offerVersion}`;

export function ImagePassBanner({ registered = false }: { registered?: boolean }) {
	const t = useTranslations("imagePass");
	const offer = IMAGE_PASS_OFFER_SUMMARY;
	const [dismissed, setDismissed] = useState(false);
	const availability = useQuery(imagePassOfferQueryOptions());
	useEffect(() => {
		try {
			if (window.sessionStorage.getItem(dismissalKey) === "1") setDismissed(true);
		} catch {
			// Closing still works when optional browser storage is unavailable.
		}
	}, []);
	function dismissBanner() {
		setDismissed(true);
		try {
			window.sessionStorage.setItem(dismissalKey, "1");
		} catch {
			// Keep the in-memory choice for this mounted workspace.
		}
	}
	if (
		dismissed ||
		availability.isError ||
		availability.isPending ||
		availability.data?.available !== true
	)
		return null;
	return (
		<aside aria-label={t("bannerLabel")} className={styles.banner} data-test="image-pass-banner">
			<div className={`container ${styles.content}`}>
				<p className={styles.copy}>
					<strong className={styles.title}>
						{t("bannerTitle", {
							units: offer.units,
							amount: offer.amount,
						})}
					</strong>
					<span className={styles.detail}>{t("bannerDetail")}</span>
				</p>
				<Link
					href={registered ? "/image-pass" : "/signup?redirectTo=%2Fimage-pass"}
					className={styles.cta}
				>
					{t("buy")}
					<span aria-hidden="true">↗</span>
				</Link>
			</div>
			<button
				type="button"
				aria-label={t("dismissBanner")}
				className={styles.close}
				onClick={dismissBanner}
			>
				<XIcon size={14} strokeWidth={1.75} aria-hidden="true" />
			</button>
		</aside>
	);
}

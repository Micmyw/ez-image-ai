"use client";

import {
	PORTRAIT_PACK_CARDS,
	PORTRAIT_PACK_PATH,
	type PortraitCardKey,
	type PortraitPackPlacement,
} from "@repo/config/portrait-packs";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowUpRightIcon, DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { type CSSProperties, useRef, useState } from "react";

import { publicPagePath } from "../../public-content/lib/indexing";
import { usePortraitPackAnalytics } from "../lib/use-portrait-pack-analytics";
import { PackFoil } from "./PackFoil";

import styles from "./portrait-pack.module.css";

function portraitSrc(key: PortraitCardKey) {
	return `/images/portrait-packs/v1/${key}.webp`;
}

function portraitDimensions(key: PortraitCardKey) {
	return "fullLength" in PORTRAIT_PACK_CARDS[key]
		? { width: 340, height: 680, "data-full-length": true }
		: { width: 339, height: 510 };
}

export function PortraitPackExperience({
	compact = false,
	placement = "public-page",
}: {
	compact?: boolean;
	placement?: PortraitPackPlacement;
}) {
	const t = useTranslations("portraitPacks");
	const locale = useLocale();
	const path = publicPagePath(PORTRAIT_PACK_PATH, locale);
	const queryClient = useQueryClient();
	const accessOptions = orpc.portraitPacks.status.queryOptions({ retry: false, gcTime: 0 });
	const queryKey = accessOptions.queryKey;
	const access = useQuery(accessOptions);
	const opening = useMutation(orpc.portraitPacks.open.mutationOptions({ retry: false }));
	const requestId = useRef<string | null>(null);
	const inFlight = useRef(false);
	const dragOrigin = useRef<number | null>(null);
	const [reveal, setReveal] = useState<{ cards: PortraitCardKey[]; animate: boolean } | null>(null);
	const [selected, setSelected] = useState<PortraitCardKey | null>(null);
	const [openFailed, setOpenFailed] = useState(false);
	const [tearing, setTearing] = useState(false);
	const [preparingNext, setPreparingNext] = useState(false);
	const state = access.data?.state;
	const canOpen = state === "guestTrial" || state === "accountTrial" || state === "unlocked";
	const cards = reveal?.cards ?? (preparingNext && canOpen ? null : access.data?.cards);
	const analytics = usePortraitPackAnalytics(placement, "draw", canOpen && !cards && !tearing);

	async function openPack() {
		if (!canOpen || cards || inFlight.current) return;
		inFlight.current = true;
		analytics.clicked();
		setOpenFailed(false);
		setTearing(true);
		try {
			requestId.current ??= window.crypto.randomUUID();
			const result = await opening.mutateAsync({ requestId: requestId.current });
			if (result.opened && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
				await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
			}
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData(queryKey, {
				state: result.state,
				remaining: result.remaining,
				cards: result.state === "unlocked" ? null : result.cards,
			});
			setReveal({ cards: result.cards, animate: result.opened });
			setPreparingNext(false);
			requestId.current = null;
		} catch {
			// Retain the same request if the server committed but the response was lost.
			setOpenFailed(true);
		} finally {
			setTearing(false);
			inFlight.current = false;
		}
	}

	return (
		<section
			className={styles.experience}
			data-compact={compact || undefined}
			data-test="portrait-pack-experience"
		>
			<div
				className={styles.stage}
				data-revealed={Boolean(cards) || undefined}
				aria-busy={access.isPending || tearing}
			>
				{selected ? (
					<div className={styles.detail}>
						<img
							src={portraitSrc(selected)}
							{...portraitDimensions(selected)}
							alt={PORTRAIT_PACK_CARDS[selected].title}
						/>
						<div className={styles.detailActions}>
							<button type="button" className={styles.secondary} onClick={() => setSelected(null)}>
								<ArrowLeftIcon size={16} /> {t("backToCards")}
							</button>
							<a
								className={styles.primary}
								href={portraitSrc(selected)}
								download={`${selected}.webp`}
							>
								<DownloadIcon size={16} /> {t("saveImage")}
							</a>
						</div>
					</div>
				) : cards ? (
					<ul
						className={styles.cards}
						data-animate={reveal?.animate || undefined}
						data-test="portrait-pack-cards"
						aria-label={t("revealed")}
					>
						{cards.map((key, index) => {
							const card = PORTRAIT_PACK_CARDS[key];
							return (
								<li
									key={key}
									style={{ "--card-index": index, "--card-color": card.color } as CSSProperties}
								>
									<button
										className={styles.card}
										type="button"
										aria-label={card.title}
										onClick={() => setSelected(key)}
									>
										<img src={portraitSrc(key)} {...portraitDimensions(key)} alt="" />
										<span>{card.title}</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : (
					<button
						ref={analytics.ref}
						type="button"
						aria-label={t("open")}
						className={styles.packButton}
						disabled={!canOpen || tearing}
						onClick={() => void openPack()}
						onPointerDown={(event) => {
							if (event.button !== 0 || !event.isPrimary) return;
							dragOrigin.current = event.clientX;
							event.currentTarget.setPointerCapture(event.pointerId);
						}}
						onPointerMove={(event) => {
							if (dragOrigin.current === null) return;
							const width = event.currentTarget.getBoundingClientRect().width;
							if (Math.abs(event.clientX - dragOrigin.current) >= width * 0.55) {
								dragOrigin.current = null;
								void openPack();
							}
						}}
						onLostPointerCapture={() => {
							dragOrigin.current = null;
						}}
					>
						<PackFoil tearing={tearing} />
					</button>
				)}
			</div>
			<div className={styles.actions}>
				{access.isError && !access.data ? (
					<button type="button" className={styles.secondary} onClick={() => void access.refetch()}>
						{t("retryAccess")}
					</button>
				) : !state ? (
					<output className={styles.status}>
						<LoaderCircleIcon size={17} className="animate-spin" /> {t("checking")}
					</output>
				) : (
					<>
						{!cards && canOpen && (
							<button
								className={styles.primary}
								type="button"
								disabled={tearing}
								data-test="portrait-pack-open"
								onClick={() => void openPack()}
							>
								{tearing ? t("opening") : openFailed ? t("retryOpen") : t("open")}
							</button>
						)}
						{cards && canOpen && !selected && (
							<button
								className={styles.primary}
								type="button"
								onClick={() => {
									setReveal(null);
									setPreparingNext(true);
								}}
							>
								{t("another")}
							</button>
						)}
						{state === "guestUsed" && (
							<Link
								href={`/login?${new URLSearchParams({ redirectTo: path })}`}
								className={styles.primary}
							>
								{t("signIn")} <ArrowUpRightIcon size={16} />
							</Link>
						)}
						{state === "accountUsed" && (
							<Link href={publicPagePath("/pricing", locale)} className={styles.primary}>
								{t("plans")} <ArrowUpRightIcon size={16} />
							</Link>
						)}
						<output className={styles.status}>
							{t(`access.${state}`, { count: access.data?.remaining ?? 0 })}
						</output>
					</>
				)}
				{openFailed && (
					<p className={styles.status} role="alert">
						{t("openError")}
					</p>
				)}
			</div>
		</section>
	);
}

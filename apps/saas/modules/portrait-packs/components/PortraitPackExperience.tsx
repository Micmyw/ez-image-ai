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
import {
	type CSSProperties,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { publicPagePath } from "../../public-content/lib/indexing";
import { foilLight, sampleTear, type TearAxis } from "../lib/portrait-motion";
import { usePortraitPackAnalytics } from "../lib/use-portrait-pack-analytics";
import { PackFoil } from "./PackFoil";

import styles from "./portrait-pack.module.css";

const tearDuration = 490;
const sparkFlight = [
	[-44, -60],
	[-23, -69],
	[-57, 5],
	[-34, -20],
	[-10, -45],
	[18, -74],
	[38, -49],
	[53, -19],
	[40, 10],
	[12, -54],
];

function shine(event: PointerEvent<HTMLButtonElement>) {
	const element = event.currentTarget;
	const light = foilLight(event.clientX, event.clientY, element.getBoundingClientRect());
	element.style.setProperty("--foil-x", light.x);
	element.style.setProperty("--foil-y", light.y);
	element.style.setProperty("--tilt-x", light.tiltX);
	element.style.setProperty("--tilt-y", light.tiltY);
}

function resetShine(element: HTMLButtonElement) {
	for (const name of ["--foil-x", "--foil-y", "--tilt-x", "--tilt-y"])
		element.style.removeProperty(name);
}

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
	const packButton = useRef<HTMLButtonElement | null>(null);
	const fan = useRef<HTMLUListElement | null>(null);
	const focusFan = useRef(false);
	const focusPack = useRef(false);
	const ignoreClick = useRef(false);
	const drag = useRef<{ id: number; x: number; y: number; width: number; axis: TearAxis } | null>(
		null,
	);
	const [reveal, setReveal] = useState<{ cards: PortraitCardKey[]; animate: boolean } | null>(null);
	const [selected, setSelected] = useState<PortraitCardKey | null>(null);
	const [openFailed, setOpenFailed] = useState(false);
	const [tearing, setTearing] = useState(false);
	const [preparingNext, setPreparingNext] = useState(false);
	const state = access.data?.state;
	const canOpen = state === "guestTrial" || state === "accountTrial" || state === "unlocked";
	const cards = reveal?.cards ?? (preparingNext && canOpen ? null : access.data?.cards);
	const { ref: observePack, clicked: recordOpen } = usePortraitPackAnalytics(
		placement,
		"draw",
		canOpen && !cards && !tearing,
	);
	const setPackButton = useCallback(
		(element: HTMLButtonElement | null) => {
			packButton.current = element;
			observePack(element);
			if (element && focusPack.current) {
				element.focus({ preventScroll: true });
				focusPack.current = false;
			}
		},
		[observePack],
	);

	useEffect(() => {
		if (cards && !selected && focusFan.current) {
			fan.current?.querySelector("button")?.focus({ preventScroll: true });
			focusFan.current = false;
		}
	}, [cards, selected]);

	function resetTear() {
		packButton.current?.style.removeProperty("--tear-progress");
		packButton.current?.removeAttribute("data-reverse");
	}

	function finishDrag(event: PointerEvent<HTMLButtonElement>) {
		if (drag.current?.id !== event.pointerId) return;
		drag.current = null;
		if (!inFlight.current) resetTear();
	}

	async function openPack(keyboard = false) {
		if (!canOpen || cards || inFlight.current) return;
		inFlight.current = true;
		focusFan.current = keyboard;
		recordOpen();
		setOpenFailed(false);
		setTearing(true);
		packButton.current?.style.setProperty("--tear-progress", "1");
		const started = performance.now();
		try {
			requestId.current ??= window.crypto.randomUUID();
			const result = await opening.mutateAsync({ requestId: requestId.current });
			const animate =
				result.opened && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			const remaining = tearDuration - (performance.now() - started);
			if (animate && remaining > 0) {
				await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
			}
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData(queryKey, {
				state: result.state,
				remaining: result.remaining,
				cards: result.state === "unlocked" ? null : result.cards,
			});
			setReveal({ cards: result.cards, animate });
			setPreparingNext(false);
			requestId.current = null;
		} catch {
			// Retain the same request if the server committed but the response was lost.
			focusFan.current = false;
			resetTear();
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
					<div className={styles.gallery}>
						{reveal?.animate && (
							<span className={styles.sparks} aria-hidden="true">
								{sparkFlight.map(([x, y], index) => (
									<i
										key={x}
										style={
											{
												"--spark-x": `${x}cqw`,
												"--spark-y": `${y * 0.45}cqw`,
												"--spark-i": index,
											} as CSSProperties
										}
									/>
								))}
							</span>
						)}
						<ul
							ref={fan}
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
										data-featured={index === 2 || undefined}
										style={
											{ "--fan-position": index - 2, "--card-color": card.color } as CSSProperties
										}
									>
										<button
											className={styles.card}
											type="button"
											aria-label={card.title}
											onPointerDown={shine}
											onPointerMove={shine}
											onPointerLeave={(event) => resetShine(event.currentTarget)}
											onPointerCancel={(event) => resetShine(event.currentTarget)}
											onPointerUp={(event) => {
												if (event.pointerType !== "mouse") resetShine(event.currentTarget);
											}}
											onClick={() => {
												setReveal((current) => (current ? { ...current, animate: false } : null));
												setSelected(key);
											}}
										>
											<span className={styles.cardAngle}>
												<span className={styles.cardFace}>
													<img src={portraitSrc(key)} {...portraitDimensions(key)} alt="" />
													<span className={styles.cardSheen} aria-hidden="true" />
												</span>
											</span>
											<span className={styles.cardName} data-test="portrait-pack-card-label">
												{card.title}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>
				) : (
					<button
						ref={setPackButton}
						type="button"
						aria-label={t("open")}
						className={styles.packButton}
						disabled={!canOpen || tearing}
						data-test="portrait-pack-foil"
						data-tearing={tearing || undefined}
						onClick={(event) => {
							if (event.detail > 0 && ignoreClick.current) return;
							void openPack(event.detail === 0);
						}}
						onPointerDown={(event) => {
							if (event.button !== 0 || !event.isPrimary) return;
							ignoreClick.current = false;
							const { pointerId, clientX, clientY, currentTarget } = event;
							drag.current = {
								id: pointerId,
								x: clientX,
								y: clientY,
								width: currentTarget.getBoundingClientRect().width,
								axis: "pending",
							};
							currentTarget.setPointerCapture(pointerId);
						}}
						onPointerMove={(event) => {
							const active = drag.current;
							if (active?.id !== event.pointerId || inFlight.current) return;
							const sampled = sampleTear(
								active.axis,
								event.clientX - active.x,
								event.clientY - active.y,
								active.width,
							);
							active.axis = sampled.axis;
							if (sampled.axis !== "pending") ignoreClick.current = true;
							if (sampled.axis !== "horizontal") return;
							event.currentTarget.style.setProperty("--tear-progress", String(sampled.progress));
							event.currentTarget.toggleAttribute("data-reverse", sampled.reverse);
							if (sampled.complete) void openPack();
						}}
						onPointerUp={finishDrag}
						onPointerCancel={finishDrag}
						onLostPointerCapture={finishDrag}
					>
						<PackFoil />
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
								onClick={(event) => void openPack(event.detail === 0)}
							>
								{tearing ? t("opening") : openFailed ? t("retryOpen") : t("open")}
							</button>
						)}
						{cards && canOpen && !selected && (
							<button
								className={styles.primary}
								type="button"
								onClick={(event) => {
									focusPack.current = event.detail === 0;
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

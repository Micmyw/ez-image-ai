"use client";

import { useSession } from "@auth/hooks/use-session";
import { useUpgrade } from "@payments/components/upgrade-context";
import { defaultUpgradeSelection, upgradeHref } from "@payments/lib/upgrade-selection";
import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	type VideoEffectId,
} from "@repo/config/video-effects";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, FilmIcon, LockKeyholeIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { usePageVisible } from "../../video-v1/use-video";
import { recordVideoEffectEvent } from "../lib/analytics";
import { videoEffectsApi } from "../lib/api";
import type { PublicVideoEffectSample } from "../lib/content";
import {
	changeEffectInputs,
	createEffectConfirmation,
	effectError,
	effectReadinessMessage,
	effectRequest,
	effectStorageKey,
	emptyEffectDraft,
	readEffectDraft,
	swapEffectInputs,
	validEffectFile,
	VIDEO_EFFECT_MAX_BYTES,
	type EffectDraft,
	type EffectConfirmation,
	type EffectQuote,
	type EffectRole,
} from "../lib/model";
import { videoEffectPath, videoEffectReturnPath } from "../lib/paths";
import { saveVideoEffectPaymentReturn } from "../lib/payment-return";
import { DuoPhotoInputs, emptyPhotoSlot, type PhotoSlot } from "./DuoPhotoInputs";
import { VideoEffectJob } from "./VideoEffectJob";

export function VideoEffectGenerator({
	initialJobId,
	samples = [],
	effectId = HOTEL_LOBBY_EFFECT_ID,
	preview,
}: {
	initialJobId: string | null;
	samples?: readonly PublicVideoEffectSample[];
	effectId?: VideoEffectId;
	preview?: ReactNode;
}) {
	const t = useTranslations("videoEffects");
	const { user } = useSession();
	const path = videoEffectPath(effectId);
	const internalTest = effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID;
	const solo = effectId === RAINDANCE_SOLO_EFFECT_ID || internalTest;
	const returnQuery = new URLSearchParams();
	if (initialJobId) returnQuery.set("job", initialJobId);
	if (effectId === RAINDANCE_DUO_EFFECT_ID) returnQuery.set("mode", "duo");
	const returnPath = `${path}${returnQuery.size ? `?${returnQuery}` : ""}`;
	useEffect(() => {
		void recordVideoEffectEvent("view", undefined, effectId);
	}, [effectId]);
	if (!user || user.isAnonymous)
		return (
			<div className="ve-workbench">
				<section className="ve-creator">
					<div className="ve-card-heading">
						<span className="ve-eyebrow">
							{t(internalTest ? "rumpelstiltskin.onePhoto" : solo ? "onePhoto" : "twoPhotos")}
						</span>
						<LockKeyholeIcon aria-hidden />
					</div>
					<h2>{t(solo ? "makeYourSolo" : "makeYourDuo")}</h2>
					<p>{t("signInHint")}</p>
					<DuoPhotoInputs
						solo={solo}
						slots={{ left: emptyPhotoSlot, right: emptyPhotoSlot }}
						maxBytes={VIDEO_EFFECT_MAX_BYTES}
						disabled
						onSelect={() => undefined}
						onClear={() => undefined}
						onSwap={() => undefined}
					/>
					<OutputSpec />
					<Link className="ve-primary" href={`/login?redirectTo=${encodeURIComponent(returnPath)}`}>
						{t("signIn")}
						<ArrowUpRightIcon aria-hidden />
					</Link>
					<p className="ve-microcopy">
						{t(internalTest ? "rumpelstiltskin.testHint" : "betaHint")}
					</p>
				</section>
				{preview ?? <VideoEffectSamples samples={samples} effectId={effectId} />}
			</div>
		);
	return (
		<SignedInGenerator
			key={`${user.id}:${effectId}`}
			effectId={effectId}
			preview={preview}
			ownerId={user.id}
			initialJobId={initialJobId}
			samples={samples}
		/>
	);
}

function SignedInGenerator({
	effectId,
	preview,
	ownerId,
	initialJobId,
	samples,
}: {
	effectId: VideoEffectId;
	preview?: ReactNode;
	ownerId: string;
	initialJobId: string | null;
	samples: readonly PublicVideoEffectSample[];
}) {
	const t = useTranslations("videoEffects");
	const internalTest = effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID;
	const solo = effectId === RAINDANCE_SOLO_EFFECT_ID || internalTest;
	const upgrade = useUpgrade();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState(() => emptyEffectDraft(ownerId, effectId));
	const current = useRef(draft);
	const [restored, setRestored] = useState(false);
	const [slots, setSlots] = useState<Record<EffectRole, PhotoSlot>>({
		left: emptyPhotoSlot,
		right: emptyPhotoSlot,
	});
	const [quote, setQuote] = useState<EffectQuote | null>(null);
	const [expired, setExpired] = useState(false);
	const [priceChanged, setPriceChanged] = useState(false);
	const [busy, setBusy] = useState<"quote" | "submit" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const operation = useRef(false);
	const mounted = useRef(false);
	const visible = usePageVisible();
	const previewRetries = useRef<Record<EffectRole, string | null>>({ left: null, right: null });
	const uploads = useRef<
		Record<EffectRole, { revision: number; controller?: AbortController; objectUrl?: string }>
	>({ left: { revision: 0 }, right: { revision: 0 } });
	const access = useQuery({
		queryKey: ["video-effects", "access", ownerId, effectId],
		queryFn: () => videoEffectsApi.access({ effectId }),
		retry: false,
		staleTime: 15_000,
		refetchInterval: visible ? 30_000 : false,
		refetchIntervalInBackground: false,
	});
	const refreshAccess = access.refetch;
	useEffect(() => {
		if (!visible || !access.data?.pricingValidUntil) return;
		const expiresAt = Date.parse(access.data.pricingValidUntil);
		if (!Number.isFinite(expiresAt)) return;
		const timer = setTimeout(
			() => {
				void refreshAccess();
			},
			Math.max(1000, Math.min(expiresAt - Date.now(), 2_147_483_647)),
		);
		return () => clearTimeout(timer);
	}, [visible, access.data?.pricingValidUntil, refreshAccess]);
	const maxBytes = Math.min(
		access.data?.maxInputBytes ?? VIDEO_EFFECT_MAX_BYTES,
		VIDEO_EFFECT_MAX_BYTES,
	);
	const durationOptions =
		access.data?.durationOptions ??
		(access.data?.credits
			? [{ duration: 5 as const, credits: access.data.credits, pricing: access.data.pricing }]
			: []);
	const selectedOption = durationOptions.find((option) => option.duration === draft.duration);
	const enabled = Boolean(
		restored && access.data?.available && access.data.accessAllowed && selectedOption,
	);
	const uploading = [slots.left.status, slots.right.status].some(
		(status) => status === "uploading" || status === "sealing",
	);
	const inputsReady = Boolean(
		draft.leftAssetId &&
		slots.left.status === "sealed" &&
		(solo || (draft.rightAssetId && slots.right.status === "sealed")),
	);
	function store(next: EffectDraft, required = false) {
		try {
			sessionStorage.setItem(effectStorageKey(ownerId, effectId), JSON.stringify(next));
		} catch {
			if (required) throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
		}
		current.current = next;
		if (mounted.current) setDraft(next);
	}
	useEffect(() => {
		mounted.current = true;
		let canceled = false;
		let saved = emptyEffectDraft(ownerId, effectId);
		try {
			saved =
				readEffectDraft(
					sessionStorage.getItem(effectStorageKey(ownerId, effectId)),
					ownerId,
					effectId,
				) ?? saved;
		} catch {
			/* Draft remains empty if storage is blocked. */
		}
		if (initialJobId) saved = { ...saved, jobId: initialJobId };
		current.current = saved;
		setDraft(saved);
		setRestored(true);
		for (const role of ["left", "right"] as const) {
			const assetId = saved[`${role}AssetId`];
			if (!assetId) continue;
			const revision = uploads.current[role].revision;
			void videoEffectsApi.inputs
				.get({ assetId })
				.then((asset) => {
					if (canceled || uploads.current[role].revision !== revision) return;
					setSlots((value) => ({
						...value,
						[role]: {
							assetId,
							preview: asset.previewUrl,
							previewExpiresAt: asset.previewExpiresAt,
							status: "sealed",
						},
					}));
				})
				.catch(() => {
					if (canceled || uploads.current[role].revision !== revision) return;
					setSlots((value) => ({ ...value, [role]: { ...emptyPhotoSlot, status: "error" } }));
					setError(t("assetExpired"));
					store(changeEffectInputs(current.current, { [`${role}AssetId`]: null }));
				});
		}
		return () => {
			mounted.current = false;
			canceled = true;
			for (const item of Object.values(uploads.current)) {
				item.revision++;
				item.controller?.abort();
				if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
			}
		};
		// Owner remounts this component; restoring is intentionally a single read.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [ownerId, initialJobId, effectId]);
	async function refreshPreview(role: EffectRole) {
		const assetId = current.current[`${role}AssetId`];
		if (!assetId || slots[role].preview?.startsWith("blob:")) return;
		try {
			const asset = await videoEffectsApi.inputs.get({ assetId });
			if (current.current[`${role}AssetId`] !== assetId) return;
			setSlots((value) => ({
				...value,
				[role]: {
					...value[role],
					preview: asset.previewUrl,
					previewExpiresAt: asset.previewExpiresAt,
				},
			}));
		} catch {
			if (current.current[`${role}AssetId`] === assetId)
				setSlots((value) => ({
					...value,
					[role]: { ...value[role], preview: null, previewExpiresAt: null },
				}));
		}
	}
	useEffect(() => {
		if (!visible) return;
		const timers = (["left", "right"] as const).flatMap((role) => {
			const expires = slots[role].previewExpiresAt;
			if (!expires || !slots[role].preview || slots[role].preview?.startsWith("blob:")) return [];
			return [
				setTimeout(
					() => void refreshPreview(role),
					Math.min(2_147_483_647, Math.max(1000, Date.parse(expires) - Date.now())),
				),
			];
		});
		return () => timers.forEach(clearTimeout);
		// Refresh follows only server-issued expiry changes and visible-page transitions.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [slots.left.previewExpiresAt, slots.right.previewExpiresAt, visible]);
	useEffect(() => {
		if (!quote) {
			setExpired(false);
			return;
		}
		const delay = Date.parse(quote.expiresAt) - Date.now();
		setExpired(delay <= 0);
		if (delay <= 0) return;
		const timer = setTimeout(() => setExpired(true), Math.min(delay, 2_147_483_647));
		return () => clearTimeout(timer);
	}, [quote]);
	function clear(role: EffectRole) {
		const active = uploads.current[role];
		active.revision++;
		active.controller?.abort();
		if (active.objectUrl) URL.revokeObjectURL(active.objectUrl);
		active.objectUrl = undefined;
		setQuote(null);
		setPriceChanged(false);
		setError(null);
		setSlots((value) => ({ ...value, [role]: emptyPhotoSlot }));
		store(changeEffectInputs(current.current, { [`${role}AssetId`]: null }));
	}
	async function select(role: EffectRole, file: File) {
		if (!enabled || operation.current) return;
		clear(role);
		if (!validEffectFile(file, maxBytes)) {
			setError(t("invalidFile", { bytes: maxBytes.toLocaleString("en-US") }));
			return;
		}
		const active = uploads.current[role];
		const revision = active.revision;
		active.controller = new AbortController();
		active.objectUrl = URL.createObjectURL(file);
		setSlots((value) => ({
			...value,
			[role]: { assetId: null, preview: active.objectUrl ?? null, status: "uploading" },
		}));
		try {
			const upload = await videoEffectsApi.uploads.create({
				effectId,
				contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
				byteSize: file.size,
			});
			if (active.revision !== revision) return;
			const transfer = await fetch(upload.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
				signal: active.controller.signal,
			});
			if (!transfer.ok) throw new Error("UPLOAD_FAILED");
			if (active.revision !== revision) return;
			setSlots((value) => ({ ...value, [role]: { ...value[role], status: "sealing" } }));
			const sealed = await videoEffectsApi.uploads.complete({ sessionId: upload.sessionId });
			if (active.revision !== revision) return;
			setSlots((value) => ({
				...value,
				[role]: { ...value[role], status: "sealed", assetId: sealed.assetId },
			}));
			const next = changeEffectInputs(current.current, { [`${role}AssetId`]: sealed.assetId });
			store(next);
			if (next.leftAssetId && (solo || next.rightAssetId))
				void recordVideoEffectEvent("inputs_ready", undefined, effectId);
		} catch {
			if (active.revision === revision) {
				setSlots((value) => ({ ...value, [role]: { ...value[role], status: "error" } }));
				setError(t("uploadFailed"));
			}
		}
	}
	async function getQuote() {
		if (operation.current || !enabled || !inputsReady || uploading || current.current.confirmation)
			return;
		operation.current = true;
		setBusy("quote");
		setError(null);
		const revision = current.current.revision;
		try {
			const result = await videoEffectsApi.quote(effectRequest(current.current));
			if (mounted.current && revision === current.current.revision) {
				setQuote(result);
				void recordVideoEffectEvent("quote_view", result.quoteId, effectId);
			}
		} catch (failure) {
			setError(t(effectError(failure)));
		} finally {
			operation.current = false;
			setBusy(null);
		}
	}
	async function submitIntent(intent: EffectConfirmation) {
		setBusy("submit");
		// Persist the immutable request before any paid acceptance, including same-price one-click orders.
		store({ ...current.current, confirmation: intent }, true);
		void recordVideoEffectEvent("submit", intent.input.idempotencyKey, effectId);
		const accepted = await videoEffectsApi.jobs.create(intent.input);
		// Keep recovery durable even when a mode change unmounts this view during acceptance.
		store({ ...current.current, confirmation: null, jobId: accepted.jobId }, true);
		if (mounted.current) {
			setQuote(null);
			setPriceChanged(false);
		}
		void recordVideoEffectEvent("accepted", accepted.jobId, effectId);
		void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
		void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
		void queryClient.invalidateQueries({ queryKey: ["video-effects", "history", ownerId] });
	}
	function failedSubmission(failure: unknown) {
		const key = effectError(failure);
		if (key === "quoteExpired" || key === "insufficient") {
			store({ ...current.current, confirmation: null });
			if (mounted.current) setQuote(null);
			void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
		}
		if (mounted.current)
			setError(
				t(
					failure instanceof Error && failure.message === "RECOVERY_STORAGE_UNAVAILABLE"
						? "storageUnavailable"
						: key,
				),
			);
	}
	async function generate() {
		if (operation.current || !enabled || uploading || current.current.confirmation) return;
		if (current.current.jobId) {
			store({ ...current.current, jobId: null });
			setQuote(null);
			setPriceChanged(false);
			setError(null);
			return;
		}
		if (insufficientBalance) return buyCredits();
		if (!inputsReady) {
			const role = !draft.leftAssetId || slots.left.status !== "sealed" ? "left" : "right";
			document.querySelector<HTMLInputElement>(`#ve-upload-${role}`)?.click();
			return;
		}
		if (!totalCredits) return;
		const shownCredits = totalCredits;
		const revision = current.current.revision;
		operation.current = true;
		setBusy("quote");
		setError(null);
		try {
			const result = await videoEffectsApi.quote(effectRequest(current.current));
			// Switching mode or leaving before quotation must not start a paid order in a hidden view.
			if (!mounted.current || revision !== current.current.revision) return;
			if (Date.parse(result.expiresAt) <= Date.now()) throw new Error("QUOTE_EXPIRED_OR_CHANGED");
			setQuote(result);
			void recordVideoEffectEvent("quote_view", result.quoteId, effectId);
			if (result.credits !== shownCredits) {
				setPriceChanged(true);
				return;
			}
			await submitIntent(createEffectConfirmation(current.current, result));
		} catch (failure) {
			failedSubmission(failure);
		} finally {
			operation.current = false;
			if (mounted.current) setBusy(null);
		}
	}
	async function confirm() {
		if (
			operation.current ||
			(!current.current.confirmation && (!enabled || !quote || expired || insufficientBalance))
		)
			return;
		operation.current = true;
		setBusy("submit");
		setError(null);
		try {
			const intent =
				current.current.confirmation ?? createEffectConfirmation(current.current, quote!);
			await submitIntent(intent);
		} catch (failure) {
			failedSubmission(failure);
		} finally {
			operation.current = false;
			if (mounted.current) setBusy(null);
		}
	}
	function buyCredits() {
		try {
			store(current.current, true);
		} catch (failure) {
			failedSubmission(failure);
			return;
		}
		const returnPath = videoEffectReturnPath(effectId);
		saveVideoEffectPaymentReturn(ownerId, returnPath);
		const selection = { ...defaultUpgradeSelection, view: "credit-packs" as const };
		if (upgrade) upgrade(selection);
		else
			window.location.assign(
				`${upgradeHref(selection)}&returnTo=${encodeURIComponent(returnPath)}`,
			);
	}
	const pending = draft.confirmation;
	const totalCredits =
		pending?.quote.credits ??
		(quote && (!internalTest || !expired) ? quote.credits : selectedOption?.credits);
	const pricing = pending?.quote.pricing ?? quote?.pricing ?? selectedOption?.pricing;
	const creditBalance = access.data?.creditBalance;
	const shortfall =
		totalCredits && creditBalance
			? BigInt(totalCredits) - BigInt(creditBalance.eligibleCredits)
			: 0n;
	const insufficientBalance = !pending && shortfall > 0n;
	const hasIneligibleCredits =
		creditBalance && BigInt(creditBalance.totalCredits) > BigInt(creditBalance.eligibleCredits);
	const quoteHint =
		!restored || access.isPending
			? "checkingAvailability"
			: !enabled
				? "unavailable"
				: uploading
					? solo
						? "raindance.waitingForPhoto"
						: "waitingForPhotos"
					: solo
						? !draft.leftAssetId
							? "raindance.uploadPhotoHint"
							: !inputsReady
								? "raindance.waitingForPhoto"
								: null
						: !draft.leftAssetId && !draft.rightAssetId
							? "uploadBothHint"
							: !draft.leftAssetId
								? "uploadLeftHint"
								: !draft.rightAssetId
									? "uploadRightHint"
									: !inputsReady
										? "waitingForPhotos"
										: null;
	return (
		<div className="ve-workbench">
			<section className="ve-creator" aria-busy={busy !== null}>
				<div className="ve-card-heading">
					<span className="ve-eyebrow">
						{t(internalTest ? "rumpelstiltskin.onePhoto" : solo ? "onePhoto" : "twoPhotos")}
					</span>
					<LockKeyholeIcon aria-hidden />
				</div>
				<h2>{t(solo ? "makeYourSolo" : "makeYourDuo")}</h2>
				<p>{t("photoHint")}</p>
				{!enabled && (
					<output className="ve-notice" aria-live="polite">
						{access.isPending
							? t("checkingAvailability")
							: internalTest && access.data?.reasons.length
								? access.data.reasons.map((reason, index) => (
										<p key={`${reason}:${index}`}>{t(effectReadinessMessage(reason))}</p>
									))
								: t("unavailable")}
					</output>
				)}
				<DuoPhotoInputs
					solo={solo}
					slots={slots}
					maxBytes={maxBytes}
					disabled={!enabled || busy !== null}
					onSelect={(role, file) => void select(role, file)}
					onClear={clear}
					onPreviewError={(role) => {
						const assetId = current.current[`${role}AssetId`];
						if (assetId && previewRetries.current[role] !== assetId) {
							previewRetries.current[role] = assetId;
							void refreshPreview(role);
						}
					}}
					onSwap={() => {
						if (uploading) return;
						store(swapEffectInputs(current.current));
						uploads.current = { left: uploads.current.right, right: uploads.current.left };
						setSlots((value) => ({ left: value.right, right: value.left }));
						setQuote(null);
						setPriceChanged(false);
						setError(null);
					}}
				/>
				{!internalTest && (
					<fieldset
						className="ve-duration"
						disabled={!restored || busy !== null || !!pending || !!draft.jobId}
					>
						<legend>{t("duration")}</legend>
						<div>
							{([5, 10] as const).map((duration) => {
								const option = durationOptions.find((item) => item.duration === duration);
								return (
									<button
										key={duration}
										type="button"
										aria-pressed={draft.duration === duration}
										disabled={!option || !access.data?.available}
										onClick={() => {
											if (
												operation.current ||
												current.current.confirmation ||
												current.current.jobId ||
												!option ||
												duration === current.current.duration
											)
												return;
											store({
												...current.current,
												duration,
												revision: current.current.revision + 1,
											});
											setQuote(null);
											setExpired(false);
											setPriceChanged(false);
											setError(null);
										}}
									>
										<span>{t("seconds", { seconds: duration })}</span>
										<small>
											{option ? t("credits", { credits: option.credits }) : t("priceUnavailable")}
										</small>
									</button>
								);
							})}
						</div>
					</fieldset>
				)}
				<OutputSpec duration={pending ? (pending.input.request.duration ?? 5) : draft.duration} />
				<div className="ve-price">
					<div>
						<small>{t("totalCredits")}</small>
						<strong>
							{totalCredits
								? t("credits", { credits: totalCredits })
								: t(access.isPending ? "loadingPrice" : "priceUnavailable")}
						</strong>
					</div>
					<div>
						<small>{t("eligibleBalance")}</small>
						<span>
							{creditBalance
								? t("credits", { credits: creditBalance.eligibleCredits })
								: t(access.isPending ? "loadingPrice" : "balanceUnavailable")}
						</span>
						{creditBalance && (
							<small>{t("accountBalance", { credits: creditBalance.totalCredits })}</small>
						)}
					</div>
				</div>
				{!internalTest && pricing && (
					<div className="ve-plan-prices" aria-live="polite">
						<p>
							{t("planPrices", {
								standard: pricing.standardCredits,
								annual: pricing.annualCredits,
							})}
						</p>
						{BigInt(pricing.annualSavingsCredits) > 0n && (
							<p className="ve-annual-saving">
								{t(
									pricing.audience === "annual" ? "annualSavingApplied" : "annualSavingAvailable",
									{ credits: pricing.annualSavingsCredits },
								)}
							</p>
						)}
					</div>
				)}
				<p className="ve-microcopy">
					{t(internalTest ? "rumpelstiltskin.priceHint" : "priceHint")}
				</p>
				{!pending && (insufficientBalance || hasIneligibleCredits) && (
					<div id="ve-funding-hint" className="ve-notice" aria-live="polite">
						{insufficientBalance && (
							<span>{t("creditShortfall", { credits: shortfall.toString() })}</span>
						)}
						{hasIneligibleCredits && <span>{t("eligibleBalanceHint")}</span>}
					</div>
				)}
				{error && (
					<p className="ve-error" role="alert">
						{error}
					</p>
				)}
				{pending ? (
					<>
						<p className="ve-notice">{t("pendingHint")}</p>
						<button
							type="button"
							className="ve-primary"
							disabled={busy !== null}
							onClick={() => void confirm()}
						>
							{t("recover")}
						</button>
					</>
				) : !internalTest ? (
					<>
						{quoteHint && !draft.jobId && (
							<p id="ve-quote-hint" className="ve-microcopy" aria-live="polite">
								{t(quoteHint)}
							</p>
						)}
						{priceChanged && totalCredits && (
							<output id="ve-price-change" className="ve-notice" aria-live="polite">
								{t("priceChanged", { credits: totalCredits })}
							</output>
						)}
						<button
							type="button"
							className="ve-primary"
							disabled={!enabled || busy !== null || uploading || (!totalCredits && inputsReady)}
							aria-describedby={
								insufficientBalance
									? "ve-funding-hint"
									: priceChanged
										? "ve-price-change"
										: quoteHint
											? "ve-quote-hint"
											: undefined
							}
							onClick={() => void generate()}
						>
							<SparklesIcon aria-hidden />
							{busy
								? t(busy === "quote" ? "quoting" : "submitting")
								: draft.jobId
									? t("newVideo")
									: insufficientBalance
										? t("addCredits")
										: !inputsReady
											? t(solo ? "uploadPhoto" : !draft.leftAssetId ? "uploadLeft" : "uploadRight")
											: t(priceChanged ? "confirmNewPrice" : "generate", {
													credits: totalCredits ?? "",
												})}
						</button>
					</>
				) : quote && !expired ? (
					<button
						type="button"
						className="ve-primary"
						disabled={!enabled || busy !== null || uploading || insufficientBalance}
						aria-describedby={insufficientBalance ? "ve-funding-hint" : undefined}
						onClick={() => void confirm()}
					>
						<SparklesIcon aria-hidden />
						{t(busy === "submit" ? "submitting" : "generate", { credits: quote.credits })}
					</button>
				) : (
					<>
						{quoteHint && (
							<p id="ve-quote-hint" className="ve-microcopy" aria-live="polite">
								{t(quoteHint)}
							</p>
						)}
						<button
							type="button"
							className="ve-primary"
							disabled={!enabled || !inputsReady || busy !== null || uploading}
							aria-describedby={quoteHint ? "ve-quote-hint" : undefined}
							onClick={() => void getQuote()}
						>
							{t(busy === "quote" ? "quoting" : "getQuote")}
						</button>
						{expired && <p className="ve-microcopy">{t("quoteExpired")}</p>}
					</>
				)}
				<div className="ve-actions">
					{!internalTest && !insufficientBalance && (
						<button type="button" className="ve-text-button" onClick={buyCredits}>
							{t("addCredits")}
						</button>
					)}
					<a
						href={
							internalTest
								? "#rumpelstiltskin-history"
								: effectId === HOTEL_LOBBY_EFFECT_ID
									? "#hotel-lobby-history"
									: "#raindance-history"
						}
					>
						{t(
							internalTest
								? "rumpelstiltskin.history"
								: effectId === HOTEL_LOBBY_EFFECT_ID
									? "history"
									: "raindance.history",
						)}
					</a>
				</div>
			</section>
			{draft.jobId ? (
				<VideoEffectJob key={draft.jobId} jobId={draft.jobId} />
			) : (
				(preview ?? <VideoEffectSamples samples={samples} effectId={effectId} />)
			)}
		</div>
	);
}

function OutputSpec({ duration = 5 }: { duration?: 5 | 10 }) {
	const t = useTranslations("videoEffects");
	return (
		<div className="ve-spec">
			<div>
				<span>{t("seconds", { seconds: duration })}</span>
				<span>720p</span>
				<span>9:16</span>
				<span>MP4</span>
			</div>
			<p>{t("silent")}</p>
		</div>
	);
}
function VideoEffectSamples({
	samples,
	effectId,
}: {
	samples: readonly PublicVideoEffectSample[];
	effectId: VideoEffectId;
}) {
	const t = useTranslations("videoEffects");
	const [selected, setSelected] = useState(0);
	const sample = samples[selected];
	if (!sample) return <SamplePlaceholder />;
	return (
		<aside className="ve-result ve-public-sample">
			<span className="ve-eyebrow">{t("sample")}</span>
			<video
				key={sample.id}
				controls
				playsInline
				preload="none"
				poster={sample.thumbnail.src}
				src={sample.video.src}
				aria-label={sample.caption}
				onPlay={() => void recordVideoEffectEvent("sample_play", sample.id, effectId)}
			>
				<track kind="captions" />
			</video>
			<p>{sample.caption}</p>
			<div className="ve-sample-inputs">
				<img src={sample.left.src} alt={sample.left.alt} loading="lazy" />
				<img src={sample.right.src} alt={sample.right.alt} loading="lazy" />
			</div>
			<div className="ve-actions">
				{samples.map((item, index) => (
					<button
						type="button"
						key={item.id}
						aria-pressed={selected === index}
						onClick={() => setSelected(index)}
					>
						{t("sampleNumber", { number: index + 1 })}
					</button>
				))}
			</div>
		</aside>
	);
}
function SamplePlaceholder() {
	const t = useTranslations("videoEffects");
	return (
		<aside className="ve-sample-placeholder">
			<span className="ve-eyebrow">{t("previewLabel")}</span>
			<div className="ve-sample-empty">
				<FilmIcon aria-hidden />
				<h2>{t("samplesPending")}</h2>
				<p>{t("samplesHint")}</p>
			</div>
			<p className="ve-microcopy">{t("privateHint")}</p>
		</aside>
	);
}

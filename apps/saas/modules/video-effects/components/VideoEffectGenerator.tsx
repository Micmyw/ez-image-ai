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
	const lifecycle = useRef(0);
	const operation = useRef<{ lifecycle: number } | null>(null);
	const mounted = useRef(false);
	const previewRetries = useRef<Record<EffectRole, string | null>>({ left: null, right: null });
	const uploads = useRef<
		Record<EffectRole, { revision: number; transfer?: XMLHttpRequest; objectUrl?: string }>
	>({ left: { revision: 0 }, right: { revision: 0 } });
	const access = useQuery({
		queryKey: ["video-effects", "access", ownerId, effectId],
		queryFn: () => videoEffectsApi.access({ effectId }),
		retry: false,
		staleTime: 5 * 60_000,
		gcTime: 30 * 60_000,
		refetchOnWindowFocus: false,
	});
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
	function isCurrentOperation(active: { lifecycle: number }) {
		return (
			mounted.current && operation.current === active && lifecycle.current === active.lifecycle
		);
	}
	function beginOperation(stage: "quote" | "submit") {
		const active = { lifecycle: lifecycle.current };
		operation.current = active;
		setBusy(stage);
		setError(null);
		return active;
	}
	function finishOperation(active: { lifecycle: number }) {
		if (!isCurrentOperation(active)) return;
		operation.current = null;
		setBusy(null);
	}
	function settleStoredIntent(
		intent: EffectConfirmation,
		active: { lifecycle: number },
		jobId?: string,
	) {
		// A response can outlive its view. Compare the latest durable receipt before
		// writing so an old instance cannot erase the next order's recovery key.
		try {
			const key = effectStorageKey(ownerId, effectId);
			const saved = readEffectDraft(sessionStorage.getItem(key), ownerId, effectId);
			if (
				saved?.confirmation?.input.idempotencyKey !== intent.input.idempotencyKey ||
				saved.confirmation.input.quoteId !== intent.input.quoteId
			)
				return;
			const next = { ...saved, confirmation: null, ...(jobId ? { jobId } : {}) };
			sessionStorage.setItem(key, JSON.stringify(next));
			if (
				isCurrentOperation(active) &&
				current.current.confirmation?.input.idempotencyKey === intent.input.idempotencyKey
			) {
				current.current = next;
				setDraft(next);
			}
		} catch {
			throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
		}
	}
	useEffect(() => {
		lifecycle.current++;
		operation.current = null;
		mounted.current = true;
		setBusy(null);
		setQuote(null);
		setPriceChanged(false);
		setError(null);
		setSlots({ left: emptyPhotoSlot, right: emptyPhotoSlot });
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
							previewFailed: !asset.previewUrl,
							status: "sealed",
						},
					}));
				})
				.catch((failure: unknown) => {
					if (canceled || uploads.current[role].revision !== revision) return;
					if (
						failure &&
						typeof failure === "object" &&
						"code" in failure &&
						failure.code === "NOT_FOUND"
					) {
						setSlots((value) => ({ ...value, [role]: { ...emptyPhotoSlot, status: "error" } }));
						setError(t("assetExpired"));
						store(changeEffectInputs(current.current, { [`${role}AssetId`]: null }));
						return;
					}
					// Preview transport failure does not invalidate the saved photo identity.
					setSlots((value) => ({
						...value,
						[role]: { assetId, preview: null, status: "sealed", previewFailed: true },
					}));
				});
		}
		return () => {
			mounted.current = false;
			operation.current = null;
			canceled = true;
			for (const item of Object.values(uploads.current)) {
				item.revision++;
				item.transfer?.abort();
				if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
			}
		};
		// Each owner/effect/history restoration owns a fresh async-operation lifetime.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [ownerId, initialJobId, effectId]);
	async function refreshPreview(role: EffectRole) {
		const assetId = current.current[`${role}AssetId`];
		if (!assetId || slots[role].preview?.startsWith("blob:")) return;
		const revision = uploads.current[role].revision;
		const view = lifecycle.current;
		try {
			const asset = await videoEffectsApi.inputs.get({ assetId });
			if (
				!mounted.current ||
				lifecycle.current !== view ||
				uploads.current[role].revision !== revision ||
				current.current[`${role}AssetId`] !== assetId
			)
				return;
			setSlots((value) => ({
				...value,
				[role]: {
					...value[role],
					preview: asset.previewUrl,
					previewFailed: !asset.previewUrl,
				},
			}));
		} catch {
			if (
				mounted.current &&
				lifecycle.current === view &&
				uploads.current[role].revision === revision &&
				current.current[`${role}AssetId`] === assetId
			)
				setSlots((value) => ({
					...value,
					[role]: { ...value[role], previewFailed: true },
				}));
		}
	}
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
		active.transfer?.abort();
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
		if (!validEffectFile(file, maxBytes)) {
			setError(t("invalidFile", { bytes: maxBytes.toLocaleString("en-US") }));
			return;
		}
		clear(role);
		const active = uploads.current[role];
		const revision = active.revision;
		active.objectUrl = URL.createObjectURL(file);
		setSlots((value) => ({
			...value,
			[role]: {
				assetId: null,
				preview: active.objectUrl ?? null,
				status: "uploading",
				progress: 0,
			},
		}));
		try {
			const upload = await videoEffectsApi.uploads.create({
				effectId,
				contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
				byteSize: file.size,
			});
			if (active.revision !== revision) return;
			await new Promise<void>((resolve, reject) => {
				const transfer = new XMLHttpRequest();
				active.transfer = transfer;
				transfer.open("PUT", upload.uploadUrl);
				transfer.setRequestHeader("Content-Type", file.type);
				transfer.upload.onprogress = (event) => {
					if (active.revision === revision && event.lengthComputable)
						setSlots((value) => ({
							...value,
							[role]: { ...value[role], progress: Math.round((event.loaded / event.total) * 100) },
						}));
				};
				transfer.onload = () =>
					transfer.status >= 200 && transfer.status < 300
						? resolve()
						: reject(new Error("UPLOAD_FAILED"));
				transfer.onerror = transfer.onabort = () => reject(new Error("UPLOAD_FAILED"));
				transfer.send(file);
			});
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
		const active = beginOperation("quote");
		const revision = current.current.revision;
		try {
			const result = await videoEffectsApi.quote(effectRequest(current.current));
			if (isCurrentOperation(active) && revision === current.current.revision) {
				setQuote(result);
				void recordVideoEffectEvent("quote_view", result.quoteId, effectId);
			}
		} catch (failure) {
			if (isCurrentOperation(active)) setError(t(effectError(failure)));
		} finally {
			finishOperation(active);
		}
	}
	async function submitIntent(intent: EffectConfirmation, active: { lifecycle: number }) {
		if (!isCurrentOperation(active)) return;
		setBusy("submit");
		// Persist the immutable request before any paid acceptance, including same-price one-click orders.
		store({ ...current.current, confirmation: intent }, true);
		void recordVideoEffectEvent("submit", intent.input.idempotencyKey, effectId);
		const accepted = await videoEffectsApi.jobs.create(intent.input);
		// Keep recovery durable even when a mode change unmounts this view during acceptance.
		settleStoredIntent(intent, active, accepted.jobId);
		if (isCurrentOperation(active)) {
			setQuote(null);
			setPriceChanged(false);
		}
		void recordVideoEffectEvent("accepted", accepted.jobId, effectId);
		void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
		void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
		void queryClient.invalidateQueries({ queryKey: ["video-effects", "history", ownerId] });
	}
	function failedSubmission(
		failure: unknown,
		active?: { lifecycle: number },
		intent?: EffectConfirmation,
	) {
		const key = effectError(failure);
		if (key === "quoteExpired" || key === "insufficient") {
			if (intent && active) {
				try {
					settleStoredIntent(intent, active);
				} catch (storageFailure) {
					failure = storageFailure;
				}
			}
			if (mounted.current && (!active || isCurrentOperation(active))) setQuote(null);
			void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
		}
		if (mounted.current && (!active || isCurrentOperation(active)))
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
		// Cached balance is a hint; quote/admission checks current funds at submission.
		if (!inputsReady) {
			const role = !draft.leftAssetId || slots.left.status !== "sealed" ? "left" : "right";
			document.querySelector<HTMLInputElement>(`#ve-upload-${role}`)?.click();
			return;
		}
		if (!totalCredits) return;
		if (priceChanged && quote && !expired) {
			await confirm();
			return;
		}
		const shownCredits = totalCredits;
		const quotedDraft = current.current;
		const active = beginOperation("quote");
		let intent: EffectConfirmation | undefined;
		try {
			const result = await videoEffectsApi.quote(effectRequest(quotedDraft));
			// Switching mode or leaving before quotation must not start a paid order in a hidden view.
			if (
				!isCurrentOperation(active) ||
				quotedDraft.revision !== current.current.revision ||
				current.current.jobId ||
				current.current.confirmation
			)
				return;
			if (Date.parse(result.expiresAt) <= Date.now()) throw new Error("QUOTE_EXPIRED_OR_CHANGED");
			setQuote(result);
			void recordVideoEffectEvent("quote_view", result.quoteId, effectId);
			if (result.credits !== shownCredits) {
				setPriceChanged(true);
				return;
			}
			intent = createEffectConfirmation(quotedDraft, result);
			await submitIntent(intent, active);
		} catch (failure) {
			failedSubmission(failure, active, intent);
		} finally {
			finishOperation(active);
		}
	}
	async function confirm() {
		if (
			operation.current ||
			(!current.current.confirmation &&
				(!enabled || !quote || expired || (internalTest && insufficientBalance)))
		)
			return;
		const active = beginOperation("submit");
		let intent: EffectConfirmation | undefined;
		try {
			intent = current.current.confirmation ?? createEffectConfirmation(current.current, quote!);
			await submitIntent(intent, active);
		} catch (failure) {
			failedSubmission(failure, active, intent);
		} finally {
			finishOperation(active);
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
		pending?.quote.credits ?? (quote && !expired ? quote.credits : selectedOption?.credits);
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
						{!access.isPending && (
							<button type="button" onClick={() => void access.refetch()}>
								{t("retryAvailability")}
							</button>
						)}
					</output>
				)}
				<DuoPhotoInputs
					solo={solo}
					slots={slots}
					maxBytes={maxBytes}
					disabled={!enabled || busy !== null}
					onSelect={(role, file) => void select(role, file)}
					onClear={clear}
					onRetryPreview={(role) => void refreshPreview(role)}
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
					{!internalTest && (
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

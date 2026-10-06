"use client";

import { useSession } from "@auth/hooks/use-session";
import { useUpgrade } from "@payments/components/upgrade-context";
import { defaultUpgradeSelection, upgradeHref } from "@payments/lib/upgrade-selection";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, FilmIcon, LockKeyholeIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { usePageVisible } from "../../video-v1/use-video";
import { recordVideoEffectEvent } from "../lib/analytics";
import { videoEffectsApi } from "../lib/api";
import type { PublicVideoEffectSample } from "../lib/content";
import {
	changeEffectInputs,
	createEffectConfirmation,
	effectError,
	effectRequest,
	effectStorageKey,
	emptyEffectDraft,
	readEffectDraft,
	swapEffectInputs,
	validEffectFile,
	VIDEO_EFFECT_MAX_BYTES,
	VIDEO_EFFECT_PATH,
	type EffectDraft,
	type EffectQuote,
	type EffectRole,
} from "../lib/model";
import { saveVideoEffectPaymentReturn } from "../lib/payment-return";
import { DuoPhotoInputs, emptyPhotoSlot, type PhotoSlot } from "./DuoPhotoInputs";
import { VideoEffectJob } from "./VideoEffectJob";

export function VideoEffectGenerator({
	initialJobId,
	samples = [],
}: {
	initialJobId: string | null;
	samples?: readonly PublicVideoEffectSample[];
}) {
	const t = useTranslations("videoEffects");
	const { user } = useSession();
	useEffect(() => {
		void recordVideoEffectEvent("view");
	}, []);
	if (!user || user.isAnonymous)
		return (
			<div className="ve-workbench">
				<section className="ve-creator">
					<div className="ve-card-heading">
						<span className="ve-eyebrow">{t("twoPhotos")}</span>
						<LockKeyholeIcon aria-hidden />
					</div>
					<h2>{t("makeYourDuo")}</h2>
					<p>{t("signInHint")}</p>
					<DuoPhotoInputs
						slots={{ left: emptyPhotoSlot, right: emptyPhotoSlot }}
						maxBytes={VIDEO_EFFECT_MAX_BYTES}
						disabled
						onSelect={() => undefined}
						onClear={() => undefined}
						onSwap={() => undefined}
					/>
					<OutputSpec />
					<Link
						className="ve-primary"
						href={`/login?redirectTo=${encodeURIComponent(initialJobId ? `${VIDEO_EFFECT_PATH}?job=${encodeURIComponent(initialJobId)}` : VIDEO_EFFECT_PATH)}`}
					>
						{t("signIn")}
						<ArrowUpRightIcon aria-hidden />
					</Link>
					<p className="ve-microcopy">{t("betaHint")}</p>
				</section>
				<VideoEffectSamples samples={samples} />
			</div>
		);
	return (
		<SignedInGenerator
			key={user.id}
			ownerId={user.id}
			initialJobId={initialJobId}
			samples={samples}
		/>
	);
}

function SignedInGenerator({
	ownerId,
	initialJobId,
	samples,
}: {
	ownerId: string;
	initialJobId: string | null;
	samples: readonly PublicVideoEffectSample[];
}) {
	const t = useTranslations("videoEffects");
	const upgrade = useUpgrade();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState(() => emptyEffectDraft(ownerId));
	const current = useRef(draft);
	const [restored, setRestored] = useState(false);
	const [slots, setSlots] = useState<Record<EffectRole, PhotoSlot>>({
		left: emptyPhotoSlot,
		right: emptyPhotoSlot,
	});
	const [quote, setQuote] = useState<EffectQuote | null>(null);
	const [expired, setExpired] = useState(false);
	const [busy, setBusy] = useState<"quote" | "submit" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const operation = useRef(false);
	const visible = usePageVisible();
	const previewRetries = useRef<Record<EffectRole, string | null>>({ left: null, right: null });
	const uploads = useRef<
		Record<EffectRole, { revision: number; controller?: AbortController; objectUrl?: string }>
	>({ left: { revision: 0 }, right: { revision: 0 } });
	const access = useQuery({
		queryKey: ["video-effects", "access", ownerId],
		queryFn: () => videoEffectsApi.access(),
		retry: false,
		staleTime: 15_000,
	});
	const maxBytes = Math.min(
		access.data?.maxInputBytes ?? VIDEO_EFFECT_MAX_BYTES,
		VIDEO_EFFECT_MAX_BYTES,
	);
	const enabled = Boolean(restored && access.data?.available && access.data.accessAllowed);
	const uploading = [slots.left.status, slots.right.status].some(
		(status) => status === "uploading" || status === "sealing",
	);
	const inputsReady = Boolean(
		draft.leftAssetId &&
		draft.rightAssetId &&
		slots.left.status === "sealed" &&
		slots.right.status === "sealed",
	);
	function store(next: EffectDraft, required = false) {
		try {
			sessionStorage.setItem(effectStorageKey(ownerId), JSON.stringify(next));
		} catch {
			if (required) throw new Error("RECOVERY_STORAGE_UNAVAILABLE");
		}
		current.current = next;
		setDraft(next);
	}
	useEffect(() => {
		let canceled = false;
		let saved = emptyEffectDraft(ownerId);
		try {
			saved = readEffectDraft(sessionStorage.getItem(effectStorageKey(ownerId)), ownerId) ?? saved;
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
			canceled = true;
			for (const item of Object.values(uploads.current)) {
				item.revision++;
				item.controller?.abort();
				if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
			}
		};
		// Owner remounts this component; restoring is intentionally a single read.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [ownerId, initialJobId]);
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
			if (next.leftAssetId && next.rightAssetId) void recordVideoEffectEvent("inputs_ready");
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
			if (revision === current.current.revision) {
				setQuote(result);
				void recordVideoEffectEvent("quote_view", result.quoteId);
			}
		} catch (failure) {
			setError(t(effectError(failure)));
		} finally {
			operation.current = false;
			setBusy(null);
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
			// Fail closed before the paid request if refresh recovery cannot be persisted.
			store({ ...current.current, confirmation: intent }, true);
			void recordVideoEffectEvent("submit", intent.input.idempotencyKey);
			const accepted = await videoEffectsApi.jobs.create(intent.input);
			store({ ...current.current, confirmation: null, jobId: accepted.jobId }, true);
			setQuote(null);
			void recordVideoEffectEvent("accepted", accepted.jobId);
			void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
			void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
			void queryClient.invalidateQueries({ queryKey: ["video-effects", "history", ownerId] });
		} catch (failure) {
			const key = effectError(failure);
			if (key === "quoteExpired" || key === "insufficient") {
				store({ ...current.current, confirmation: null });
				setQuote(null);
				void queryClient.invalidateQueries({ queryKey: ["video-effects", "access", ownerId] });
			}
			setError(
				t(
					failure instanceof Error && failure.message === "RECOVERY_STORAGE_UNAVAILABLE"
						? "storageUnavailable"
						: key,
				),
			);
		} finally {
			operation.current = false;
			setBusy(null);
		}
	}
	function buyCredits() {
		saveVideoEffectPaymentReturn(ownerId);
		const selection = { ...defaultUpgradeSelection, view: "credit-packs" as const };
		if (upgrade) upgrade(selection);
		else
			window.location.assign(
				`${upgradeHref(selection)}&returnTo=${encodeURIComponent(VIDEO_EFFECT_PATH)}`,
			);
	}
	const pending = draft.confirmation;
	const totalCredits =
		pending?.quote.credits ?? (quote && !expired ? quote.credits : access.data?.credits);
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
					? "waitingForPhotos"
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
					<span className="ve-eyebrow">{t("twoPhotos")}</span>
					<LockKeyholeIcon aria-hidden />
				</div>
				<h2>{t("makeYourDuo")}</h2>
				<p>{t("photoHint")}</p>
				{!enabled && (
					<output className="ve-notice">
						{t(access.isPending ? "checkingAvailability" : "unavailable")}
					</output>
				)}
				<DuoPhotoInputs
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
						setError(null);
					}}
				/>
				<OutputSpec />
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
				<p className="ve-microcopy">{t("priceHint")}</p>
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
					<button type="button" className="ve-text-button" onClick={buyCredits}>
						{t("addCredits")}
					</button>
					<a href="#hotel-lobby-history">{t("history")}</a>
				</div>
			</section>
			{draft.jobId ? (
				<VideoEffectJob key={draft.jobId} jobId={draft.jobId} />
			) : (
				<VideoEffectSamples samples={samples} />
			)}
		</div>
	);
}

function OutputSpec() {
	const t = useTranslations("videoEffects");
	return (
		<div className="ve-spec">
			<div>
				<span>{t("seconds", { seconds: 5 })}</span>
				<span>720p</span>
				<span>9:16</span>
				<span>MP4</span>
			</div>
			<p>{t("silent")}</p>
		</div>
	);
}
function VideoEffectSamples({ samples }: { samples: readonly PublicVideoEffectSample[] }) {
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
				onPlay={() => void recordVideoEffectEvent("sample_play", sample.id)}
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

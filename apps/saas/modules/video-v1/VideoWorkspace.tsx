"use client";

import { useSession } from "@auth/hooks/use-session";
import { useGenerationMode, useGeneratorSignInDraft } from "@media/lib/generation-mode-context";
import { videoJobUrl, validVideoJobId } from "@media/lib/generator-navigation";
import { getVideoModel } from "@repo/config/video-models";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { videoApi, type VideoQuote, type VideoRequest } from "./api";
import {
	parseVideoDraft,
	serializeVideoDraft,
	videoDraftKey,
	VIDEO_GUEST_HANDOFF_KEY,
} from "./draft-storage";
import {
	createVideoConfirmation,
	changeVideoDraft,
	initialVideoDraft,
	getVideoFailureRecovery,
	parseVideoConfirmation,
	restoreVideoDraft,
	validateVideoDraft,
	videoRequestFor,
	videoSelectionCredits,
	videoSelectionPricing,
	type VideoConfirmation,
	type VideoDraft,
	type VideoErrorKey,
} from "./model";
import { useVideoCatalog } from "./use-video";
import { useVideoUpload } from "./use-video-upload";
import { VideoComposer } from "./VideoComposer";

type VideoOperation = { epoch: number };

export function VideoWorkspace({ initialJobId }: { initialJobId: string | null }) {
	const { user } = useSession();
	const registered = Boolean(user && !user.isAnonymous);
	const owner = registered ? user!.id : "guest";
	const workspace = useGenerationMode();
	const queryClient = useQueryClient();
	const catalog = useVideoCatalog();
	const maximumBytes = catalog.data?.maxInputBytes ?? 10 * 1024 * 1024;
	const { upload, select, clear } = useVideoUpload(maximumBytes);
	const [draft, setDraft] = useState<VideoDraft>(initialVideoDraft);
	const [quote, setQuote] = useState<VideoQuote | null>(null);
	const [quoteExpired, setQuoteExpired] = useState(false);
	const [confirmation, setConfirmation] = useState<VideoConfirmation | null>(null);
	const [busy, setBusy] = useState<"quote" | "create" | null>(null);
	const [error, setError] = useState<VideoErrorKey | null>(null);
	const [jobId, setJobId] = useState(initialJobId);
	const [ready, setReady] = useState(false);
	const [draftOwner, setDraftOwner] = useState<string | null>(null);
	const [storageUnavailable, setStorageUnavailable] = useState(false);
	const previousRouteJob = useRef(initialJobId);
	const live = useRef(true);
	const ownerEpoch = useRef(0);
	const operation = useRef<VideoOperation | null>(null);
	useEffect(() => {
		live.current = true;
		ownerEpoch.current++;
		return () => {
			live.current = false;
			operation.current = null;
		};
	}, []);
	const revision = useRef(0);
	const quotedRequest = useRef<{ request: VideoRequest; revision: number } | null>(null);
	const restoredOwner = useRef<string | null>(null);
	const storageKey = registered ? `video-v1:confirmation:${owner}` : null;
	function saveConfirmation(value: VideoConfirmation | null) {
		setConfirmation(value);
		if (!storageKey) return;
		try {
			if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
			else sessionStorage.removeItem(storageKey);
		} catch {
			setStorageUnavailable(true); // The in-memory identity remains stable.
		}
	}
	useEffect(() => {
		if (restoredOwner.current === owner) return;
		ownerEpoch.current++;
		operation.current = null;
		if (restoredOwner.current !== null) {
			revision.current++;
			clear();
			setReady(false);
			setDraft(initialVideoDraft);
			setQuote(null);
			setConfirmation(null);
			setBusy(null);
			setError(null);
			setJobId(null);
			quotedRequest.current = null;
		}
		restoredOwner.current = owner;
		try {
			const saved = storageKey ? parseVideoConfirmation(sessionStorage.getItem(storageKey)) : null;
			let restored = parseVideoDraft(sessionStorage.getItem(videoDraftKey(owner)), owner);
			if (registered && new URLSearchParams(window.location.search).get("videoResume") === "1") {
				const handoff = parseVideoDraft(sessionStorage.getItem(VIDEO_GUEST_HANDOFF_KEY), "guest");
				if (handoff) restored = handoff;
				sessionStorage.removeItem(VIDEO_GUEST_HANDOFF_KEY);
				sessionStorage.removeItem(videoDraftKey("guest"));
			}
			if (saved) {
				setDraft({
					...restoreVideoDraft(saved.input.request),
					...(restored?.variantSelections ? { variantSelections: restored.variantSelections } : {}),
				});
				setConfirmation(saved);
				setQuote(saved.quote);
			} else if (restored) setDraft(restored);
			if (!initialJobId && registered) {
				const latest = validVideoJobId(sessionStorage.getItem(`video-v1:last-job:${owner}`));
				if (latest) {
					setJobId(latest);
					window.history.replaceState(null, "", videoJobUrl(window.location.href, latest));
				}
			}
		} catch {
			setStorageUnavailable(true);
		}
		setDraftOwner(owner);
		setReady(true);
	}, [owner, registered, storageKey, initialJobId, clear]);
	useEffect(() => {
		// The restore effect schedules state updates. Do not persist the previous
		// owner's render under a new owner's storage key before those updates commit.
		if (!ready || draftOwner !== owner) return;
		try {
			sessionStorage.setItem(videoDraftKey(owner), serializeVideoDraft(draft, owner));
		} catch {
			setStorageUnavailable(true);
		}
	}, [draft, draftOwner, owner, ready]);
	useEffect(() => {
		if (previousRouteJob.current === initialJobId) return;
		previousRouteJob.current = initialJobId;
		if (initialJobId) setJobId(initialJobId);
	}, [initialJobId]);
	useEffect(() => {
		if (!quote) {
			setQuoteExpired(false);
			return;
		}
		const remaining = Date.parse(quote.expiresAt) - Date.now();
		setQuoteExpired(remaining <= 0);
		if (remaining <= 0) return;
		const timer = setTimeout(() => setQuoteExpired(true), Math.min(remaining, 2_147_483_647));
		return () => clearTimeout(timer);
	}, [quote]);
	useEffect(() => {
		if (!upload.assetId) return;
		revision.current++;
		setDraft((current) => changeVideoDraft(current, { inputAssetId: upload.assetId }));
		setQuote(null);
		quotedRequest.current = null;
	}, [upload.assetId]);
	function change(patch: Partial<VideoDraft>) {
		if (confirmation || busy === "create") return;
		revision.current++;
		setDraft((current) => changeVideoDraft(current, patch, catalog.data));
		setQuote(null);
		quotedRequest.current = null;
		setError(null);
	}
	function handleFailure(failure: unknown) {
		const recovery = getVideoFailureRecovery(failure);
		setError(recovery.reason);
		if (recovery.clearQuote) {
			saveConfirmation(null);
			setQuote(null);
			quotedRequest.current = null;
		}
		if (recovery.normalizeDraft) {
			// Admission definitively rejected this request. Only now may its editable
			// settings follow current capabilities; a restored reference needs re-selection.
			revision.current++;
			setDraft((current) =>
				changeVideoDraft(current, {
					mode: current.mode,
					inputAssetId:
						upload.status === "sealed" && upload.assetId === current.inputAssetId
							? current.inputAssetId
							: null,
				}),
			);
		}
		if (recovery.refreshCatalog)
			void queryClient.invalidateQueries({ queryKey: ["video-v1", "catalog", owner], exact: true });
	}
	function isCurrentOperation(token: VideoOperation) {
		return live.current && ownerEpoch.current === token.epoch && operation.current === token;
	}
	function finishOperation(token: VideoOperation) {
		// An earlier A request cannot release a later A request after A → B → A.
		if (!isCurrentOperation(token)) return;
		operation.current = null;
		setBusy(null);
	}
	async function generate() {
		if (
			operation.current ||
			!enabled ||
			confirmation ||
			uploading ||
			!ready ||
			draftOwner !== owner
		)
			return;
		const invalid = validateVideoDraft(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		const token = { epoch: ownerEpoch.current };
		operation.current = token;
		setBusy("quote");
		setError(null);
		setQuote(null);
		quotedRequest.current = null;
		const version = revision.current;
		const request = videoRequestFor(draft);
		const consentedCredits = previewCredits;
		const consentedPricing = JSON.stringify(previewPricing);
		try {
			const result = await videoApi.quote(request);
			if (isCurrentOperation(token) && version === revision.current) {
				setQuote(result);
				quotedRequest.current = { request, revision: version };
				if (Date.parse(result.expiresAt) <= Date.now()) {
					setError("quoteExpired");
					return;
				}
				// The visible backend price is the user's consent. A changed quote needs
				// a second explicit click; no preview request writes a quote record.
				if (
					result.credits === consentedCredits &&
					JSON.stringify(result.pricing ?? null) === consentedPricing
				) {
					await submit(token, createVideoConfirmation(request, result));
				} else {
					// Keep this quote for explicit confirmation, while replacing stale
					// owner-scoped previews before editing can reveal them again.
					await catalog.refetch();
				}
			}
		} catch (failure) {
			if (isCurrentOperation(token) && version === revision.current) handleFailure(failure);
		} finally {
			finishOperation(token);
		}
	}
	async function confirm() {
		if (
			operation.current ||
			!quote ||
			!registered ||
			draftOwner !== owner ||
			(!enabled && !confirmation)
		)
			return;
		if ((quoteExpired || Date.parse(quote.expiresAt) <= Date.now()) && !confirmation) {
			setError("quoteExpired");
			return;
		}
		const snapshot = quotedRequest.current;
		if (!confirmation && (!snapshot || snapshot.revision !== revision.current)) {
			setQuote(null);
			return;
		}
		const token = { epoch: ownerEpoch.current };
		operation.current = token;
		setBusy("create");
		setError(null);
		try {
			await submit(token, confirmation ?? createVideoConfirmation(snapshot!.request, quote));
		} finally {
			finishOperation(token);
		}
	}
	async function submit(token: VideoOperation, intent: VideoConfirmation) {
		if (!isCurrentOperation(token)) return;
		setBusy("create");
		// Persist before sending. Retrying a timeout or refreshing reuses this exact request/key.
		saveConfirmation(intent);
		try {
			const state = await videoApi.jobs.create(intent.input);
			if (!isCurrentOperation(token)) return;
			// Save the receipt before displaying it; an immediate refresh may beat router.replace.
			try {
				if (user?.id) sessionStorage.setItem(`video-v1:last-job:${user.id}`, state.jobId);
			} catch {
				/* History is the durable recovery path. */
			}
			saveConfirmation(null);
			setQuote(null);
			quotedRequest.current = null;
			setJobId(state.jobId);
			queryClient.setQueryData(["video-v1", "job", user?.id, state.jobId], state);
			void queryClient.invalidateQueries({ queryKey: ["video-v1", "history"] });
			void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
			window.history.replaceState(null, "", videoJobUrl(window.location.href, state.jobId));
		} catch (failure) {
			if (isCurrentOperation(token)) handleFailure(failure);
		}
	}
	const uploading = upload.status === "uploading" || upload.status === "sealing";
	const selectedModel = getVideoModel(draft.productKey)!;
	const previewCredits =
		registered && !catalog.isError ? videoSelectionCredits(draft, catalog.data) : null;
	const enabled = registered && previewCredits !== null;
	const previewPricing =
		registered && !catalog.isError ? videoSelectionPricing(draft, catalog.data) : null;

	const availability = JSON.stringify([enabled, previewCredits, previewPricing]);
	const previousAvailability = useRef(availability);
	useEffect(() => {
		if (previousAvailability.current === availability) return;
		previousAvailability.current = availability;
		// Pending submissions replay their immutable receipt even when new generation closes.
		if (!confirmation) {
			// A fresh quote may have triggered this catalog refresh. Retain it when
			// the refreshed selection agrees; only changed/unavailable prices invalidate it.
			if (
				quote &&
				enabled &&
				quotedRequest.current?.revision === revision.current &&
				quote.credits === previewCredits &&
				JSON.stringify(quote.pricing ?? null) === JSON.stringify(previewPricing)
			)
				return;
			revision.current++;
			setQuote(null);
			quotedRequest.current = null;
		}
	}, [availability, confirmation, enabled, previewCredits, previewPricing, quote]);
	const previousMode = useRef(workspace?.mode);
	useEffect(() => {
		if (previousMode.current === workspace?.mode) return;
		previousMode.current = workspace?.mode;
		// An accepted or uncertain create continues. Unsubmitted hidden quotes do not.
		if (!confirmation) {
			revision.current++;
			setQuote(null);
			quotedRequest.current = null;
		}
	}, [workspace?.mode, confirmation]);
	useGeneratorSignInDraft((destination) => {
		if (!registered) {
			sessionStorage.setItem(VIDEO_GUEST_HANDOFF_KEY, serializeVideoDraft(draft, "guest"));
			destination.searchParams.set("videoResume", "1");
		}
	});
	async function signIn() {
		try {
			const target = registered
				? `/create?mode=video${jobId ? `&videoJob=${encodeURIComponent(jobId)}` : ""}`
				: "/create?mode=video&videoResume=1";
			const destination = (await workspace?.prepareSignIn(target)) ?? target;
			window.location.assign(`/login?redirectTo=${encodeURIComponent(destination)}`);
		} catch {
			setStorageUnavailable(true);
		}
	}
	return (
		<VideoComposer
			draft={draft}
			upload={upload}
			models={catalog.data?.models ?? []}
			registered={registered}
			locked={!ready || draftOwner !== owner || Boolean(busy) || Boolean(confirmation)}
			uploading={uploading}
			ready={ready}
			enabled={enabled}
			busy={busy}
			quote={quote}
			previewCredits={previewCredits}
			previewPricing={previewPricing}
			quoteExpired={quoteExpired}
			confirmation={Boolean(confirmation)}
			error={error}
			jobId={registered ? jobId : null}
			maximumBytes={maximumBytes}
			storageUnavailable={storageUnavailable}
			catalogPending={registered && catalog.isPending}
			catalogError={registered && catalog.isError}
			catalogUnavailable={
				registered && !catalog.isPending && !catalog.isError && !catalog.data?.available
			}
			selectionUnavailable={
				registered && !catalog.isPending && catalog.data?.accessAllowed === true && !enabled
			}
			onChange={change}
			onGenerate={generate}
			onConfirm={confirm}
			onSignIn={signIn}
			onRetryCatalog={() => {
				void catalog.refetch();
			}}
			onSelectFile={(file) => {
				if (confirmation || busy || !selectedModel.modes.includes("image-to-video")) return;
				if (!registered) {
					void signIn();
					return;
				}
				change({ mode: "image-to-video", inputAssetId: null });
				void select(file);
			}}
			onRemoveFile={() => {
				clear();
				change({ inputAssetId: null });
			}}
		/>
	);
}

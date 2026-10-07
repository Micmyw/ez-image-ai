"use client";

import { useSession } from "@auth/hooks/use-session";
import { useGenerationMode, useGeneratorSignInDraft } from "@media/lib/generation-mode-context";
import { videoJobUrl, validVideoJobId } from "@media/lib/generator-navigation";
import { getVideoModel, validateVideoModelSelection } from "@repo/config/video-models";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { videoApi, type VideoQuote } from "./api";
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
	type VideoConfirmation,
	type VideoDraft,
	type VideoErrorKey,
} from "./model";
import { useVideoCatalog } from "./use-video";
import { useVideoUpload } from "./use-video-upload";
import { VideoComposer } from "./VideoComposer";

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
	const [storageUnavailable, setStorageUnavailable] = useState(false);
	const previousRouteJob = useRef(initialJobId);
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	const operation = useRef(false);
	const revision = useRef(0);
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
				setDraft(restoreVideoDraft(saved.input.request));
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
		setReady(true);
	}, [owner, registered, storageKey, initialJobId]);
	useEffect(() => {
		if (!ready) return;
		try {
			sessionStorage.setItem(videoDraftKey(owner), serializeVideoDraft(draft, owner));
		} catch {
			setStorageUnavailable(true);
		}
	}, [draft, owner, ready]);
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
		setDraft((current) => ({ ...current, inputAssetId: upload.assetId }));
		setQuote(null);
	}, [upload.assetId]);
	function change(patch: Partial<VideoDraft>) {
		if (confirmation || busy === "create") return;
		revision.current++;
		setDraft((current) => changeVideoDraft(current, patch));
		setQuote(null);
		setError(null);
	}
	function handleFailure(failure: unknown) {
		const recovery = getVideoFailureRecovery(failure);
		setError(recovery.reason);
		if (recovery.clearQuote) {
			saveConfirmation(null);
			setQuote(null);
		}
		if (recovery.refreshCatalog)
			void queryClient.invalidateQueries({ queryKey: ["video-v1", "catalog"] });
	}
	async function requestQuote() {
		if (operation.current || !enabled || confirmation) return;
		const invalid = validateVideoDraft(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		operation.current = true;
		setBusy("quote");
		setError(null);
		const version = revision.current;
		try {
			const result = await videoApi.quote(videoRequestFor(draft));
			if (live.current && version === revision.current) {
				setQuote(result);
				saveConfirmation(null);
			}
		} catch (failure) {
			if (live.current && version === revision.current) handleFailure(failure);
		} finally {
			operation.current = false;
			if (live.current) setBusy(null);
		}
	}
	async function confirm() {
		if (operation.current || !quote || !registered || (!enabled && !confirmation)) return;
		if ((quoteExpired || Date.parse(quote.expiresAt) <= Date.now()) && !confirmation) {
			setError("quoteExpired");
			return;
		}
		operation.current = true;
		setBusy("create");
		setError(null);
		const intent = confirmation ?? createVideoConfirmation(videoRequestFor(draft), quote);
		// Persist before sending. Retrying a timeout or refreshing reuses this exact request/key.
		saveConfirmation(intent);
		try {
			const state = await videoApi.jobs.create(intent.input);
			if (!live.current) return;
			// Save the receipt before displaying it; an immediate refresh may beat router.replace.
			try {
				if (user?.id) sessionStorage.setItem(`video-v1:last-job:${user.id}`, state.jobId);
			} catch {
				/* History is the durable recovery path. */
			}
			saveConfirmation(null);
			setQuote(null);
			setJobId(state.jobId);
			queryClient.setQueryData(["video-v1", "job", user?.id, state.jobId], state);
			void queryClient.invalidateQueries({ queryKey: ["video-v1", "history"] });
			void queryClient.invalidateQueries({ queryKey: ["media-credit-account"] });
			window.history.replaceState(null, "", videoJobUrl(window.location.href, state.jobId));
		} catch (failure) {
			if (live.current) handleFailure(failure);
		} finally {
			operation.current = false;
			if (live.current) setBusy(null);
		}
	}
	const uploading = upload.status === "uploading" || upload.status === "sealing";
	const selectedModel = getVideoModel(draft.productKey)!;
	const selectedAvailability = catalog.data?.models
		.find((model) => model.productKey === draft.productKey)
		?.options.find(
			(option) =>
				option.mode === draft.mode &&
				option.duration === draft.duration &&
				option.resolution === draft.resolution &&
				option.sound === draft.sound,
		);
	const enabled =
		registered &&
		catalog.data?.accessAllowed === true &&
		selectedAvailability?.available === true &&
		validateVideoModelSelection(draft);

	const availability = JSON.stringify([catalog.data?.accessAllowed, selectedAvailability]);
	const previousAvailability = useRef(availability);
	useEffect(() => {
		if (previousAvailability.current === availability) return;
		previousAvailability.current = availability;
		// Pending submissions replay their immutable receipt even when new generation closes.
		if (!confirmation) {
			revision.current++;
			setQuote(null);
		}
	}, [availability, confirmation]);
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
			locked={!ready || Boolean(busy) || Boolean(confirmation)}
			uploading={uploading}
			ready={ready}
			enabled={enabled}
			busy={busy}
			quote={quote}
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
			onQuote={requestQuote}
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

"use client";

import { useSession } from "@auth/hooks/use-session";
import { getVideoModel, validateVideoModelSelection } from "@repo/config/video-models";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { FilmIcon, HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { videoApi, type VideoQuote } from "./api";
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
import { VideoJob } from "./VideoJob";
import { VideoSettings } from "./VideoSettings";

export function VideoWorkspace({ initialJobId }: { initialJobId: string | null }) {
	const t = useTranslations("videoV1");
	const { user } = useSession();
	const router = useRouter();
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
	const operation = useRef(false);
	const revision = useRef(0);
	const restoredOwner = useRef<string | null>(null);
	const storageKey = user?.id ? `video-v1:confirmation:${user.id}` : null;
	function saveConfirmation(value: VideoConfirmation | null) {
		setConfirmation(value);
		if (!storageKey) return;
		try {
			if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
			else sessionStorage.removeItem(storageKey);
		} catch {
			/* The in-memory identity remains stable if browser storage is unavailable. */
		}
	}
	useEffect(() => {
		if (!user?.id || restoredOwner.current === user.id || !storageKey) return;
		restoredOwner.current = user.id;
		if (!initialJobId) {
			try {
				const latestJob = sessionStorage.getItem(`video-v1:last-job:${user.id}`);
				if (latestJob && /^[a-zA-Z0-9_-]{1,120}$/.test(latestJob)) setJobId(latestJob);
			} catch {
				/* Server history remains available without browser storage. */
			}
		}
		let saved: VideoConfirmation | null = null;
		try {
			saved = parseVideoConfirmation(sessionStorage.getItem(storageKey));
		} catch {
			/* Optional recovery storage. */
		}
		if (!saved) return;
		setDraft(restoreVideoDraft(saved.input.request));
		setConfirmation(saved);
		setQuote(saved.quote);
	}, [user?.id, storageKey, initialJobId]);
	useEffect(() => {
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
		const timer = setTimeout(() => setQuoteExpired(true), remaining);
		return () => clearTimeout(timer);
	}, [quote]);
	useEffect(() => {
		if (upload.assetId) setDraft((current) => ({ ...current, inputAssetId: upload.assetId }));
	}, [upload.assetId]);
	function change(patch: Partial<VideoDraft>) {
		revision.current++;
		setDraft((current) => changeVideoDraft(current, patch));
		setQuote(null);
		saveConfirmation(null);
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
		if (operation.current || !enabled) return;
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
			if (version === revision.current) {
				setQuote(result);
				saveConfirmation(null);
			}
		} catch (failure) {
			if (version === revision.current) handleFailure(failure);
		} finally {
			operation.current = false;
			setBusy(null);
		}
	}
	async function confirm() {
		if (operation.current || !quote || (!enabled && !confirmation)) return;
		if (quoteExpired && !confirmation) {
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
			router.replace(`/video?job=${encodeURIComponent(state.jobId)}`, { scroll: false });
		} catch (failure) {
			handleFailure(failure);
		} finally {
			operation.current = false;
			setBusy(null);
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
		catalog.data?.accessAllowed === true &&
		selectedAvailability?.available === true &&
		validateVideoModelSelection(draft);
	const promptLimit = selectedModel.maxPromptCodePoints;
	return (
		<div className="max-w-6xl space-y-6 mx-auto" data-test="video-workspace">
			<header className="gap-4 flex flex-wrap items-start justify-between">
				<div className="space-y-2">
					<p className="text-xs font-semibold tracking-widest text-violet-500 uppercase">
						{t("beta")}
					</p>
					<h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
					<p className="max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
				</div>
				<Button variant="secondary" render={(props) => <Link {...props} href="/video/history" />}>
					<HistoryIcon aria-hidden className="size-4" />
					{t("history")}
				</Button>
			</header>
			{catalog.isPending && <output>{t("loadingAccess")}</output>}
			{!catalog.isPending && !catalog.data?.available && (
				<output className="p-4 rounded-xl border">{t("disabled")}</output>
			)}
			<div className="gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] grid items-start">
				<section className="space-y-5 p-5 rounded-2xl border" aria-label={t("newVideo")}>
					<div className="gap-3 flex items-center">
						<FilmIcon aria-hidden className="size-5 text-violet-500" />
						<p className="text-sm font-medium">{selectedModel.label}</p>
					</div>
					<fieldset
						className="min-w-0 space-y-5"
						disabled={!catalog.data?.accessAllowed || Boolean(busy)}
					>
						<legend className="sr-only">{t("newVideo")}</legend>
						<VideoSettings
							draft={draft}
							models={catalog.data?.models ?? []}
							onChange={change}
							disabled={!catalog.data?.accessAllowed || Boolean(busy)}
						/>
						{draft.mode === "image-to-video" && (
							<div className="space-y-3">
								<label htmlFor="video-image" className="text-sm font-medium block">
									{t("reference")}
								</label>
								<p id="video-image-hint" className="text-xs text-muted-foreground">
									{t("imageHint", { max: Math.floor((maximumBytes / 1024 / 1024) * 10) / 10 })}
								</p>
								<input
									id="video-image"
									type="file"
									accept="image/jpeg,image/png,image/webp"
									aria-describedby="video-image-hint video-upload-status"
									className="text-sm file:mr-3 file:px-3 file:py-2 block w-full file:rounded-lg file:border file:bg-secondary"
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (!file) return;
										change({ inputAssetId: null });
										void select(file);
										event.target.value = "";
									}}
								/>
								{upload.preview && (
									<img
										src={upload.preview}
										alt={t("localPreview")}
										className="max-h-52 w-full rounded-lg object-contain"
									/>
								)}
								<div id="video-upload-status" aria-live="polite" className="space-y-2 text-sm">
									{upload.status === "uploading" && (
										<>
											<p>{t("uploading", { progress: upload.progress })}</p>
											<progress
												className="w-full"
												max={100}
												value={upload.progress}
												aria-label={t("uploadProgress")}
											/>
										</>
									)}
									{upload.status === "sealing" && <p>{t("sealing")}</p>}
									{draft.inputAssetId && <p>{t("sealed")}</p>}
									{upload.error && <p role="alert">{t(`errors.${upload.error}`)}</p>}
								</div>
								{(upload.preview || draft.inputAssetId) && (
									<Button
										variant="secondary"
										type="button"
										onClick={() => {
											clear();
											change({ inputAssetId: null });
										}}
									>
										{t("removeImage")}
									</Button>
								)}
							</div>
						)}
						<div className="space-y-2">
							<label htmlFor="video-prompt" className="text-sm font-medium">
								{t(draft.mode === "image-to-video" ? "motionPrompt" : "prompt")}
							</label>
							<Textarea
								id="video-prompt"
								rows={6}
								value={draft.prompt}
								aria-describedby="video-prompt-count"
								placeholder={t(
									draft.mode === "image-to-video" ? "motionPlaceholder" : "promptPlaceholder",
								)}
								onChange={(event) => change({ prompt: event.target.value })}
							/>
							<p id="video-prompt-count" className="text-xs text-right text-muted-foreground">
								{Array.from(draft.prompt.trim()).length} / {promptLimit}
							</p>
						</div>
					</fieldset>
					{!catalog.isPending && catalog.data?.accessAllowed && !enabled && (
						<output className="text-sm text-muted-foreground">{t("selectionUnavailable")}</output>
					)}
					{error && (
						<p role="alert" className="p-3 text-sm rounded-lg border border-destructive/40">
							{t(`errors.${error}`)}
						</p>
					)}
					{confirmation && (
						<output className="text-sm text-muted-foreground">{t("retrySameRequest")}</output>
					)}
					{quote ? (
						<div className="space-y-3 p-4 rounded-xl bg-secondary">
							<p className="font-semibold">{t("quote", { credits: quote.credits })}</p>
							<p className="text-xs text-muted-foreground">{t("quoteHint")}</p>
							{quoteExpired && !confirmation ? (
								<>
									<output>{t("errors.quoteExpired")}</output>
									<Button disabled={!enabled || Boolean(busy)} onClick={requestQuote}>
										{t("reviewPrice")}
									</Button>
								</>
							) : (
								<Button
									className="w-full"
									data-test="video-confirm"
									disabled={(!enabled && !confirmation) || Boolean(busy) || uploading}
									onClick={confirm}
								>
									{t(
										busy === "create"
											? "submitting"
											: confirmation
												? "confirmSameRequest"
												: "confirm",
										{ credits: quote.credits },
									)}
								</Button>
							)}
						</div>
					) : (
						<Button
							className="w-full"
							data-test="video-quote"
							disabled={!enabled || Boolean(busy) || uploading}
							onClick={requestQuote}
						>
							{t(busy === "quote" ? "quoting" : "reviewPrice")}
						</Button>
					)}
					<p className="text-xs leading-5 text-muted-foreground">{t("backgroundHint")}</p>
				</section>
				{jobId ? (
					<VideoJob key={jobId} jobId={jobId} />
				) : (
					<div className="min-h-64 gap-3 p-8 flex flex-col items-center justify-center rounded-2xl border border-dashed text-center text-muted-foreground">
						<FilmIcon aria-hidden className="size-10" />
						<p>{t("emptyResult")}</p>
						<p className="text-xs">{t("privateHint")}</p>
					</div>
				)}
			</div>
		</div>
	);
}

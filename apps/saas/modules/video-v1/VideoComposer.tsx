"use client";

import { ComposerHeader } from "@media/components/editor/ComposerHeader";
import { getVideoModel } from "@repo/config/video-models";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { FilmIcon, HistoryIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRef } from "react";

import type { VideoCatalog, VideoQuote } from "./api";
import type { VideoDraft, VideoErrorKey } from "./model";
import type { VideoUpload } from "./use-video-upload";
import { VideoJob } from "./VideoJob";
import { VideoSettings } from "./VideoSettings";

import "@media/components/editor/generation-composer.css";
import "./video-composer.css";

export function VideoComposer(props: {
	draft: VideoDraft;
	upload: VideoUpload;
	models: VideoCatalog["models"];
	registered: boolean;
	locked: boolean;
	uploading: boolean;
	ready: boolean;
	enabled: boolean;
	busy: "quote" | "create" | null;
	quote: VideoQuote | null;
	previewCredits: string | null;
	quoteExpired: boolean;
	confirmation: boolean;
	error: VideoErrorKey | null;
	jobId: string | null;
	maximumBytes: number;
	storageUnavailable: boolean;
	catalogPending: boolean;
	catalogError: boolean;
	catalogUnavailable: boolean;
	selectionUnavailable: boolean;
	onChange: (patch: Partial<VideoDraft>) => void;
	onGenerate: () => void;
	onConfirm: () => void;
	onSignIn: () => void;
	onRetryCatalog: () => void;
	onSelectFile: (file: File) => void;
	onRemoveFile: () => void;
}) {
	const t = useTranslations("videoV1");
	const { draft, upload, locked, quote, registered } = props;
	const fileInput = useRef<HTMLInputElement>(null);
	const model = getVideoModel(draft.productKey)!;
	const canReference = model.modes.includes("image-to-video");
	return (
		<div className="mt-6 min-w-0" data-test="video-workspace">
			<section
				className="studio-composer video-composer"
				data-composer-design="compact"
				data-composer-kind="video"
				data-test="video-composer"
				aria-label={t("newVideo")}
			>
				<ComposerHeader />
				<div className="video-composer-inputs">
					<div className="video-reference">
						<input
							ref={fileInput}
							id="video-image"
							type="file"
							accept="image/jpeg,image/png,image/webp"
							className="sr-only"
							tabIndex={-1}
							disabled={locked || !registered || !canReference}
							aria-label={t("reference")}
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) props.onSelectFile(file);
								event.target.value = "";
							}}
						/>
						<button
							type="button"
							className="video-upload"
							disabled={locked || !canReference}
							aria-label={t("addReference")}
							aria-describedby="video-image-hint video-upload-status"
							onClick={() => (registered ? fileInput.current?.click() : props.onSignIn())}
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => {
								event.preventDefault();
								const file = event.dataTransfer.files[0];
								if (file && !locked && canReference) props.onSelectFile(file);
							}}
						>
							{upload.preview ? (
								<img src={upload.preview} alt={t("localPreview")} />
							) : (
								<>
									<ImagePlusIcon aria-hidden size={22} />
									<span>{t(draft.inputAssetId ? "referenceReady" : "addReference")}</span>
								</>
							)}
						</button>
						{(upload.status !== "idle" ||
							draft.inputAssetId ||
							draft.mode === "image-to-video") && (
							<button
								type="button"
								className="video-remove"
								disabled={locked}
								aria-label={t("removeImage")}
								onClick={props.onRemoveFile}
							>
								<XIcon aria-hidden size={14} />
							</button>
						)}
						<p id="video-image-hint" className="sr-only">
							{t("imageHint", { max: Math.floor((props.maximumBytes / 1024 / 1024) * 10) / 10 })}
						</p>
					</div>
					<div className="video-prompt-field">
						<label htmlFor="video-prompt" className="sr-only">
							{t(draft.mode === "image-to-video" ? "motionPrompt" : "prompt")}
						</label>
						<Textarea
							id="video-prompt"
							rows={5}
							value={draft.prompt}
							disabled={locked}
							aria-describedby="video-prompt-count"
							aria-invalid={props.error === "promptRequired" || props.error === "promptLength"}
							placeholder={t(
								draft.mode === "image-to-video" ? "motionPlaceholder" : "promptPlaceholder",
							)}
							onChange={(event) => props.onChange({ prompt: event.target.value })}
						/>
						<span id="video-prompt-count" className="video-prompt-count">
							{Array.from(draft.prompt.trim()).length} / {model.maxPromptCodePoints}
							{draft.prompt.trim().length !== Array.from(draft.prompt.trim()).length && (
								<span className="block">
									{t("promptSafetyCount", { count: draft.prompt.trim().length })}
								</span>
							)}
						</span>
					</div>
				</div>
				<div id="video-upload-status" className="video-feedback" aria-live="polite">
					{upload.status === "uploading" && (
						<>
							<span>{t("uploading", { progress: upload.progress })}</span>
							<progress max={100} value={upload.progress} aria-label={t("uploadProgress")} />
						</>
					)}
					{upload.status === "sealing" && <span>{t("sealing")}</span>}
					{draft.inputAssetId && draft.mode === "image-to-video" && <span>{t("sealed")}</span>}
					{draft.mode === "image-to-video" && !draft.inputAssetId && !props.uploading && (
						<span>{t("referenceRequired")}</span>
					)}
					{upload.error && <p role="alert">{t(`errors.${upload.error}`)}</p>}
				</div>
				<div className="video-toolbar">
					<VideoSettings
						draft={draft}
						models={props.models}
						onChange={props.onChange}
						disabled={locked || props.uploading}
						preview={!registered}
					/>
					<div className="video-action">
						{!registered ? (
							<Button onClick={props.onSignIn} disabled={!props.ready}>
								{t("signInToGenerate")}
							</Button>
						) : quote && (!props.quoteExpired || props.confirmation) ? (
							<Button
								data-test="video-confirm"
								disabled={
									(!props.enabled && !props.confirmation) || Boolean(props.busy) || props.uploading
								}
								onClick={props.onConfirm}
							>
								{t(
									props.busy === "create"
										? "submitting"
										: props.confirmation
											? "confirmSameRequest"
											: "confirm",
									{ credits: quote.credits },
								)}
							</Button>
						) : (
							<Button
								data-test="video-generate"
								disabled={!props.ready || !props.enabled || Boolean(props.busy) || props.uploading}
								onClick={props.onGenerate}
							>
								{props.busy === "quote"
									? t("quoting")
									: props.previewCredits
										? t("generate", { credits: props.previewCredits })
										: t(props.catalogPending ? "priceLoading" : "priceUnavailable")}
							</Button>
						)}
					</div>
				</div>
				<div className="video-feedback" aria-live="polite">
					{props.catalogPending && <output>{t("loadingAccess")}</output>}
					{props.catalogError && (
						<button type="button" className="underline" onClick={props.onRetryCatalog}>
							{t("retryAccess")}
						</button>
					)}
					{props.catalogUnavailable && <output>{t("disabled")}</output>}
					{props.selectionUnavailable && <output>{t("selectionUnavailable")}</output>}
					{!registered && <p>{t("signInHint")}</p>}
					{props.error && <p role="alert">{t(`errors.${props.error}`)}</p>}
					{props.error === "unauthorized" && (
						<button type="button" onClick={props.onSignIn} className="underline">
							{t("signInToGenerate")}
						</button>
					)}
					{props.confirmation && <output>{t("retrySameRequest")}</output>}
					{quote && (
						<div data-test="video-price">
							<strong>{t("quote", { credits: quote.credits })}</strong>
							<p>{t("quoteHint")}</p>
							{!props.quoteExpired && !props.confirmation && <p>{t("priceChanged")}</p>}
							{props.quoteExpired && !props.confirmation && props.error !== "quoteExpired" && (
								<output>{t("errors.quoteExpired")}</output>
							)}
						</div>
					)}
					{props.storageUnavailable && <p>{t("draftStorageUnavailable")}</p>}
				</div>
			</section>
			<div className="video-workspace-meta">
				<p>{t("backgroundHint")}</p>
				<Link href="/video/history" className="video-history-link">
					<HistoryIcon aria-hidden size={15} />
					{t("history")}
				</Link>
			</div>
			{props.jobId ? (
				<div className="mt-5">
					<VideoJob key={props.jobId} jobId={props.jobId} />
				</div>
			) : (
				<div className="video-empty">
					<FilmIcon aria-hidden size={18} />
					<p>{t("emptyResult")}</p>
				</div>
			)}
		</div>
	);
}

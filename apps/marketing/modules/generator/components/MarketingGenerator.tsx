"use client";

import { marketingGrowthFunnel } from "@analytics";
import { config } from "@config";
import { LocaleLink } from "@i18n/routing";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Turnstile } from "@repo/ui/components/turnstile";
import { ArrowRightIcon, CheckIcon, Clock3Icon, DropletsIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ImageDropzone } from "../../image-editor/components/ImageDropzone";
import { PromptSuggestions } from "../../image-editor/components/PromptSuggestions";
import { SourcePreview } from "../../image-editor/components/SourcePreview";
import { MARKETING_IMAGE_CONTENT_TYPES, validateMarketingImageFile } from "../lib/draft-client";
import { getGuestCapability, type GuestCapabilitySnapshot } from "../lib/guest-capability";
import { uploadGuestDraft } from "../lib/guest-upload-client";
import type { MarketingImageModes } from "../lib/marketing-catalog";

const SUGGESTION_KEYS = ["background", "object", "color", "lighting"] as const;
const GUEST_TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY ?? null;
const LOCAL_TURNSTILE_EVIDENCE = "local-guest-upload";

interface MarketingGeneratorProps {
	capability?: GuestCapabilitySnapshot;
	/** Kept as a server-owned label fallback while public capability is loading. */
	modes?: MarketingImageModes;
}

export function MarketingGenerator({
	capability: initialCapability,
	modes,
}: MarketingGeneratorProps) {
	const t = useTranslations("home.generator");
	const [prompt, setPrompt] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string>();
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string>();
	const [previewUrl, setPreviewUrl] = useState<string>();
	const [capability, setCapability] = useState<GuestCapabilitySnapshot | null>(
		initialCapability ?? null,
	);
	const [capabilityFailed, setCapabilityFailed] = useState(false);
	const [uploadPercentage, setUploadPercentage] = useState<number>();
	const [turnstileToken, setTurnstileToken] = useState(
		GUEST_TURNSTILE_SITE_KEY ? "" : LOCAL_TURNSTILE_EVIDENCE,
	);
	const [turnstileResetKey, setTurnstileResetKey] = useState(0);
	const sourceUploadAttemptKey = useRef<string | null>(null);

	useEffect(() => {
		if (initialCapability || !config.saasUrl) return;
		let active = true;
		void getGuestCapability(config.saasUrl)
			.then((snapshot) => {
				if (active) setCapability(snapshot);
			})
			.catch(() => {
				if (active) setCapabilityFailed(true);
			});
		return () => {
			active = false;
		};
	}, [initialCapability]);

	useEffect(
		() => () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		},
		[previewUrl],
	);

	const maximumImageBytes = capability?.upload.maximumBytes ?? 10 * 1024 * 1024;
	const maximumImageMegabytes = maximumImageBytes / 1024 / 1024;
	const supportedMimeTypes = capability?.upload.mimeTypes ?? MARKETING_IMAGE_CONTENT_TYPES;
	const standardLabel = capability?.product.label ?? modes?.["image-fast"].label ?? "Standard Edit";
	const canSubmit = Boolean(config.saasUrl && capability?.enabled && turnstileToken);

	function chooseFile(nextFile: File) {
		try {
			validateMarketingImageFile(nextFile, maximumImageBytes);
			if (!supportedMimeTypes.includes(nextFile.type)) {
				throw new Error("SOURCE_IMAGE_TYPE_UNSUPPORTED");
			}
			const attemptKey = sourceUploadAttemptKey.current ?? createGrowthAttemptKey();
			sourceUploadAttemptKey.current = attemptKey;
			setFile(nextFile);
			setFileError(undefined);
			setSubmitError(undefined);
			setUploadPercentage(undefined);
			setPreviewUrl((current) => {
				if (current) URL.revokeObjectURL(current);
				return URL.createObjectURL(nextFile);
			});
			void marketingGrowthFunnel.sourceUploadCompleted(attemptKey, "image-fast");
		} catch (error) {
			setFile(null);
			setPreviewUrl(undefined);
			setFileError(fileErrorMessage(error, t, maximumImageMegabytes));
		}
	}

	function clearFile() {
		setFile(null);
		setFileError(undefined);
		setPreviewUrl(undefined);
		setUploadPercentage(undefined);
		sourceUploadAttemptKey.current = null;
	}

	function beginSourceUpload() {
		const attemptKey = createGrowthAttemptKey();
		sourceUploadAttemptKey.current = attemptKey;
		void marketingGrowthFunnel.sourceUploadStarted(attemptKey, "image-fast");
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!config.saasUrl || !capability?.enabled || !prompt.trim()) return;
		if (!file) {
			setFileError(t("fileErrors.required"));
			return;
		}
		if (!turnstileToken) {
			setSubmitError("turnstile");
			return;
		}

		setIsSubmitting(true);
		setSubmitError(undefined);
		const draftAttemptKey = createGrowthAttemptKey();
		try {
			validateMarketingImageFile(file, capability.upload.maximumBytes);
			const consumedTurnstileToken = turnstileToken;
			if (GUEST_TURNSTILE_SITE_KEY) resetChallenge();
			const handoff = await uploadGuestDraft({
				saasUrl: config.saasUrl,
				capabilityVersion: capability.version,
				file,
				prompt,
				turnstileToken: consumedTurnstileToken,
				onProgress: ({ percentage }) => setUploadPercentage(percentage),
			});
			await marketingGrowthFunnel.marketingDraftCreated(draftAttemptKey, "image-fast");
			await marketingGrowthFunnel.authHandoffStarted(draftAttemptKey, "image-fast");
			const { submitMarketingDraftHandoff } = await import("../lib/draft-client");
			submitMarketingDraftHandoff(handoff);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("SOURCE_IMAGE_")) {
				setFileError(fileErrorMessage(error, t, maximumImageMegabytes));
			} else {
				setSubmitError("upload");
			}
			setIsSubmitting(false);
			setUploadPercentage(undefined);
		}
	}

	function resetChallenge() {
		setTurnstileToken("");
		setTurnstileResetKey((value) => value + 1);
	}

	function handleChallengeError() {
		setSubmitError("turnstile");
		resetChallenge();
	}

	function handleChallengeToken(token: string) {
		setTurnstileToken(token);
		setSubmitError((current) => (current === "turnstile" ? undefined : current));
	}

	const suggestions = SUGGESTION_KEYS.map((key) => t(`suggestions.${key}`));

	return (
		<div className="mt-8 border-violet-200/70 bg-white/80 p-3 backdrop-blur-xl sm:p-4 relative overflow-hidden rounded-2xl border shadow-[0_30px_80px_-42px_rgba(67,56,202,0.58)]">
			<div
				className="mb-3 gap-1 border-slate-200/80 bg-slate-950 px-2 py-2 font-semibold text-slate-300 grid grid-cols-4 overflow-hidden rounded-xl border text-[0.65rem] tracking-[0.08em] uppercase"
				aria-hidden="true"
			>
				{[t("steps.idea"), t("steps.control"), standardLabel, t("steps.create")].map(
					(step, index) => (
						<span key={step} className="min-w-0 px-2 py-1.5 relative truncate">
							<span className="mr-1 text-violet-300">0{index + 1}</span>
							{step}
							{index < 3 && (
								<span className="right-0 h-4 bg-slate-700 absolute top-1/2 w-px -translate-y-1/2" />
							)}
						</span>
					),
				)}
				<span className="left-0 via-violet-400/70 motion-safe:animate-pulse pointer-events-none absolute top-[3.9rem] h-px w-1/3 bg-gradient-to-r from-transparent to-transparent motion-reduce:animate-none" />
			</div>

			<form onSubmit={(event) => void submit(event)}>
				<div className="gap-4 sm:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.32fr)] grid min-[1200px]:grid-cols-[minmax(15rem,0.72fr)_minmax(24rem,1.32fr)_minmax(17rem,0.78fr)] min-[1200px]:items-stretch">
					<div className="border-slate-200 bg-white p-4 order-1 rounded-2xl border">
						<ImageDropzone
							accept={supportedMimeTypes.join(",")}
							error={fileError}
							fileName={file?.name}
							hint={t("fileHint", { megabytes: maximumImageMegabytes })}
							label={t("reference")}
							onClear={clearFile}
							onFile={chooseFile}
							onUploadStarted={beginSourceUpload}
							removeLabel={t("removeImage")}
							uploadLabel={t("uploadLabel")}
						/>
					</div>

					<div className="border-slate-200 bg-white p-4 order-2 rounded-2xl border">
						<div className="mb-2 gap-3 flex items-end justify-between">
							<label htmlFor="marketing-prompt" className="text-sm font-semibold text-slate-950">
								{t("prompt")}
							</label>
							<span className="text-xs text-slate-500 tabular-nums">
								{t("characterCount", { count: prompt.length, maximum: 10_000 })}
							</span>
						</div>
						<Textarea
							id="marketing-prompt"
							name="prompt"
							rows={5}
							required
							maxLength={10_000}
							value={prompt}
							placeholder={t("placeholder")}
							className="min-h-32 border-slate-200 bg-slate-50/70 text-slate-950 focus-visible:border-violet-500 focus-visible:ring-violet-500 resize-y"
							onChange={(event) => setPrompt(event.target.value)}
						/>
						<div className="mt-3">
							<PromptSuggestions
								label={t("suggestionsLabel")}
								onSelect={setPrompt}
								suggestions={suggestions}
							/>
						</div>
					</div>

					<div className="border-violet-200 bg-violet-50/70 p-4 sm:max-[1199px]:col-span-2 order-3 flex flex-col rounded-2xl border">
						<div className="space-y-2">
							<div className="min-h-11 gap-3 border-violet-300 bg-white px-3 py-2 flex items-center justify-between rounded-xl border">
								<span className="gap-2 text-sm font-bold text-slate-950 flex items-center">
									<span className="size-6 bg-violet-600 text-white grid place-items-center rounded-lg">
										<CheckIcon className="size-3.5" aria-hidden="true" />
									</span>
									{standardLabel}
								</span>
								<span className="text-xs font-semibold text-violet-700">{t("oneOutput")}</span>
							</div>
							<LocaleLink
								href="/pricing"
								className="min-h-11 gap-3 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-violet-300 hover:text-violet-800 focus-visible:outline-violet-600 flex items-center justify-between rounded-xl border transition focus-visible:outline-2 focus-visible:outline-offset-2"
							>
								{t("qualityCta")}
							</LocaleLink>
						</div>
						<div className="mt-4 space-y-2 text-xs leading-5 text-slate-600">
							<p className="gap-2 flex items-start">
								<Clock3Icon
									className="mt-0.5 size-3.5 text-violet-600 shrink-0"
									aria-hidden="true"
								/>
								{t("freeQueue")}
							</p>
							<p className="gap-2 flex items-start">
								<DropletsIcon
									className="mt-0.5 size-3.5 text-violet-600 shrink-0"
									aria-hidden="true"
								/>
								{t("temporaryResult")}
							</p>
						</div>
						{GUEST_TURNSTILE_SITE_KEY && (
							<Turnstile
								siteKey={GUEST_TURNSTILE_SITE_KEY}
								action="guest_upload"
								ariaLabel={t("states.challenge")}
								className="mt-4"
								resetKey={turnstileResetKey}
								onToken={handleChallengeToken}
								onError={handleChallengeError}
								onExpire={resetChallenge}
							/>
						)}
						<Button
							type="submit"
							className="mt-4 min-h-12 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 focus-visible:ring-indigo-600 w-full min-[1200px]:mt-auto"
							size="lg"
							variant="primary"
							loading={isSubmitting}
							disabled={!canSubmit || isSubmitting}
						>
							{t("offer")}
							<ArrowRightIcon className="ml-1 size-4" aria-hidden="true" />
						</Button>
						<p className="mt-2 gap-2 text-xs font-medium text-slate-600 flex items-center justify-center text-center">
							<LockKeyholeIcon className="size-3.5 text-emerald-600" aria-hidden="true" />
							{t("noSignUp")}
						</p>
					</div>
				</div>

				<p className="mt-3 border-slate-200 bg-white/70 px-4 py-3 text-xs leading-5 text-slate-600 rounded-xl border">
					{t("temporarySessionDisclosure")}
				</p>

				{typeof uploadPercentage === "number" && (
					<div className="mt-3" aria-live="polite">
						<p className="text-sm font-medium text-slate-700">
							{t("states.uploading", { percentage: uploadPercentage })}
						</p>
						<div
							className="mt-2 h-1.5 bg-slate-200 overflow-hidden rounded-full"
							aria-hidden="true"
						>
							<div
								className="bg-violet-600 h-full rounded-full transition-[width] motion-reduce:transition-none"
								style={{ width: `${uploadPercentage}%` }}
							/>
						</div>
					</div>
				)}

				{(capabilityFailed || (capability && !capability.enabled)) && (
					<Alert className="mt-3" aria-live="polite">
						<AlertDescription>{t("states.unavailable")}</AlertDescription>
					</Alert>
				)}
				{!capability && !capabilityFailed && (
					<output className="mt-3 text-sm text-slate-600 block">
						{t("states.loadingCapability")}
					</output>
				)}
				{submitError && (
					<Alert className="mt-3" variant="error" role="alert">
						<AlertDescription>
							{t(`errors.${submitError}`)}
							{submitError === "turnstile" && GUEST_TURNSTILE_SITE_KEY && (
								<button
									type="button"
									className="ml-2 font-semibold underline underline-offset-2"
									onClick={resetChallenge}
								>
									{t("retryChallenge")}
								</button>
							)}
						</AlertDescription>
					</Alert>
				)}
			</form>

			<div className="mt-4">
				<SourcePreview
					caption={t("previewCaption")}
					fileName={file?.name}
					placeholderAlt={t("previewPlaceholderAlt")}
					previewAlt={t("previewAlt", { fileName: file?.name ?? "" })}
					previewUrl={previewUrl}
					privateLabel={t("privateLabel")}
				/>
			</div>
		</div>
	);
}

function fileErrorMessage(
	error: unknown,
	t: ReturnType<typeof useTranslations>,
	maximumImageMegabytes: number,
): string {
	if (!(error instanceof Error)) return t("fileErrors.read");
	if (error.message === "SOURCE_IMAGE_EMPTY") return t("fileErrors.empty");
	if (error.message === "SOURCE_IMAGE_TOO_LARGE") {
		return t("fileErrors.size", { megabytes: maximumImageMegabytes });
	}
	if (error.message === "SOURCE_IMAGE_TYPE_UNSUPPORTED") return t("fileErrors.type");
	return t("fileErrors.read");
}

function createGrowthAttemptKey(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

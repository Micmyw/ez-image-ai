"use client";

import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Turnstile } from "@repo/ui/components/turnstile";
import { trackBrowserGrowthEvent } from "@repo/utils";
import {
	ArrowRightIcon,
	CheckIcon,
	ImageIcon,
	LockKeyholeIcon,
	SparklesIcon,
	UploadCloudIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import {
	type ChangeEvent,
	type DragEvent,
	type FormEvent,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	getGuestCapability,
	type GuestCapabilitySnapshot,
	type GuestProductKey,
	LANDING_IMAGE_CONTENT_TYPES,
	submitGuestDraftHandoff,
	uploadGuestDraft,
	validateLandingImageFile,
} from "../lib/guest-draft-client";
import {
	landingDisabledReason,
	type LandingGeneratorStage,
	resolveLandingProductSelection,
} from "../lib/landing-generator-workflow";
import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../lib/prompt-selection";

const GUEST_TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY ?? null;
const LOCAL_TURNSTILE_EVIDENCE = "local-guest-upload";
const SUGGESTION_KEYS = ["background", "object", "color", "lighting"] as const;

export function LandingGenerator() {
	const t = useTranslations("home.generator");
	const inputRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const [capability, setCapability] = useState<GuestCapabilitySnapshot | null>(null);
	const [capabilityFailed, setCapabilityFailed] = useState(false);
	const [selectedProductKey, setSelectedProductKey] = useState<GuestProductKey | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string>();
	const [previewUrl, setPreviewUrl] = useState<string>();
	const [prompt, setPrompt] = useState("");
	const [submitError, setSubmitError] = useState<"turnstile" | "upload">();
	const [uploadPercentage, setUploadPercentage] = useState<number>();
	const [stage, setStage] = useState<LandingGeneratorStage>("checking");
	const [isDragging, setIsDragging] = useState(false);
	const [turnstileToken, setTurnstileToken] = useState(
		GUEST_TURNSTILE_SITE_KEY ? "" : LOCAL_TURNSTILE_EVIDENCE,
	);
	const [turnstileResetKey, setTurnstileResetKey] = useState(0);
	const uploadAttemptKey = useRef<string | null>(null);

	useEffect(() => {
		let active = true;
		void trackBrowserGrowthEvent(
			{ name: "landing_viewed", properties: { status: "viewed" } },
			{ dedupeKey: "landing" },
		);
		void getGuestCapability()
			.then((snapshot) => {
				if (!active) return;
				setCapability(snapshot);
				setSelectedProductKey((current) =>
					resolveLandingProductSelection(snapshot.products, current),
				);
				setStage("ready");
			})
			.catch(() => {
				if (!active) return;
				setCapabilityFailed(true);
				setStage("failed");
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		function selectExamplePrompt(event: Event) {
			const detail = (event as CustomEvent<LandingPromptSelectedDetail>).detail;
			if (!detail?.prompt.trim()) return;

			setPrompt(detail.prompt);
			setSubmitError(undefined);
			requestAnimationFrame(() => {
				promptRef.current?.focus({ preventScroll: true });
				const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				document.getElementById("image-editor")?.scrollIntoView({
					behavior: prefersReducedMotion ? "auto" : "smooth",
					block: "start",
				});
			});
			void trackBrowserGrowthEvent(
				{ name: "example_prompt_selected", properties: { status: "selected" } },
				{ dedupeKey: "showcase-prompt" },
			);
		}

		window.addEventListener(LANDING_PROMPT_SELECTED_EVENT, selectExamplePrompt);
		return () => window.removeEventListener(LANDING_PROMPT_SELECTED_EVENT, selectExamplePrompt);
	}, []);

	useEffect(
		() => () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		},
		[previewUrl],
	);

	const maximumBytes = capability?.upload.maximumBytes ?? 10 * 1024 * 1024;
	const maximumMegabytes = maximumBytes / 1024 / 1024;
	const supportedMimeTypes = capability?.upload.mimeTypes ?? LANDING_IMAGE_CONTENT_TYPES;
	const selectedProduct =
		capability?.products.find((product) => product.key === selectedProductKey) ?? null;
	const disabledReason = landingDisabledReason({
		stage,
		capabilityEnabled: Boolean(capability?.enabled),
		productSelected: Boolean(selectedProduct),
		hasSource: Boolean(file),
		prompt,
		turnstileReady: Boolean(turnstileToken),
	});
	const isBusy = disabledReason === "busy";
	const canSubmit = disabledReason === null;

	function beginUpload() {
		const attemptKey = createAttemptKey();
		uploadAttemptKey.current = attemptKey;
		if (!selectedProductKey) return;
		void trackBrowserGrowthEvent(
			{
				name: "source_upload_started",
				properties: { productKey: selectedProductKey, status: "started" },
			},
			{ dedupeKey: `source-upload-started:${attemptKey}` },
		);
	}

	function chooseFile(nextFile: File) {
		try {
			validateLandingImageFile(nextFile, maximumBytes);
			if (!supportedMimeTypes.includes(nextFile.type)) {
				throw new Error("SOURCE_IMAGE_TYPE_UNSUPPORTED");
			}
			const attemptKey = uploadAttemptKey.current ?? createAttemptKey();
			uploadAttemptKey.current = attemptKey;
			setFile(nextFile);
			setFileError(undefined);
			setSubmitError(undefined);
			setUploadPercentage(undefined);
			setPreviewUrl((current) => {
				if (current) URL.revokeObjectURL(current);
				return URL.createObjectURL(nextFile);
			});
			if (selectedProductKey) {
				void trackBrowserGrowthEvent(
					{
						name: "source_upload_completed",
						properties: { productKey: selectedProductKey, status: "completed" },
					},
					{ dedupeKey: `source-upload-completed:${attemptKey}` },
				);
			}
		} catch (error) {
			setFileError(fileErrorMessage(error, t, maximumMegabytes));
		}
	}

	function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
		const nextFile = event.target.files?.[0];
		if (nextFile) chooseFile(nextFile);
		event.target.value = "";
	}

	function handleDragOver(event: DragEvent<HTMLButtonElement>) {
		event.preventDefault();
		if (isBusy) return;
		event.dataTransfer.dropEffect = "copy";
		setIsDragging(true);
	}

	function handleDrop(event: DragEvent<HTMLButtonElement>) {
		event.preventDefault();
		setIsDragging(false);
		if (isBusy) return;
		const nextFile = event.dataTransfer.files.item(0);
		if (!nextFile) return;
		beginUpload();
		chooseFile(nextFile);
	}

	function clearFile() {
		setFile(null);
		setFileError(undefined);
		setPreviewUrl((current) => {
			if (current) URL.revokeObjectURL(current);
			return undefined;
		});
		setUploadPercentage(undefined);
		setSubmitError(undefined);
		uploadAttemptKey.current = null;
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabledReason === "source") {
			setFileError(t("fileErrors.required"));
			return;
		}
		if (disabledReason === "verification") {
			setSubmitError("turnstile");
			return;
		}
		if (disabledReason || !capability?.enabled || !file || !selectedProduct || !turnstileToken) {
			return;
		}

		setStage("preparing");
		setSubmitError(undefined);
		setUploadPercentage(undefined);
		const attemptKey = createAttemptKey();
		try {
			validateLandingImageFile(file, capability.upload.maximumBytes);
			const consumedTurnstileToken = turnstileToken;
			if (GUEST_TURNSTILE_SITE_KEY) resetChallenge();
			const handoff = await uploadGuestDraft({
				capabilityVersion: capability.version,
				productKey: selectedProduct.key,
				file,
				prompt,
				turnstileToken: consumedTurnstileToken,
				onStage: (nextStage) => {
					setStage(nextStage);
					if (nextStage === "uploading") setUploadPercentage(0);
				},
				onProgress: ({ percentage }) => setUploadPercentage(percentage),
			});
			setStage("handoff");
			await trackBrowserGrowthEvent(
				{
					name: "marketing_draft_created",
					properties: { productKey: selectedProduct.key, status: "created" },
				},
				{ dedupeKey: `marketing-draft-created:${attemptKey}` },
			);
			await trackBrowserGrowthEvent(
				{
					name: "auth_handoff_started",
					properties: { productKey: selectedProduct.key, status: "started" },
				},
				{ dedupeKey: `auth-handoff-started:${attemptKey}` },
			);
			await nextAnimationFrame();
			submitGuestDraftHandoff(handoff);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("SOURCE_IMAGE_")) {
				setFileError(fileErrorMessage(error, t, maximumMegabytes));
			} else {
				setSubmitError("upload");
			}
			setStage("failed");
			setUploadPercentage(undefined);
		}
	}

	function resetChallenge() {
		setTurnstileToken("");
		setTurnstileResetKey((value) => value + 1);
	}

	const suggestions = SUGGESTION_KEYS.map((key) => t(`suggestions.${key}`));
	const selectedModeKey = selectedProductKey === "image-quality" ? "quality" : "standard";
	const selectedProductLabel = selectedProduct ? t(`modes.${selectedModeKey}.label`) : "";
	const actionLabel =
		stage === "failed" && selectedProduct
			? t("actions.retry", { product: selectedProductLabel })
			: selectedProduct?.accessHint === "paid-account"
				? t("actions.quality")
				: t("actions.standard");
	const stageLabel =
		stage === "uploading"
			? t("states.uploading", { percentage: uploadPercentage ?? 0 })
			: t(`states.${stage}`);

	return (
		<div className="mt-8 border-white/10 p-3 backdrop-blur-xl sm:p-5 overflow-hidden rounded-[1.75rem] border bg-[#171321]/88 shadow-[0_40px_110px_-48px_rgba(0,0,0,0.95),0_24px_70px_-48px_rgba(108,77,255,0.9),inset_0_1px_0_rgba(255,255,255,0.08)]">
			<form onSubmit={(event) => void submit(event)}>
				<div className="gap-4 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(22rem,1.25fr)_minmax(15rem,0.7fr)] grid">
					<section className="border-white/10 bg-white/[0.045] p-4 rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
						<div className="mb-2 gap-3 flex items-center justify-between">
							<label htmlFor="landing-source-image" className="text-sm font-semibold text-white">
								{t("reference")}
							</label>
							{file && (
								<button
									type="button"
									className="min-h-11 gap-1 text-xs font-semibold text-slate-400 hover:text-white focus-visible:outline-violet-300 inline-flex items-center rounded-lg transition focus-visible:outline-2 focus-visible:outline-offset-2"
									onClick={clearFile}
									disabled={isBusy}
								>
									<XIcon className="size-3.5" aria-hidden="true" />
									{t("removeImage")}
								</button>
							)}
						</div>
						<button
							type="button"
							className={`group min-h-48 bg-black/20 p-4 focus-visible:outline-violet-300 relative flex w-full items-center justify-center overflow-hidden rounded-xl border border-dashed text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait ${
								isDragging
									? "border-violet-200 bg-violet-400/15"
									: "border-violet-300/35 hover:border-violet-300/65 hover:bg-violet-400/[0.08]"
							}`}
							aria-label={file ? t("replaceImage") : t("uploadLabel")}
							disabled={isBusy}
							onClick={() => {
								beginUpload();
								inputRef.current?.click();
							}}
							onDragEnter={(event) => {
								event.preventDefault();
								if (!isBusy) setIsDragging(true);
							}}
							onDragOver={handleDragOver}
							onDragLeave={() => setIsDragging(false)}
							onDrop={handleDrop}
						>
							{previewUrl ? (
								<>
									<Image
										src={previewUrl}
										alt={t("previewAlt", { fileName: file?.name ?? "" })}
										fill
										unoptimized
										className="object-cover"
									/>
									<span className="inset-x-3 bottom-3 min-h-11 bg-slate-950/80 px-3 py-2 text-xs font-semibold text-white backdrop-blur-sm absolute flex items-center justify-center rounded-lg">
										{t("replaceImage")}
									</span>
								</>
							) : (
								<span className="gap-2 flex flex-col items-center">
									<span className="size-12 bg-violet-300/10 text-violet-200 ring-violet-300/20 group-hover:-translate-y-0.5 group-hover:bg-violet-300/15 grid place-items-center rounded-2xl ring-1 transition motion-reduce:transform-none">
										<UploadCloudIcon className="size-5" aria-hidden="true" />
									</span>
									<span className="text-sm font-semibold text-white">{t("uploadLabel")}</span>
									<span className="text-xs text-slate-400">
										{t("fileHint", { megabytes: maximumMegabytes })}
									</span>
								</span>
							)}
						</button>
						<input
							ref={inputRef}
							id="landing-source-image"
							type="file"
							accept={supportedMimeTypes.join(",")}
							aria-label={t("reference")}
							aria-invalid={Boolean(fileError)}
							disabled={isBusy}
							className="sr-only"
							onChange={handleFileChange}
						/>
						{fileError && (
							<p className="mt-2 text-sm text-red-300" role="alert">
								{fileError}
							</p>
						)}
					</section>

					<section className="border-white/10 bg-white/[0.045] p-4 rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
						<div className="mb-2 gap-3 flex items-end justify-between">
							<label htmlFor="landing-edit-prompt" className="text-sm font-semibold text-white">
								{t("prompt")}
							</label>
							<span className="text-xs text-slate-400 tabular-nums">
								{t("characterCount", { count: prompt.length, maximum: 10_000 })}
							</span>
						</div>
						<Textarea
							ref={promptRef}
							id="landing-edit-prompt"
							rows={7}
							required
							maxLength={10_000}
							value={prompt}
							disabled={isBusy}
							placeholder={t("placeholder")}
							className="min-h-48 border-white/10 bg-black/20 text-white placeholder:text-slate-500 focus-visible:border-violet-400 focus-visible:ring-violet-400 resize-y"
							onChange={(event) => setPrompt(event.target.value)}
						/>
						<div className="mt-3">
							<p className="mb-2 text-xs font-semibold text-slate-400 tracking-[0.12em] uppercase">
								{t("suggestionsLabel")}
							</p>
							<div className="gap-2 flex flex-wrap">
								{suggestions.map((suggestion) => (
									<button
										key={suggestion}
										type="button"
										disabled={isBusy}
										className="min-h-11 border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-300 hover:border-violet-300/40 hover:bg-violet-300/10 hover:text-white focus-visible:outline-violet-300 rounded-full border text-left transition focus-visible:outline-2 focus-visible:outline-offset-2"
										onClick={() => {
											setPrompt(suggestion);
											void trackBrowserGrowthEvent(
												{ name: "example_prompt_selected", properties: { status: "selected" } },
												{ dedupeKey: "example-prompt" },
											);
										}}
									>
										{suggestion}
									</button>
								))}
							</div>
						</div>
					</section>

					<aside className="border-violet-300/20 p-4 min-w-0 flex flex-col rounded-2xl border bg-[#211831]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
						<fieldset disabled={isBusy}>
							<legend className="text-sm font-semibold text-white">{t("modes.legend")}</legend>
							<div className="mt-2 gap-2 sm:grid-cols-2 lg:grid-cols-1 grid">
								{capability?.products.map((product) => {
									const modeKey = product.key === "image-quality" ? "quality" : "standard";
									const selected = product.key === selectedProductKey;
									return (
										<label
											key={product.key}
											className={`min-w-0 p-3 pl-9 focus-within:ring-violet-200 relative cursor-pointer rounded-xl border transition focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-[#211831] focus-within:outline-none ${
												selected
													? "border-violet-300 bg-violet-400/15"
													: "border-white/10 bg-black/20 hover:border-violet-300/45"
											}`}
										>
											<input
												type="radio"
												name="landing-product"
												value={product.key}
												checked={selected}
												className="left-3 top-3.5 size-4 accent-violet-500 absolute z-10"
												onChange={() => {
													setSelectedProductKey(product.key);
													setSubmitError(undefined);
												}}
											/>
											<span className="gap-2 min-w-0 flex items-start justify-between">
												<span className="text-sm font-bold text-white">
													{t(`modes.${modeKey}.label`)}
												</span>
												<span className="font-semibold text-violet-100 bg-violet-300/10 px-2 py-1 shrink-0 rounded-full text-[0.68rem]">
													{t(`modes.${modeKey}.badge`)}
												</span>
											</span>
											<span className="mt-1 text-xs leading-5 text-slate-300 block">
												{t(`modes.${modeKey}.description`)}
											</span>
											<span className="mt-2 gap-2 text-slate-400 flex items-center justify-between text-[0.7rem]">
												<span>{t(`modes.${modeKey}.access`)}</span>
												<span className="font-semibold text-slate-200 shrink-0">
													{t("modes.credits", { credits: Number(product.credits) })}
												</span>
											</span>
										</label>
									);
								})}
							</div>
						</fieldset>
						<div className="min-h-11 gap-3 border-white/10 bg-black/20 px-3 py-2 flex items-center justify-between rounded-xl border">
							<span className="gap-2 text-sm font-bold text-white flex items-center">
								<span className="size-6 text-white grid place-items-center rounded-lg bg-[#6c4dff]">
									<CheckIcon className="size-3.5" aria-hidden="true" />
								</span>
								{selectedProductLabel || t("modes.selectionPending")}
							</span>
							<span className="text-xs font-semibold text-violet-200">{t("oneOutput")}</span>
						</div>
						<div className="mt-4 space-y-2 text-xs leading-5 text-slate-300">
							<p className="gap-2 flex items-start">
								<SparklesIcon
									className="mt-0.5 size-3.5 text-violet-300 shrink-0"
									aria-hidden="true"
								/>
								{selectedProduct?.accessHint === "paid-account"
									? t("qualityAccess")
									: t("freeQueue")}
							</p>
							<p className="gap-2 flex items-start">
								<LockKeyholeIcon
									className="mt-0.5 size-3.5 text-emerald-300 shrink-0"
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
								onToken={(token) => {
									setSubmitError(undefined);
									setTurnstileToken(token);
								}}
								onError={() => {
									setSubmitError("turnstile");
									resetChallenge();
								}}
								onExpire={resetChallenge}
							/>
						)}
						<Button
							type="submit"
							variant="primary"
							size="lg"
							className="mt-5 min-h-12 text-white focus-visible:outline-violet-200 lg:mt-auto w-full bg-[#6c4dff] shadow-[0_14px_34px_-16px_rgba(108,77,255,0.95)] hover:bg-[#7d63ff]"
							disabled={!canSubmit}
							loading={isBusy}
							aria-describedby="landing-action-guidance landing-stage-status"
						>
							{actionLabel}
							<ArrowRightIcon className="ml-1 size-4" aria-hidden="true" />
						</Button>
						<p className="mt-2 gap-2 text-xs font-medium text-slate-300 flex items-center justify-center text-center">
							<ImageIcon className="size-3.5 text-emerald-300" aria-hidden="true" />
							{selectedProduct?.accessHint === "paid-account" ? t("paidSignIn") : t("noSignUp")}
						</p>
					</aside>
				</div>

				<output
					id="landing-stage-status"
					data-test="landing-stage"
					data-stage={stage}
					className="mt-3 text-sm font-medium text-slate-200 block"
					aria-live="polite"
				>
					{stageLabel}
				</output>
				{stage === "uploading" && typeof uploadPercentage === "number" && (
					<div className="mt-2">
						<div className="mt-2 h-1.5 bg-white/10 overflow-hidden rounded-full" aria-hidden="true">
							<div
								className="bg-violet-400 h-full rounded-full transition-[width] motion-reduce:transition-none"
								style={{ width: `${uploadPercentage}%` }}
							/>
						</div>
					</div>
				)}
				{disabledReason && disabledReason !== "busy" && (
					<p id="landing-action-guidance" className="mt-2 text-sm text-amber-200">
						{t(`guidance.${disabledReason}`)}
					</p>
				)}

				{(capabilityFailed || (capability && !capability.enabled)) && (
					<Alert className="mt-3 border-white/10 bg-white/[0.05] text-slate-200" aria-live="polite">
						<AlertDescription>{t("states.unavailable")}</AlertDescription>
					</Alert>
				)}
				{!capability && !capabilityFailed && (
					<output className="mt-3 text-sm text-slate-300 block">
						{t("states.loadingCapability")}
					</output>
				)}
				{submitError && (
					<Alert
						className="mt-3 border-red-400/25 bg-red-950/60 text-red-200"
						variant="error"
						role="alert"
					>
						<AlertDescription>{t(`errors.${submitError}`)}</AlertDescription>
					</Alert>
				)}
			</form>
		</div>
	);
}

function fileErrorMessage(
	error: unknown,
	t: ReturnType<typeof useTranslations>,
	maximumMegabytes: number,
): string {
	if (!(error instanceof Error)) return t("fileErrors.read");
	if (error.message === "SOURCE_IMAGE_EMPTY") return t("fileErrors.empty");
	if (error.message === "SOURCE_IMAGE_TYPE_UNSUPPORTED") return t("fileErrors.type");
	if (error.message === "SOURCE_IMAGE_TOO_LARGE") {
		return t("fileErrors.size", { megabytes: maximumMegabytes });
	}
	return t("fileErrors.read");
}

function createAttemptKey(): string {
	return typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function nextAnimationFrame(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

"use client";

import { ImageOutputSettings } from "@media/components/ImageOutputSettings";
import type { ImageAspectRatio } from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Turnstile } from "@repo/ui/components/turnstile";
import { trackBrowserGrowthEvent } from "@repo/utils";
import {
	ArrowRightIcon,
	ArrowUpIcon,
	CheckIcon,
	ChevronDownIcon,
	ImagePlusIcon,
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
	resolveLandingAspectRatioSelection,
	resolveLandingProductSelection,
} from "../lib/landing-generator-workflow";
import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../lib/prompt-selection";

const GUEST_TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY ?? null;
const LOCAL_TURNSTILE_EVIDENCE = "local-guest-upload";

export function LandingGenerator() {
	const t = useTranslations("home.generator");
	const generatorRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const floatingPromptRef = useRef<HTMLTextAreaElement>(null);
	const floatingExpandRef = useRef<HTMLButtonElement>(null);
	const floatingDockRef = useRef<HTMLElement>(null);
	const [capability, setCapability] = useState<GuestCapabilitySnapshot | null>(null);
	const [capabilityRequestKey, setCapabilityRequestKey] = useState(0);
	const [selectedProductKey, setSelectedProductKey] = useState<GuestProductKey | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string>();
	const [previewUrl, setPreviewUrl] = useState<string>();
	const [prompt, setPrompt] = useState("");
	const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("auto");
	const [submitError, setSubmitError] = useState<"turnstile" | "upload">();
	const [uploadPercentage, setUploadPercentage] = useState<number>();
	const [stage, setStage] = useState<LandingGeneratorStage>("checking");
	const [isDragging, setIsDragging] = useState(false);
	const [isDockVisible, setIsDockVisible] = useState(false);
	const [isDockExpanded, setIsDockExpanded] = useState(false);
	const [turnstileToken, setTurnstileToken] = useState(
		GUEST_TURNSTILE_SITE_KEY ? "" : LOCAL_TURNSTILE_EVIDENCE,
	);
	const [turnstileResetKey, setTurnstileResetKey] = useState(0);
	const uploadAttemptKey = useRef<string | null>(null);

	useEffect(() => {
		let active = true;
		setStage("checking");
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
				setCapability(null);
				setSelectedProductKey(null);
				setStage("failed");
			});
		return () => {
			active = false;
		};
	}, [capabilityRequestKey]);

	useEffect(() => {
		const generator = generatorRef.current;
		if (!generator) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				const hasPassedEditor = !entry.isIntersecting && entry.boundingClientRect.bottom <= 72;
				const dockContainsFocus =
					floatingDockRef.current?.contains(document.activeElement) ?? false;
				setIsDockVisible(hasPassedEditor);
				if (!hasPassedEditor) {
					setIsDockExpanded(false);
					if (dockContainsFocus) {
						requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
					}
				}
			},
			{ rootMargin: "-72px 0px 0px", threshold: 0 },
		);
		observer.observe(generator);

		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!isDockExpanded) return;

		const frame = requestAnimationFrame(() => {
			floatingPromptRef.current?.focus({ preventScroll: true });
		});
		function collapseOnEscape(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setIsDockExpanded(false);
			requestAnimationFrame(() => floatingExpandRef.current?.focus());
		}
		document.addEventListener("keydown", collapseOnEscape);

		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("keydown", collapseOnEscape);
		};
	}, [isDockExpanded]);

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
	const capabilityUsable = Boolean(capability?.enabled && capability.products.length > 0);
	useEffect(() => {
		setAspectRatio(
			(current) => resolveLandingAspectRatioSelection(selectedProduct, current) ?? "auto",
		);
	}, [selectedProduct]);
	const disabledReason = landingDisabledReason({
		stage,
		capabilityEnabled: capabilityUsable,
		productSelected: Boolean(selectedProduct),
		hasSource: Boolean(file),
		prompt,
		turnstileReady: Boolean(turnstileToken),
	});
	const isBusy = disabledReason === "busy";
	const canSubmit = disabledReason === null;
	const canRetryCapability = stage === "failed" && capability === null;

	function retryCapability() {
		setSubmitError(undefined);
		setStage("checking");
		setCapabilityRequestKey((current) => current + 1);
	}

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
				aspectRatio,
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

	const selectedModeKey = selectedProductKey === "image-quality" ? "quality" : "standard";
	const selectedProductLabel = selectedProduct ? t(`modes.${selectedModeKey}.label`) : "";
	const actionLabel = canRetryCapability
		? t("actions.retryAvailability")
		: stage === "failed" && selectedProduct
			? t("actions.retry", { product: selectedProductLabel })
			: selectedProduct?.accessHint === "paid-account"
				? t("actions.quality")
				: t("actions.standard");
	const stageLabel =
		stage === "uploading"
			? t("states.uploading", { percentage: uploadPercentage ?? 0 })
			: t(`states.${stage}`);
	const statusLabel =
		disabledReason && disabledReason !== "busy" ? t(`guidance.${disabledReason}`) : stageLabel;
	const showCharacterCount = prompt.length >= 9_000;

	return (
		<>
			<div
				ref={generatorRef}
				data-test="landing-generator"
				className="mt-6 p-3 sm:p-4 relative isolate mx-auto max-w-[76rem] overflow-hidden rounded-[1.75rem] border border-[#b79cff]/20 bg-[#2b2137] shadow-[0_34px_100px_-48px_rgba(0,0,0,0.95),0_28px_70px_-50px_rgba(169,139,255,0.72),inset_0_1px_0_rgba(255,255,255,0.07)]"
			>
				<div
					className="inset-0 pointer-events-none absolute bg-[radial-gradient(circle_at_88%_-40%,rgba(183,156,255,0.18),transparent_24rem)]"
					aria-hidden="true"
				/>
				<div
					className="top-0 right-16 left-16 pointer-events-none absolute h-px bg-gradient-to-r from-transparent via-[#c9b9ff]/55 to-transparent"
					aria-hidden="true"
				/>
				<form className="relative" onSubmit={(event) => void submit(event)}>
					<div className="gap-1.5 sm:gap-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] md:grid-cols-[8.5rem_minmax(0,1fr)] bg-black/10 p-1.5 grid grid-cols-[4.75rem_minmax(0,1fr)] rounded-[1.3rem]">
						<section data-test="landing-source-panel" className="min-w-0 relative">
							<label htmlFor="landing-source-image" className="sr-only">
								{t("reference")}
							</label>
							{file && (
								<button
									type="button"
									className="top-2 right-2 size-11 bg-black/65 text-white backdrop-blur hover:bg-black/85 absolute z-20 grid place-items-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
									onClick={clearFile}
									disabled={isBusy}
									aria-label={t("removeImage")}
								>
									<XIcon className="size-4" aria-hidden="true" />
								</button>
							)}
							<button
								type="button"
								className={`group min-h-36 p-3 md:min-h-[9.5rem] bg-white/[0.025] relative flex w-full items-center justify-center overflow-hidden rounded-[1rem] border border-dashed text-center transition duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff] disabled:cursor-wait motion-reduce:transition-none ${
									isDragging
										? "border-violet-200 bg-violet-400/12"
										: "border-white/20 hover:bg-white/[0.035] hover:border-[#c9b9ff]/70"
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
											className="object-cover transition duration-500 group-hover:scale-105 motion-reduce:transition-none"
										/>
										<span className="inset-x-2 bottom-2 bg-black/65 px-3 py-2 text-xs font-semibold text-white backdrop-blur absolute rounded-lg">
											{t("replaceImage")}
										</span>
									</>
								) : (
									<span className="gap-2.5 flex flex-col items-center">
										<span className="size-11 group-hover:-translate-y-1 grid place-items-center rounded-xl bg-[#a98bff]/12 text-[#c9b9ff] ring-1 ring-[#a98bff]/25 transition motion-reduce:transform-none">
											<UploadCloudIcon className="size-5" aria-hidden="true" />
										</span>
										<span className="max-w-24 text-sm font-semibold leading-5 text-white">
											{t("reference")}
										</span>
										<span className="max-w-36 leading-4 md:block hidden text-[0.68rem] text-[#94889f]">
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

						<section
							data-test="landing-prompt-panel"
							className="min-w-0 focus-within:bg-white/[0.025] relative overflow-hidden rounded-[1rem] transition-colors focus-within:ring-1 focus-within:ring-[#b79cff]/30 focus-within:ring-inset motion-reduce:transition-none"
						>
							<label htmlFor="landing-edit-prompt" className="sr-only">
								{t("prompt")}
							</label>
							<Textarea
								ref={promptRef}
								id="landing-edit-prompt"
								rows={4}
								required
								maxLength={10_000}
								value={prompt}
								disabled={isBusy}
								placeholder={t("placeholder")}
								className="min-h-36 p-4 pb-9 sm:p-5 sm:pb-9 md:min-h-[9.5rem] text-base leading-7 resize-none border-0 bg-transparent text-[#f6f2fb] shadow-none placeholder:text-[#a99db2] focus-visible:ring-0"
								onChange={(event) => setPrompt(event.target.value)}
							/>
							{showCharacterCount ? (
								<span className="right-4 bottom-3 absolute text-[0.68rem] text-[#8f8399] tabular-nums">
									{t("characterCount", { count: prompt.length, maximum: 10_000 })}
								</span>
							) : null}
						</section>
					</div>

					<div
						data-test="landing-controls-panel"
						className="mt-2 gap-2 px-1 flex flex-wrap items-center"
					>
						<fieldset
							data-test="landing-tier-panel"
							disabled={isBusy}
							className={capability?.products.length ? "min-w-0" : "hidden"}
						>
							<legend className="sr-only">{t("modes.legend")}</legend>
							<div className="gap-1 bg-black/15 p-1 flex flex-wrap rounded-xl">
								{capability?.products.map((product) => {
									const modeKey = product.key === "image-quality" ? "quality" : "standard";
									const selected = product.key === selectedProductKey;
									return (
										<label
											key={product.key}
											className={`min-h-10 gap-2 px-3 text-xs font-semibold relative flex cursor-pointer items-center rounded-lg transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#b79cff] ${
												selected
													? "text-white shadow-sm bg-[#4b3a70]"
													: "hover:bg-white/[0.055] hover:text-white text-[#b7acbf]"
											}`}
										>
											<input
												type="radio"
												name="landing-product"
												value={product.key}
												checked={selected}
												className="inset-0 absolute z-10 h-full w-full cursor-pointer opacity-0"
												onChange={() => {
													setSelectedProductKey(product.key);
													setSubmitError(undefined);
												}}
											/>
											{selected && <CheckIcon className="size-3.5" aria-hidden="true" />}
											<span>{t(`modes.${modeKey}.label`)}</span>
											<span className="text-[0.64rem] opacity-70">
												{t("modes.credits", { credits: Number(product.credits) })}
											</span>
										</label>
									);
								})}
							</div>
						</fieldset>

						<div className="sm:w-[17.5rem] w-full">
							<ImageOutputSettings
								idPrefix="landing"
								aspectRatios={selectedProduct?.aspectRatios ?? []}
								value={aspectRatio}
								onChange={(nextAspectRatio) => {
									setAspectRatio(nextAspectRatio);
									setSubmitError(undefined);
								}}
								modeLabel={selectedProductLabel || t("modes.selectionPending")}
								disabled={isBusy}
								tone="dark"
								labels={{
									title: t("settings.title"),
									trigger: t("settings.trigger"),
									aspectRatio: t("settings.aspectRatio"),
									automatic: t("settings.automatic"),
									outputNumber: t("settings.outputNumber"),
									oneOutput: t("settings.oneOutput"),
									resolution: t("settings.resolution"),
									quality: t("settings.quality"),
									modeControlsQuality: t("settings.modeControlsQuality"),
								}}
							/>
						</div>

						<Button
							type={canRetryCapability ? "button" : "submit"}
							variant="primary"
							size="lg"
							className="min-h-11 px-5 text-white focus-visible:outline-violet-200 sm:ml-auto sm:w-auto w-full bg-[#6c4dff] shadow-[0_14px_34px_-16px_rgba(108,77,255,0.9)] hover:bg-[#7d63ff]"
							disabled={canRetryCapability ? false : !canSubmit}
							loading={isBusy}
							aria-describedby="landing-stage-status"
							onClick={canRetryCapability ? retryCapability : undefined}
						>
							{actionLabel}
							<ArrowRightIcon className="ml-1 size-4" aria-hidden="true" />
						</Button>
					</div>

					<div className="mt-2 gap-x-5 gap-y-1 px-1 sm:flex-row sm:items-center text-xs leading-5 flex flex-col text-[#b2a7bc]">
						<output
							id="landing-stage-status"
							data-test="landing-stage"
							data-stage={stage}
							className={canSubmit ? "sr-only" : "font-semibold text-[#ddd4e4]"}
							aria-live="polite"
						>
							{statusLabel}
						</output>
						{selectedProduct && capabilityUsable && (
							<span className="gap-1.5 inline-flex items-center">
								<SparklesIcon className="size-3.5 text-[#b79cff]" aria-hidden="true" />
								{selectedProduct.accessHint === "paid-account"
									? t("qualityAccess")
									: t("freeQueue")}
							</span>
						)}
						<span className="gap-1.5 sm:ml-auto inline-flex items-center">
							<LockKeyholeIcon className="size-3.5 text-emerald-300" aria-hidden="true" />
							{t("temporaryResult")}
						</span>
					</div>

					{stage === "uploading" && typeof uploadPercentage === "number" && (
						<div className="mt-3 h-1.5 bg-white/10 overflow-hidden rounded-full" aria-hidden="true">
							<div
								className="bg-violet-400 h-full rounded-full transition-[width] motion-reduce:transition-none"
								style={{ width: `${uploadPercentage}%` }}
							/>
						</div>
					)}
					{GUEST_TURNSTILE_SITE_KEY && !isDockVisible && (
						<Turnstile
							siteKey={GUEST_TURNSTILE_SITE_KEY}
							action="guest_upload"
							ariaLabel={t("states.challenge")}
							className="mt-3"
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
					{submitError && (
						<Alert
							className="mt-2 px-1 py-1 text-red-200 border-0 bg-transparent"
							variant="error"
							role="alert"
						>
							<AlertDescription>{t(`errors.${submitError}`)}</AlertDescription>
						</Alert>
					)}
				</form>
			</div>

			{isDockVisible && (
				<aside
					ref={floatingDockRef}
					data-test="floating-editor-dock"
					aria-label={t("floating.label")}
					className="right-2 left-2 sm:right-4 sm:left-4 animate-in fade-in slide-in-from-bottom-4 pointer-events-none fixed z-[70] duration-300 motion-reduce:animate-none"
					style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
				>
					<div
						className={`backdrop-blur-2xl pointer-events-auto mx-auto overflow-hidden rounded-[1.45rem] border border-[#b79cff]/30 bg-[#2b2137]/96 shadow-[0_28px_90px_-28px_rgba(0,0,0,0.95),0_18px_54px_-28px_rgba(169,139,255,0.9)] transition-[max-width] duration-300 motion-reduce:transition-none ${isDockExpanded ? "max-w-[60rem]" : "max-w-[52rem]"}`}
					>
						{isDockExpanded ? (
							<form
								id="floating-editor-panel"
								data-test="floating-editor-expanded"
								aria-label={t("floating.label")}
								className="p-3 sm:p-4 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain"
								onSubmit={(event) => void submit(event)}
							>
								<div className="mb-3 flex items-center justify-between">
									<p className="text-sm font-semibold text-white">{t("floating.label")}</p>
									<button
										type="button"
										className="size-11 hover:bg-white/[0.06] hover:text-white grid place-items-center rounded-full text-[#b7acbf] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
										onClick={() => {
											setIsDockExpanded(false);
											requestAnimationFrame(() => floatingExpandRef.current?.focus());
										}}
										aria-label={t("floating.collapse")}
									>
										<ChevronDownIcon className="size-5" aria-hidden="true" />
									</button>
								</div>

								<div className="gap-3 sm:grid-cols-[8rem_minmax(0,1fr)] grid grid-cols-[4.75rem_minmax(0,1fr)]">
									<button
										type="button"
										className="group min-h-28 sm:min-h-32 border-white/20 bg-black/10 hover:bg-white/[0.035] relative flex items-center justify-center overflow-hidden rounded-xl border border-dashed text-center transition hover:border-[#c9b9ff]/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff] motion-reduce:transition-none"
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
										disabled={isBusy}
										aria-label={file ? t("replaceImage") : t("floating.upload")}
									>
										{previewUrl ? (
											<Image
												src={previewUrl}
												alt={t("previewAlt", { fileName: file?.name ?? "" })}
												fill
												unoptimized
												className="object-cover"
											/>
										) : (
											<span className="gap-2 text-xs font-semibold flex flex-col items-center text-[#c9b9ff]">
												<ImagePlusIcon className="size-5" aria-hidden="true" />
												{t("floating.upload")}
											</span>
										)}
									</button>

									<div className="min-w-0 relative overflow-hidden rounded-xl focus-within:ring-1 focus-within:ring-[#b79cff]/30 focus-within:ring-inset">
										<label htmlFor="floating-edit-prompt" className="sr-only">
											{t("prompt")}
										</label>
										<Textarea
											ref={floatingPromptRef}
											id="floating-edit-prompt"
											rows={4}
											required
											maxLength={10_000}
											value={prompt}
											disabled={isBusy}
											placeholder={t("placeholder")}
											className="min-h-28 p-4 sm:min-h-32 text-base leading-6 text-white resize-none border-0 bg-transparent shadow-none placeholder:text-[#a99db2] focus-visible:ring-0"
											onChange={(event) => setPrompt(event.target.value)}
										/>
									</div>
								</div>

								<div className="mt-2 gap-2 flex flex-wrap items-center">
									<fieldset
										disabled={isBusy}
										className={capability?.products.length ? undefined : "hidden"}
									>
										<legend className="sr-only">{t("modes.legend")}</legend>
										<div className="gap-1 p-1 bg-black/15 flex rounded-xl">
											{capability?.products.map((product) => {
												const modeKey = product.key === "image-quality" ? "quality" : "standard";
												const selected = product.key === selectedProductKey;
												return (
													<label
														key={product.key}
														className={`min-h-10 px-3 text-xs font-semibold relative flex cursor-pointer items-center rounded-lg transition focus-within:outline-2 focus-within:outline-[#b79cff] ${
															selected
																? "text-white bg-[#4b3a70]"
																: "hover:text-white text-[#b7acbf]"
														}`}
													>
														<input
															type="radio"
															name="floating-product"
															value={product.key}
															checked={selected}
															className="inset-0 absolute z-10 h-full w-full cursor-pointer opacity-0"
															onChange={() => {
																setSelectedProductKey(product.key);
																setSubmitError(undefined);
															}}
														/>
														{t(`modes.${modeKey}.label`)}
													</label>
												);
											})}
										</div>
									</fieldset>

									<div className="sm:w-[17.5rem] w-full">
										<ImageOutputSettings
											idPrefix="floating"
											aspectRatios={selectedProduct?.aspectRatios ?? []}
											value={aspectRatio}
											onChange={(nextAspectRatio) => {
												setAspectRatio(nextAspectRatio);
												setSubmitError(undefined);
											}}
											modeLabel={selectedProductLabel || t("modes.selectionPending")}
											disabled={isBusy}
											tone="dark"
											labels={{
												title: t("settings.title"),
												trigger: t("settings.trigger"),
												aspectRatio: t("settings.aspectRatio"),
												automatic: t("settings.automatic"),
												outputNumber: t("settings.outputNumber"),
												oneOutput: t("settings.oneOutput"),
												resolution: t("settings.resolution"),
												quality: t("settings.quality"),
												modeControlsQuality: t("settings.modeControlsQuality"),
											}}
										/>
									</div>

									<Button
										type={canRetryCapability ? "button" : "submit"}
										variant="primary"
										size="lg"
										className="min-h-11 px-5 text-white sm:ml-auto sm:w-auto w-full bg-[#6c4dff] hover:bg-[#7d63ff]"
										disabled={canRetryCapability ? false : !canSubmit}
										loading={isBusy}
										aria-describedby="floating-stage-status"
										onClick={canRetryCapability ? retryCapability : undefined}
									>
										{actionLabel}
										<ArrowRightIcon className="ml-1 size-4" aria-hidden="true" />
									</Button>
								</div>

								<div className="mt-2 gap-x-4 gap-y-1 text-xs sm:flex-row flex flex-col text-[#b7acbf]">
									<span id="floating-stage-status" className="font-semibold text-[#ddd4e4]">
										{statusLabel}
									</span>
									<span className="sm:ml-auto">
										{file ? t("floating.imageReady") : t("floating.upload")}
									</span>
								</div>
								{GUEST_TURNSTILE_SITE_KEY && (
									<Turnstile
										siteKey={GUEST_TURNSTILE_SITE_KEY}
										action="guest_upload"
										ariaLabel={t("states.challenge")}
										className="mt-3"
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
								{fileError && (
									<p className="mt-2 text-sm text-red-300" role="alert">
										{fileError}
									</p>
								)}
								{submitError && (
									<Alert
										className="mt-2 px-1 py-1 text-red-200 border-0 bg-transparent"
										variant="error"
										role="alert"
									>
										<AlertDescription>{t(`errors.${submitError}`)}</AlertDescription>
									</Alert>
								)}
							</form>
						) : (
							<div data-test="floating-editor-collapsed" className="gap-2 p-2 flex items-center">
								<button
									type="button"
									className="size-12 border-white/10 relative grid shrink-0 place-items-center overflow-hidden rounded-xl border bg-[#1b1425] text-[#c9b9ff] transition hover:border-[#b79cff]/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
									disabled={isBusy}
									onClick={() => {
										beginUpload();
										inputRef.current?.click();
									}}
									aria-label={t("floating.upload")}
								>
									{previewUrl ? (
										<Image src={previewUrl} alt="" fill unoptimized className="object-cover" />
									) : (
										<ImagePlusIcon className="size-5" aria-hidden="true" />
									)}
								</button>
								<button
									ref={floatingExpandRef}
									type="button"
									className="min-h-12 min-w-0 px-2 text-sm font-medium hover:text-white flex-1 truncate rounded-lg text-left text-[#f0eaf5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b79cff]"
									onClick={() => setIsDockExpanded(true)}
									aria-label={t("floating.open")}
									aria-expanded={isDockExpanded}
									aria-controls="floating-editor-panel"
								>
									<span className={prompt ? "text-[#f0eaf5]" : "text-[#8f8399]"}>
										{prompt || t("placeholder")}
									</span>
								</button>
								<button
									type="button"
									className="size-12 text-white focus-visible:outline-violet-200 grid shrink-0 place-items-center rounded-full bg-[#6c4dff] shadow-[0_12px_28px_-12px_rgba(108,77,255,0.95)] transition hover:bg-[#7d63ff] focus-visible:outline-2 focus-visible:outline-offset-2"
									onClick={() => setIsDockExpanded(true)}
									aria-label={t("floating.expand")}
									aria-expanded={isDockExpanded}
									aria-controls="floating-editor-panel"
								>
									<ArrowUpIcon className="size-5" aria-hidden="true" />
								</button>
							</div>
						)}
					</div>
				</aside>
			)}
		</>
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

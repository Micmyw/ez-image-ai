"use client";

import { marketingGrowthFunnel } from "@analytics";
import { config } from "@config";
import { getPublicConfig } from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { ArrowRightIcon, LockKeyholeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ImageDropzone } from "../../image-editor/components/ImageDropzone";
import { PromptSuggestions } from "../../image-editor/components/PromptSuggestions";
import { SourcePreview } from "../../image-editor/components/SourcePreview";
import {
	buildMarketingImageEditDraft,
	createMarketingDraft,
	MARKETING_IMAGE_CONTENT_TYPES,
	type MarketingImageContentType,
	type MarketingImageProductKey,
	submitMarketingDraftHandoff,
	validateMarketingImageFile,
} from "../lib/draft-client";
import type { MarketingImageModes } from "../lib/marketing-catalog";

const publicConfig = getPublicConfig();
const maximumImageBytes = publicConfig.uploadLimits.imageBytes;
const maximumImageMegabytes = Math.round(maximumImageBytes / 1024 / 1024);

const SUGGESTION_KEYS = ["background", "object", "color", "lighting"] as const;

export function MarketingGenerator({ modes }: { modes: MarketingImageModes }) {
	const t = useTranslations("home.generator");
	const [prompt, setPrompt] = useState("");
	const [productKey, setProductKey] = useState<MarketingImageProductKey>("image-fast");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string>();
	const [previewUrl, setPreviewUrl] = useState<string>();
	const sourceUploadAttemptKey = useRef<string | null>(null);

	useEffect(
		() => () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		},
		[previewUrl],
	);

	function chooseFile(nextFile: File) {
		try {
			validateMarketingImageFile(nextFile, maximumImageBytes);
			const attemptKey = sourceUploadAttemptKey.current ?? createGrowthAttemptKey();
			sourceUploadAttemptKey.current = attemptKey;
			setFile(nextFile);
			setFileError(undefined);
			setSubmitError(false);
			setPreviewUrl(URL.createObjectURL(nextFile));
			void marketingGrowthFunnel.sourceUploadCompleted(attemptKey, productKey);
		} catch (error) {
			setFile(null);
			setPreviewUrl(undefined);
			setFileError(fileErrorMessage(error, t));
		}
	}

	function clearFile() {
		setFile(null);
		setFileError(undefined);
		setPreviewUrl(undefined);
		sourceUploadAttemptKey.current = null;
	}

	function beginSourceUpload() {
		const attemptKey = createGrowthAttemptKey();
		sourceUploadAttemptKey.current = attemptKey;
		void marketingGrowthFunnel.sourceUploadStarted(attemptKey, productKey);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!config.saasUrl || !prompt.trim()) return;
		if (!file) {
			setFileError(t("fileErrors.required"));
			return;
		}

		setIsSubmitting(true);
		setSubmitError(false);
		const draftAttemptKey = createGrowthAttemptKey();
		try {
			validateMarketingImageFile(file, maximumImageBytes);
			const handoff = await createMarketingDraft(
				config.saasUrl,
				buildMarketingImageEditDraft({
					productKey,
					prompt,
					upload: {
						contentType: file.type as MarketingImageContentType,
						base64: await fileToBase64(file),
					},
				}),
			);
			await marketingGrowthFunnel.marketingDraftCreated(draftAttemptKey, productKey);
			await marketingGrowthFunnel.authHandoffStarted(draftAttemptKey, productKey);
			submitMarketingDraftHandoff(handoff);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("SOURCE_IMAGE_")) {
				setFileError(fileErrorMessage(error, t));
			} else {
				setSubmitError(true);
			}
			setIsSubmitting(false);
		}
	}

	const suggestions = SUGGESTION_KEYS.map((key) => t(`suggestions.${key}`));

	return (
		<div className="mt-8 gap-4 border-indigo-100 bg-white p-3 md:p-4 lg:grid-cols-[minmax(0,0.94fr)_minmax(22rem,1.06fr)] grid rounded-[2.25rem] border shadow-[0_30px_80px_-35px_rgba(49,46,129,0.45)]">
			<form onSubmit={(event) => void submit(event)} className="p-3 sm:p-5 lg:p-6">
				<div className="space-y-5">
					<ImageDropzone
						accept={MARKETING_IMAGE_CONTENT_TYPES.join(",")}
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

					<div>
						<label
							htmlFor="marketing-prompt"
							className="mb-2 text-sm font-semibold text-slate-950 block"
						>
							{t("prompt")}
						</label>
						<Textarea
							id="marketing-prompt"
							name="prompt"
							rows={4}
							required
							maxLength={10_000}
							value={prompt}
							placeholder={t("placeholder")}
							className="min-h-28 border-slate-200 bg-white text-slate-950 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 resize-y"
							onChange={(event) => setPrompt(event.target.value)}
						/>
					</div>

					<PromptSuggestions
						label={t("suggestionsLabel")}
						onSelect={setPrompt}
						suggestions={suggestions}
					/>

					<fieldset>
						<legend className="mb-2 text-sm font-semibold text-slate-950">
							{t("modes.legend")}
						</legend>
						<div
							role="radiogroup"
							aria-label={t("modes.legend")}
							className="gap-2 grid grid-cols-2"
						>
							<ModeOption
								checked={productKey === "image-fast"}
								credits={t("modes.credits", {
									credits: modes["image-fast"].credits,
								})}
								description={t("modes.standard.description")}
								label={modes["image-fast"].label}
								onChange={setProductKey}
								value="image-fast"
							/>
							<ModeOption
								checked={productKey === "image-quality"}
								credits={t("modes.credits", {
									credits: modes["image-quality"].credits,
								})}
								description={t("modes.quality.description")}
								label={modes["image-quality"].label}
								onChange={setProductKey}
								value="image-quality"
							/>
						</div>
					</fieldset>

					<Button
						type="submit"
						className="h-12 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-700 focus-visible:ring-indigo-600 w-full"
						size="lg"
						variant="primary"
						loading={isSubmitting}
						disabled={!config.saasUrl}
					>
						{t("continue")}
						<ArrowRightIcon className="ml-1 size-4" aria-hidden="true" />
					</Button>

					<p className="gap-2 text-xs leading-5 text-slate-500 flex items-start justify-center text-center">
						<LockKeyholeIcon
							className="mt-0.5 size-3.5 text-emerald-600 shrink-0"
							aria-hidden="true"
						/>
						<span>{t("loginNotice")}</span>
					</p>

					{submitError && (
						<Alert variant="error" role="alert">
							<AlertDescription>{t("error")}</AlertDescription>
						</Alert>
					)}
				</div>
			</form>

			<SourcePreview
				caption={t("previewCaption")}
				fileName={file?.name}
				placeholderAlt={t("previewPlaceholderAlt")}
				previewAlt={t("previewAlt", { fileName: file?.name ?? "" })}
				previewUrl={previewUrl}
				privateLabel={t("privateLabel")}
			/>
		</div>
	);
}

function ModeOption({
	checked,
	credits,
	description,
	label,
	onChange,
	value,
}: {
	checked: boolean;
	credits: string;
	description: string;
	label: string;
	onChange: (value: MarketingImageProductKey) => void;
	value: MarketingImageProductKey;
}) {
	return (
		<label className="border-slate-200 bg-white p-3 has-checked:border-indigo-500 has-checked:bg-indigo-50 has-checked:ring-indigo-500 relative cursor-pointer rounded-2xl border transition has-checked:ring-1">
			<input
				type="radio"
				name="marketing-edit-mode"
				value={value}
				checked={checked}
				onChange={() => onChange(value)}
				className="top-3 right-3 size-4 accent-indigo-600 absolute"
			/>
			<span className="pr-5 text-sm font-bold text-slate-950 block">{label}</span>
			<span className="mt-1 text-xs text-slate-500 block">{description}</span>
			<span className="mt-2 text-xs font-bold text-indigo-700 block">{credits}</span>
		</label>
	);
}

function fileErrorMessage(error: unknown, t: ReturnType<typeof useTranslations>): string {
	if (!(error instanceof Error)) return t("fileErrors.read");
	if (error.message === "SOURCE_IMAGE_EMPTY") return t("fileErrors.empty");
	if (error.message === "SOURCE_IMAGE_TOO_LARGE") {
		return t("fileErrors.size", { megabytes: maximumImageMegabytes });
	}
	if (error.message === "SOURCE_IMAGE_TYPE_UNSUPPORTED") return t("fileErrors.type");
	return t("fileErrors.read");
}

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
		reader.onload = () => {
			if (typeof reader.result !== "string") return reject(new Error("FILE_READ_FAILED"));
			const base64 = reader.result.split(",")[1] ?? "";
			if (!base64) return reject(new Error("SOURCE_IMAGE_EMPTY"));
			resolve(base64);
		};
		reader.readAsDataURL(file);
	});
}

function createGrowthAttemptKey(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CreditBalanceSummary } from "@payments/components/CreditBalanceSummary";
import { EditorUpgradeDialog } from "@payments/components/EditorUpgradeDialog";
import { createChoosePlanPath, writeEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import { getImageProductSelectionContract } from "@repo/config/client";
import { EZPIC_PRODUCT_KEYS, getPlanEntitlement, type ImageAspectRatio } from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { STUDIO_ASSET_SELECTED_EVENT } from "@shared/components/studio/studio-context";
import { useRouter } from "@shared/hooks/router";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../../landing/lib/prompt-selection";
import { useGeneration } from "../hooks/use-generation";
import { replaceImageModelInUrl, useModelNavigation } from "../hooks/use-model-navigation";
import {
	getEditorErrorKey,
	getModerationErrorReason,
	getPromptSafetyOutcome,
} from "../lib/editor-error";
import {
	isEditorProductKey,
	type EditorDraftInput,
	type EditorProductKey,
} from "../lib/editor-recovery";
import {
	buildGenerationInput,
	type GenerationFormValues,
	generationFormValuesSchema,
} from "../lib/form-schema";
import {
	getDefaultImageSpecCell,
	getImageSpecCell,
	type ImageSpecControlKey,
	publicImageAspectRatios,
	resolveImageSpecControlValues,
	type PublicImageSpecCell,
} from "../lib/image-sku-selection";
import { ContentSafetyNotice } from "./ContentSafetyNotice";
import { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";
import { RegisteredEditorDock } from "./editor/RegisteredEditorDock";
import { ImageModelSelector } from "./ImageModelSelector";
import { ImageOutputSettings } from "./ImageOutputSettings";

export function GenerationForm({
	onCreated,
	onDraftChange,
	onSourceChanged,
	jobId = null,
	initialDraft,
	allowedProductKeys = [...EZPIC_PRODUCT_KEYS],
	initialSourceReady = false,
	parentJobId,
	requireReference = false,
}: {
	onCreated: (jobId: string) => void;
	onDraftChange?: (values: GenerationFormValues) => void;
	onSourceChanged?: () => void;
	jobId?: string | null;
	initialDraft?: EditorDraftInput | null;
	allowedProductKeys?: EditorProductKey[];
	initialSourceReady?: boolean;
	parentJobId?: string | null;
	requireReference?: boolean;
}) {
	const t = useTranslations("media.create");
	const studio = useTranslations("studio");
	const imageToImage = useTranslations("imageToImage");
	const router = useRouter();
	const [hasSource, setHasSource] = useState(Boolean(initialDraft?.input.sourceAssetId));
	const generation = useGeneration({ parentJobId: hasSource ? parentJobId : null });
	const products = (generation.catalog.data?.products ?? []).map((product) =>
		isEditorProductKey(product.key)
			? {
					...product,
					label: t(`products.${product.key}.label`),
					description: t(`products.${product.key}.description`),
					...(product.skuMatrix
						? {
								skuMatrix: {
									...product.skuMatrix,
									cells: product.skuMatrix.cells.map((cell) => ({
										...cell,
										label: t(`skus.${cell.skuKey}.label`),
									})),
								},
							}
						: {}),
				}
			: product,
	);
	const [sourceReady, setSourceReady] = useState(initialSourceReady);
	const [sourcePending, setSourcePending] = useState(false);
	const sourcePendingRef = useRef(false);
	const submittingRef = useRef(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [upgradeStorageUnavailable, setUpgradeStorageUnavailable] = useState(false);
	const form = useForm<GenerationFormValues>({
		resolver: zodResolver(generationFormValuesSchema),
		mode: "onChange",
		defaultValues: {
			productKey: initialDraft?.productKey ?? "image-nano-banana-2-lite",
			skuKey: initialDraft?.input.skuKey ?? "nano-banana-2-lite-1k",
			prompt: initialDraft?.input.prompt ?? "",
			sourceAssetId: initialDraft?.input.sourceAssetId ?? "",
			aspectRatio: initialDraft?.input.aspectRatio ?? "auto",
			outputFormat: initialDraft?.input.outputFormat,
			background: initialDraft?.input.background,
		},
	});
	const values = form.watch();
	const product = products.find((candidate) => candidate.key === values.productKey);
	const upgradeRequired = Boolean(product && !allowedProductKeys.includes(values.productKey));
	const selectedCell = getImageSpecCell(product?.skuMatrix, values.skuKey);
	const supportedAspectRatios = publicImageAspectRatios(selectedCell);
	const controlValues = useMemo(
		() =>
			resolveImageSpecControlValues(selectedCell, {
				outputFormat: values.outputFormat,
				background: values.background,
			}),
		[selectedCell, values.background, values.outputFormat],
	);
	const input = useMemo(() => {
		if (
			!product ||
			!selectedCell ||
			sourcePending ||
			!supportedAspectRatios.includes(values.aspectRatio) ||
			(Boolean(values.sourceAssetId) && !sourceReady) ||
			(requireReference && !values.sourceAssetId) ||
			!values.prompt.trim()
		) {
			return null;
		}
		try {
			return buildGenerationInput({
				kind: values.sourceAssetId ? "image-to-image" : "text-to-image",
				prompt: values.prompt,
				...(values.sourceAssetId ? { sourceAssetId: values.sourceAssetId } : {}),
				skuKey: values.skuKey,
				aspectRatio: values.aspectRatio,
				...controlValues,
			});
		} catch {
			return null;
		}
	}, [
		product,
		selectedCell,
		controlValues,
		sourceReady,
		sourcePending,
		requireReference,
		supportedAspectRatios,
		values.aspectRatio,
		values.prompt,
		values.skuKey,
		values.sourceAssetId,
	]);
	const error = generation.createGeneration.error ?? generation.createQuote.error;
	const errorKey = getEditorErrorKey(error);
	const safetyOutcome = getPromptSafetyOutcome(error);
	const displayedCredits = generation.quote?.credits ?? selectedCell?.credits ?? product?.credits;
	const suggestions = ["background", "object", "lighting", "style"].map((key) =>
		t(`suggestions.${key}`),
	);

	useEffect(() => {
		if (upgradeOpen) void saasGrowthFunnel.upgradePromptViewed(values.productKey);
	}, [upgradeOpen, values.productKey]);

	const beginNewAction = generation.beginNewAction;
	const updateSourcePending = useCallback(
		(pending: boolean) => {
			if (sourcePendingRef.current === pending) return;
			sourcePendingRef.current = pending;
			setSourcePending(pending);
			if (pending) beginNewAction();
		},
		[beginNewAction],
	);
	const updatePrompt = useCallback(
		(prompt: string) => {
			form.setValue("prompt", prompt, { shouldDirty: true, shouldValidate: true });
			beginNewAction();
		},
		[form, beginNewAction],
	);

	const updateSourceAsset = useCallback(
		(sourceAssetId: string) => {
			if (sourceAssetId === form.getValues("sourceAssetId")) return;
			setSourceReady(false);
			setHasSource(Boolean(sourceAssetId));
			onSourceChanged?.();
			form.setValue("sourceAssetId", sourceAssetId, {
				shouldDirty: true,
				shouldValidate: true,
			});
			beginNewAction();
		},
		[form, beginNewAction, onSourceChanged],
	);

	useEffect(() => {
		function selectPrompt(event: Event) {
			const detail = (event as CustomEvent<LandingPromptSelectedDetail>).detail;
			if (typeof detail?.prompt === "string" && detail.prompt.trim())
				updatePrompt(detail.prompt.slice(0, 10000));
		}
		function selectAsset(event: Event) {
			const detail = (event as CustomEvent<{ assetId?: string }>).detail;
			if (typeof detail?.assetId === "string" && detail.assetId) {
				updateSourceAsset(detail.assetId);
			}
		}
		window.addEventListener(LANDING_PROMPT_SELECTED_EVENT, selectPrompt);
		window.addEventListener(STUDIO_ASSET_SELECTED_EVENT, selectAsset);
		return () => {
			window.removeEventListener(LANDING_PROMPT_SELECTED_EVENT, selectPrompt);
			window.removeEventListener(STUDIO_ASSET_SELECTED_EVENT, selectAsset);
		};
	}, [updatePrompt, updateSourceAsset]);

	useEffect(() => {
		if (!onDraftChange) return;
		onDraftChange(form.getValues());
		const subscription = form.watch(() => onDraftChange(form.getValues()));
		return () => subscription.unsubscribe();
	}, [form, onDraftChange]);

	function replaceControlValues(cell: PublicImageSpecCell) {
		const next = resolveImageSpecControlValues(cell, {});
		form.unregister(["outputFormat", "background"]);
		if (next.outputFormat) {
			form.setValue("outputFormat", next.outputFormat, {
				shouldDirty: true,
				shouldValidate: true,
			});
		}
		if (next.background) {
			form.setValue("background", next.background, {
				shouldDirty: true,
				shouldValidate: true,
			});
		}
	}

	function updateProduct(productKey: EditorProductKey) {
		const nextProduct = products.find((candidate) => candidate.key === productKey);
		const defaultCell = getDefaultImageSpecCell(nextProduct?.skuMatrix);
		if (!defaultCell) return;
		form.setValue("productKey", productKey, {
			shouldDirty: true,
			shouldValidate: true,
		});
		form.setValue("skuKey", defaultCell.skuKey as GenerationFormValues["skuKey"], {
			shouldDirty: true,
			shouldValidate: true,
		});
		replaceControlValues(defaultCell);
		const nextAspectRatio = publicImageAspectRatios(defaultCell)[0];
		if (nextAspectRatio) {
			form.setValue("aspectRatio", nextAspectRatio, {
				shouldDirty: true,
				shouldValidate: true,
			});
		}
		generation.beginNewAction();
	}
	const modelNavigation = useModelNavigation({
		products,
		value: values.productKey,
		ready: Boolean(generation.catalog.data) && !generation.createGeneration.isPending,
		onSelect: updateProduct,
	});

	function updateSku(skuKey: string) {
		const cell = getImageSpecCell(product?.skuMatrix, skuKey);
		if (!cell) return;
		form.setValue("skuKey", cell.skuKey as GenerationFormValues["skuKey"], {
			shouldDirty: true,
			shouldValidate: true,
		});
		replaceControlValues(cell);
		const ratios = publicImageAspectRatios(cell);
		if (!ratios.includes(values.aspectRatio) && ratios[0]) {
			form.setValue("aspectRatio", ratios[0], {
				shouldDirty: true,
				shouldValidate: true,
			});
		}
		generation.beginNewAction();
	}

	function updateAspectRatio(aspectRatio: ImageAspectRatio) {
		form.setValue("aspectRatio", aspectRatio, { shouldDirty: true, shouldValidate: true });
		generation.beginNewAction();
	}

	function updateControl(key: ImageSpecControlKey, value: string) {
		const next = resolveImageSpecControlValues(selectedCell, { ...controlValues, [key]: value });
		if (key === "outputFormat" && next.outputFormat === value) {
			form.setValue("outputFormat", next.outputFormat, {
				shouldDirty: true,
				shouldValidate: true,
			});
		} else if (key === "background" && next.background === value) {
			form.setValue("background", next.background, {
				shouldDirty: true,
				shouldValidate: true,
			});
		} else {
			return;
		}
		generation.beginNewAction();
	}

	function continueToUpgrade() {
		const current = form.getValues();
		const currentProduct = products.find((candidate) => candidate.key === current.productKey);
		const currentCell = getImageSpecCell(currentProduct?.skuMatrix, current.skuKey);
		const currentControls = resolveImageSpecControlValues(currentCell, {
			outputFormat: current.outputFormat,
			background: current.background,
		});
		const saved = writeEditorUpgradeDraft(window.sessionStorage, {
			draft: {
				productKey: current.productKey,
				input: {
					kind: current.sourceAssetId ? "image-to-image" : "text-to-image",
					prompt: current.prompt,
					...(current.sourceAssetId ? { sourceAssetId: current.sourceAssetId } : {}),
					skuKey: current.skuKey,
					aspectRatio: current.aspectRatio,
					...currentControls,
				},
			},
			parentJobId: current.sourceAssetId ? (parentJobId ?? null) : null,
			sourceReady,
		});
		if (!saved) {
			setUpgradeStorageUnavailable(true);
			setUpgradeOpen(true);
			return;
		}
		router.push(createChoosePlanPath("/create?upgrade=complete"));
	}

	async function confirmGeneration() {
		if (
			!input ||
			displayedCredits === undefined ||
			sourcePendingRef.current ||
			submittingRef.current
		)
			return;
		submittingRef.current = true;
		try {
			const result = await generation.createGeneration.mutateAsync({
				productKey: values.productKey,
				input,
				expectedCredits: String(displayedCredits),
			});
			if (!result) return;
			onCreated(result.job.id);
			generation.beginNewAction();
		} catch {
			// The mutation exposes only a stable, translated public error below.
		} finally {
			submittingRef.current = false;
		}
	}

	return (
		<form
			data-task-order="source-prompt-service-action"
			className="studio-composer"
			data-test="registered-generator"
			id="registered-generator"
			onSubmit={form.handleSubmit((validated) => {
				if (!allowedProductKeys.includes(validated.productKey)) {
					setUpgradeOpen(true);
					return;
				}
				void confirmGeneration();
			})}
		>
			<div className="studio-composer-heading">
				<span>
					{requireReference || values.sourceAssetId
						? studio("generation.editMode")
						: studio("generation.textMode")}
				</span>
				<span className="text-xs text-muted-foreground">{studio("private")}</span>
			</div>
			{modelNavigation.unavailable && (
				<output className="mb-3 text-sm text-amber-200 block">
					{studio("tools.modelUnavailable")}
				</output>
			)}
			{requireReference && !values.sourceAssetId && (
				<p className="mb-3 text-sm text-violet-200">{imageToImage("referenceNotice")}</p>
			)}
			<div className="studio-composer-inputs">
				<ImageSourcePanel
					compact
					sourceAssetId={values.sourceAssetId}
					maximumImageBytes={Math.min(
						generation.creditAccount.data?.maximumInputBytes ??
							getPlanEntitlement("free").maximumInputBytes,
						getImageProductSelectionContract(values.productKey)?.maximumInputBytes ??
							Number.MAX_SAFE_INTEGER,
					)}
					onReadyChange={setSourceReady}
					onPendingChange={updateSourcePending}
					onChange={updateSourceAsset}
				/>
				<PromptPanel
					maxLength={getImageProductSelectionContract(values.productKey)?.maximumPromptLength}
					label={
						requireReference || values.sourceAssetId
							? t("fields.prompt")
							: studio("generation.promptLabel")
					}
					hint={studio("generation.promptHint")}
					suggestionsLabel={t("suggestions.label")}
					suggestions={suggestions}
					suggestionLabels={["background", "object", "lighting", "style"].map((key) =>
						studio(`promptSuggestions.${key}`),
					)}
					value={values.prompt}
					onChange={updatePrompt}
				/>
			</div>
			<div className="studio-composer-controls">
				<ImageModelSelector
					idPrefix="editor"
					products={products.flatMap((candidate) =>
						candidate.skuMatrix
							? [
									{
										...candidate,
										skuMatrix: candidate.skuMatrix,
										requiresUpgrade:
											isEditorProductKey(candidate.key) &&
											!allowedProductKeys.includes(candidate.key),
									},
								]
							: [],
					)}
					value={values.productKey}
					onChange={(key) => {
						if (isEditorProductKey(key)) {
							updateProduct(key);
							replaceImageModelInUrl(key);
						}
					}}
					disabled={generation.createGeneration.isPending}
				/>
				<ImageOutputSettings
					idPrefix="editor"
					aspectRatios={supportedAspectRatios}
					value={values.aspectRatio}
					onChange={updateAspectRatio}
					modeLabel={product?.label ?? values.productKey}
					skuMatrix={product?.skuMatrix}
					skuKey={values.skuKey}
					onSkuChange={updateSku}
					controlValues={controlValues}
					onControlChange={updateControl}
					tone="dark"
					labels={{
						title: t("outputSettings.title"),
						trigger: t("outputSettings.trigger"),
						aspectRatio: t("outputSettings.aspectRatio"),
						automatic: t("outputSettings.automatic"),
						outputNumber: t("outputSettings.outputNumber"),
						oneOutput: t("outputSettings.oneOutput"),
						resolution: t("outputSettings.resolution"),
						quality: t("outputSettings.quality"),
						outputFormat: t("outputSettings.outputFormat"),
						background: t("outputSettings.background"),
						modeControlsQuality: t("outputSettings.modeControlsQuality"),
						credits: t("outputSettings.credits"),
						optionLabels: {
							"1k": t("outputSettings.optionLabels.1k"),
							"2k": t("outputSettings.optionLabels.2k"),
							"3k": t("outputSettings.optionLabels.3k"),
							"4k": t("outputSettings.optionLabels.4k"),
							basic: t("outputSettings.optionLabels.basic"),
							medium: t("outputSettings.optionLabels.medium"),
							high: t("outputSettings.optionLabels.high"),
							ultra: t("outputSettings.optionLabels.ultra"),
							png: t("outputSettings.optionLabels.png"),
							jpeg: t("outputSettings.optionLabels.jpeg"),
							auto: t("outputSettings.optionLabels.auto"),
							opaque: t("outputSettings.optionLabels.opaque"),
							transparent: t("outputSettings.optionLabels.transparent"),
						},
					}}
				/>
				{upgradeRequired ? (
					<Button
						type="button"
						variant="primary"
						className="studio-submit"
						data-test="editor-model-upgrade"
						disabled={generation.createGeneration.isPending}
						onClick={() => setUpgradeOpen(true)}
					>
						{t("modelMenu.viewPlans")}
					</Button>
				) : (
					<Button
						type="submit"
						data-test="generation-submit"
						variant="primary"
						className="studio-submit"
						disabled={
							!input || generation.createQuote.isPending || generation.createGeneration.isPending
						}
						loading={generation.createGeneration.isPending}
					>
						{generation.createQuote.isPending
							? t("checking")
							: generation.createGeneration.isPending
								? t("starting")
								: t(
										requireReference || values.sourceAssetId
											? "startEditWithCredits"
											: "generateWithCredits",
										{
											credits: displayedCredits ?? "—",
										},
									)}
					</Button>
				)}
			</div>
			{sourcePending && (
				<output className="mt-3 text-xs text-amber-200 block">
					{studio("generation.referencePending")}
				</output>
			)}
			{upgradeRequired && product && (
				<output
					data-test="editor-model-access-notice"
					className="mt-3 text-xs leading-5 text-violet-200 block"
				>
					{t("modelMenu.upgradeNotice", { model: product.label })}
				</output>
			)}
			<details className="mt-3 text-xs text-muted-foreground">
				<summary className="py-2 cursor-pointer">{t("creditPolicy")}</summary>
				<p className="mt-1 leading-relaxed">{t("moderationBillingPolicy")}</p>
			</details>
			{error && safetyOutcome ? (
				<ContentSafetyNotice
					stage="prompt"
					outcome={safetyOutcome}
					reason={getModerationErrorReason(error)}
					billing="beforeGeneration"
					onRevise={() => document.getElementById("generation-prompt")?.focus()}
				/>
			) : error ? (
				<Alert variant="error">
					<AlertDescription>
						{t(`errors.${errorKey}`)}
						{errorKey === "insufficientCredits" && product && (
							<CreditBalanceSummary
								requiredCredits={selectedCell?.credits ?? product.credits}
								availableCredits={generation.creditAccount.data?.spendableCredits ?? "0"}
								onUpgrade={continueToUpgrade}
							/>
						)}
						{errorKey === "concurrentLimit" && (
							<div className="mt-3 gap-3 flex flex-wrap items-center justify-between">
								<p className="text-sm">
									{t("concurrentJobs", {
										count: generation.creditAccount.data?.activeJobs ?? 0,
									})}
								</p>
								<Button
									size="sm"
									variant="secondary"
									render={(props) => <Link {...props} href="/history" />}
								>
									{t("history")}
								</Button>
							</div>
						)}
					</AlertDescription>
				</Alert>
			) : null}
			<EditorUpgradeDialog
				modelLabel={product?.label}
				modelProductKey={values.productKey}
				open={upgradeOpen}
				onOpenChange={(open) => {
					setUpgradeOpen(open);
					if (!open) setUpgradeStorageUnavailable(false);
				}}
				onContinue={continueToUpgrade}
				storageUnavailable={upgradeStorageUnavailable}
			/>
			<RegisteredEditorDock prompt={values.prompt} jobId={jobId} />
		</form>
	);
}

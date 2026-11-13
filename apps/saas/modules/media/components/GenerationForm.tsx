"use client";

import { useSession } from "@auth/hooks/use-session";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreditBalanceSummary } from "@payments/components/CreditBalanceSummary";
import { EditorUpgradeDialog } from "@payments/components/EditorUpgradeDialog";
import { PaidTemplateDialog } from "@payments/components/PaidTemplateDialog";
import { createChoosePlanPath, writeEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import {
	clearPaidTemplatePurchase,
	readPaidTemplatePurchase,
} from "@payments/lib/paid-template-purchase";
import { getImageGenerationCredits, getImageProductSelectionContract } from "@repo/config/client";
import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_SKU_KEYS,
	getPlanEntitlement,
	parseImageSelection,
	type ImageAspectRatio,
	type ImageSkuKey,
} from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { textLengthBucket, generationErrorCategory } from "@repo/utils/lib/generation-diagnostics";
import { STUDIO_ASSET_SELECTED_EVENT } from "@shared/components/studio/studio-context";
import { useGenerationAnalytics, trackGenerationAction } from "@shared/hooks/generation-analytics";
import { useRouter } from "@shared/hooks/router";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { captureCheckoutTrigger } from "@shared/lib/purchase-attribution";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { useEffectEditor, useEffectEditorBinding } from "../../effects/lib/editor-context";
import {
	applyEffectPresetToValues,
	hasEffectPresetChanges,
	isEffectSelectionAvailable,
} from "../../effects/lib/editor-selection";
import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../../landing/lib/prompt-selection";
import { useShowcasePrompt } from "../../landing/lib/use-showcase-prompt";
import { useGeneration } from "../hooks/use-generation";
import {
	replaceImageModelInUrl,
	useModelNavigation,
	useRequestedImageModel,
	useRequestedImageOutputFormat,
} from "../hooks/use-model-navigation";
import { useReferencePromptCapture } from "../hooks/use-reference-prompt-capture";
import { creditAccountOwnerId } from "../lib/credit-account-query";
import {
	getEditorErrorKey,
	getModerationErrorReason,
	getPromptSafetyOutcome,
} from "../lib/editor-error";
import {
	isEditorProductKey,
	DEFAULT_EDITOR_PRODUCT_KEY,
	type EditorDraftInput,
	type EditorProductKey,
} from "../lib/editor-recovery";
import {
	buildGenerationInput,
	type GenerationFormValues,
	generationFormValuesSchema,
} from "../lib/form-schema";
import { useGenerationMode } from "../lib/generation-mode-context";
import { imagePassCoversSku, imagePassIncludesSkuAccess } from "../lib/image-pass-eligibility";
import {
	constrainImageSpecMatrixToOutputFormat,
	getDefaultImageSpecCell,
	getImageSpecCell,
	type ImageSpecControlChangeKey,
	publicImageAspectRatios,
	resolveImageSpecControlValues,
	type PublicImageSpecCell,
} from "../lib/image-sku-selection";
import { isPaidTemplateSelection, paidTemplateSpecMatrix } from "../lib/paid-template-selection";
import { observeGenerationJobVisibility } from "../lib/preview-timing";
import type { TemporaryReferenceReceipt } from "../lib/temporary-reference-upload";
import { useToolPrompt, useToolPromptBinding } from "../lib/tool-prompt-context";
import { saveWorkspaceDraft } from "../lib/workspace-draft";
import { ContentSafetyNotice } from "./ContentSafetyNotice";
import { ComposerHeader } from "./editor/ComposerHeader";
import { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";
import { RegisteredEditorDock } from "./editor/RegisteredEditorDock";
import { ImageFundingSelector, type ImageFundingSource } from "./ImageFundingSelector";
import { ImageModelSelector } from "./ImageModelSelector";
import { ImageOutputSettings } from "./ImageOutputSettings";

import "./editor/generation-composer.css";

export function GenerationForm({
	onCreated,
	onDraftChange,
	onSourceChanged,
	ready = true,
	jobId = null,
	initialDraft,
	initialTemporaryReference,
	initialFundingSource,
	workspaceDraftPath = "/create",
	initialProductKey,
	allowedProductKeys = [...EZPIC_PRODUCT_KEYS],
	allowedImageSkuKeys = [...IMAGE_SKU_KEYS],
	initialSourceReady = false,
	parentJobId,
	requireReference: referenceRequired = false,
	layout = "default",
}: {
	onCreated: (jobId: string) => void;
	onDraftChange?: (
		values: GenerationFormValues,
		reference?: TemporaryReferenceReceipt,
		fundingSource?: ImageFundingSource,
	) => void;
	initialTemporaryReference?: TemporaryReferenceReceipt;
	initialFundingSource?: ImageFundingSource;
	workspaceDraftPath?: string;
	onSourceChanged?: () => void;
	ready?: boolean;
	jobId?: string | null;
	initialDraft?: EditorDraftInput | null;
	initialProductKey?: EditorProductKey;
	allowedProductKeys?: EditorProductKey[];
	allowedImageSkuKeys?: ImageSkuKey[];
	initialSourceReady?: boolean;
	parentJobId?: string | null;
	requireReference?: boolean;
	layout?: "default" | "minimal";
}) {
	const session = useSession();
	const ownerId = creditAccountOwnerId(session);
	const currentOwner = useRef(ownerId);
	const currentJobId = useRef(jobId);
	currentJobId.current = jobId;
	const actionVersion = useRef(0);
	const mounted = useRef(true);
	const submittingRef = useRef<object | null>(null);
	const acceptedJob = useRef<{ id: string; ownerId: string } | null>(null);
	if (currentOwner.current !== ownerId) {
		currentOwner.current = ownerId;
		actionVersion.current += 1;
		submittingRef.current = null;
		acceptedJob.current = null;
	}
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			actionVersion.current += 1;
		};
	}, []);
	const effectEditor = useEffectEditor();
	const effectPreset = effectEditor?.selectedPreset;
	const paidTemplate = effectEditor?.effect.generationAccess === "paid";
	// A guest reference cannot cross sign-in as a browser File. Keep its intent until reselected.
	const requireReference =
		referenceRequired ||
		effectPreset?.inputRequirement === "required" ||
		(initialDraft?.input.kind === "image-to-image" && !initialDraft.input.sourceAssetId);
	const effects = useTranslations("effects.editor");
	const toolPrompt = useToolPrompt();
	const t = useTranslations("media.create");
	const pass = useTranslations("imagePass");
	const [ownedFunding, setOwnedFunding] = useState<{
		ownerId: string | null;
		source: ImageFundingSource;
	} | null>(ownerId && initialFundingSource ? { ownerId, source: initialFundingSource } : null);
	const fundingSource = ownedFunding?.ownerId === ownerId ? ownedFunding.source : "CREDITS";
	const studio = useTranslations("studio");
	const composer = useTranslations("studio.composer");
	const imageToImage = useTranslations("imageToImage");
	const requestedOutputFormat = useRequestedImageOutputFormat();
	const router = useRouter();
	const [hasSource, setHasSource] = useState(Boolean(initialDraft?.input.sourceAssetId));
	const [temporaryReference, setTemporaryReference] = useState<
		TemporaryReferenceReceipt | undefined
	>(
		initialTemporaryReference?.assetId === initialDraft?.input.sourceAssetId
			? initialTemporaryReference
			: undefined,
	);
	const generation = useGeneration({
		parentJobId: hasSource && !temporaryReference ? parentJobId : null,
		ownerId,
	});
	// A sibling can populate the browser catalog before this streamed form hydrates.
	// Keep its recovery markup identical until the workspace is ready for input.
	const products = useMemo(
		() =>
			(ready ? (generation.catalog.data?.products ?? []) : [])
				.filter((product) => !paidTemplate || product.key === effectPreset?.productKey)
				.map((product) =>
					paidTemplate && product.skuMatrix && effectPreset
						? {
								...product,
								skuMatrix: paidTemplateSpecMatrix(
									product.skuMatrix,
									effectPreset.parameters.skuKey,
								),
							}
						: product,
				)
				.map((product) =>
					requestedOutputFormat && product.skuMatrix
						? {
								...product,
								skuMatrix: constrainImageSpecMatrixToOutputFormat(
									product.skuMatrix,
									requestedOutputFormat,
								),
							}
						: product,
				)
				.filter(
					(product) =>
						!requestedOutputFormat ||
						product.skuMatrix?.cells.some((cell) =>
							cell.controls.some(
								(control) =>
									control.key === "outputFormat" &&
									control.options.some((option) => option.key === requestedOutputFormat),
							),
						),
				)
				.map((product) =>
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
				),
		[
			ready,
			generation.catalog.data?.products,
			t,
			requestedOutputFormat,
			paidTemplate,
			effectPreset,
		],
	);
	const [sourceReady, setSourceReady] = useState(initialSourceReady);
	const [sourcePending, setSourcePending] = useState(false);
	const sourcePendingRef = useRef(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const active = useGenerationMode()?.mode !== "video";
	useEffect(() => {
		if (
			!jobId ||
			!active ||
			acceptedJob.current?.id !== jobId ||
			acceptedJob.current.ownerId !== ownerId
		)
			return;
		// This measures the committed task region (including its loading state),
		// independently of getJob detail readiness and output preview delivery.
		return observeGenerationJobVisibility(
			jobId,
			document.getElementById("current-editor-result"),
			() => mounted.current && currentJobId.current === jobId && currentOwner.current === ownerId,
		);
	}, [jobId, active, ownerId]);
	useEffect(() => {
		if (!active) setUpgradeOpen(false);
	}, [active]);
	const [upgradeStorageUnavailable, setUpgradeStorageUnavailable] = useState(false);
	const requestedModel = useRequestedImageModel();
	const examplePrompt = useShowcasePrompt();
	const resolvedInitialProductKey =
		(paidTemplate ? effectPreset?.productKey : undefined) ??
		initialProductKey ??
		(effectPreset ? (initialDraft?.productKey ?? effectPreset.productKey) : undefined) ??
		initialDraft?.productKey ??
		(requestedModel && isEditorProductKey(requestedModel)
			? requestedModel
			: DEFAULT_EDITOR_PRODUCT_KEY);
	const initialContract = getImageProductSelectionContract(resolvedInitialProductKey)!;
	const initialSelection =
		initialDraft?.productKey === resolvedInitialProductKey &&
		(!paidTemplate || initialDraft.input.skuKey === effectPreset?.parameters.skuKey)
			? initialDraft.input
			: effectPreset?.parameters;
	const form = useForm<GenerationFormValues>({
		resolver: zodResolver(generationFormValuesSchema),
		mode: "onChange",
		defaultValues: {
			productKey: resolvedInitialProductKey,
			skuKey: initialSelection?.skuKey ?? initialContract.defaultSkuKey,
			prompt:
				initialDraft?.input.prompt ??
				effectPreset?.prompt ??
				toolPrompt?.initialPrompt ??
				examplePrompt,
			sourceAssetId: initialDraft?.input.sourceAssetId ?? "",
			aspectRatio:
				initialSelection?.aspectRatio ??
				toolPrompt?.initialAspectRatio ??
				(requestedOutputFormat === "gif" && !initialDraft
					? "1:1"
					: initialContract.defaultAspectRatio),
			outputFormat:
				initialSelection?.outputFormat ?? (!initialDraft ? requestedOutputFormat : undefined),
			frameCount: initialDraft?.input.frameCount,
			frameDurationMs: initialDraft?.input.frameDurationMs,
			background: initialSelection?.background,
		},
	});
	const values = form.watch();
	useReferencePromptCapture({
		ownerId,
		assetId: values.sourceAssetId,
		productKey: values.productKey,
		prompt: values.prompt,
		enabled: ready,
	});
	const product = products.find((candidate) => candidate.key === values.productKey);
	const passSelected = fundingSource === "IMAGE_PASS";
	const passAvailable = generation.imagePass?.data?.available;
	// A balance-read outage is not an admission verdict. Submit the selected funding
	// source once and let the authoritative quote/reservation validate current funds.
	const passAccessUnknown = Boolean(generation.imagePass?.isError || !generation.imagePass?.data);
	// Coverage and independent model access come from the owner's frozen grants.
	const passSkuAllowed = imagePassCoversSku(generation.imagePass?.data, values.skuKey);
	const passReady =
		passSelected && (passAccessUnknown || (passSkuAllowed && (passAvailable ?? 0) >= 1));
	const paidSelectionValid = !paidTemplate || isPaidTemplateSelection(values, effectPreset);
	function modelAccessAllowed(productKey: EditorProductKey, skuKey: unknown) {
		if (
			paidTemplate &&
			!isPaidTemplateSelection(
				{ productKey, skuKey: typeof skuKey === "string" ? skuKey : null },
				effectPreset,
			)
		)
			return false;
		return (
			(allowedProductKeys.includes(productKey) &&
				allowedImageSkuKeys.includes(skuKey as ImageSkuKey)) ||
			(!passSelected &&
				generation.creditAccount.data?.adminTestSkuKeys?.includes(skuKey as ImageSkuKey)) ||
			(passSelected &&
				(passAccessUnknown ||
					((passAvailable ?? 0) >= 1 &&
						imagePassIncludesSkuAccess(generation.imagePass?.data, skuKey))))
		);
	}
	const upgradeRequired = Boolean(product && !modelAccessAllowed(values.productKey, values.skuKey));
	const selectedCell = getImageSpecCell(product?.skuMatrix, values.skuKey);
	const effectSelectionUnavailable = Boolean(
		ready &&
		effectEditor &&
		(!paidSelectionValid ||
			generation.catalog.isError ||
			(generation.catalog.data && !isEffectSelectionAvailable(values, products))),
	);
	const supportedAspectRatios = useMemo(
		() =>
			values.outputFormat === "gif" ? ["1:1" as const] : publicImageAspectRatios(selectedCell),
		[values.outputFormat, selectedCell],
	);
	const controlValues = useMemo(
		() =>
			resolveImageSpecControlValues(selectedCell, {
				outputFormat: values.outputFormat,
				background: values.background,
				frameCount: values.frameCount,
				frameDurationMs: values.frameDurationMs,
			}),
		[
			selectedCell,
			values.background,
			values.outputFormat,
			values.frameCount,
			values.frameDurationMs,
		],
	);
	const input = useMemo(() => {
		if (
			!product ||
			!selectedCell ||
			effectSelectionUnavailable ||
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
		effectSelectionUnavailable,
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
	useGenerationAnalytics(
		{
			mediaKind: "image",
			phase: error ? "blocked" : sourcePending ? "uploading" : "editing",
			publicModel: values.productKey,
			textLength: textLengthBucket(values.prompt.trim().length),
			inputCount: values.sourceAssetId ? 1 : 0,
			...(error ? { reason: generationErrorCategory(errorKey) } : {}),
		},
		active,
	);
	const safetyOutcome = getPromptSafetyOutcome(error);
	const selectionCredits = selectedCell
		? getImageGenerationCredits({ skuKey: values.skuKey, ...controlValues })
		: product?.credits;
	const displayedCredits = generation.quote?.credits ?? selectionCredits;
	const paidCreditBalance = generation.creditAccount.isError
		? undefined
		: generation.creditAccount.data?.spendableCredits;
	const paidCreditsInsufficient =
		displayedCredits !== undefined &&
		paidCreditBalance !== undefined &&
		Number(paidCreditBalance) < Number(displayedCredits);
	// Use an owned eligible pass when credits cannot access the model, including GIF/SVG pages.
	// The selected pass and one-pass cost remain visible; never replace an explicit choice.
	useEffect(() => {
		if (
			ownerId &&
			ownedFunding?.ownerId !== ownerId &&
			!generation.imagePass?.isError &&
			(passAvailable ?? 0) > 0 &&
			imagePassIncludesSkuAccess(generation.imagePass?.data, values.skuKey) &&
			((paidTemplate && paidCreditsInsufficient) ||
				!(
					(allowedProductKeys.includes(values.productKey) &&
						allowedImageSkuKeys.includes(values.skuKey)) ||
					generation.creditAccount.data?.adminTestSkuKeys?.includes(values.skuKey)
				))
		) {
			setOwnedFunding({ ownerId, source: "IMAGE_PASS" });
		}
	}, [
		paidTemplate,
		ownerId,
		ownedFunding,
		generation.imagePass?.isError,
		generation.imagePass?.data,
		passAvailable,
		values.productKey,
		values.skuKey,
		allowedProductKeys,
		allowedImageSkuKeys,
		paidCreditsInsufficient,
		generation.creditAccount.data?.adminTestSkuKeys,
	]);
	const isImageEdit = requireReference || sourcePending || Boolean(values.sourceAssetId);
	const suggestionKeys = isImageEdit
		? ["background", "object", "lighting", "style"]
		: ["portrait", "product", "landscape", "illustration"];
	const suggestions = suggestionKeys.map((key) =>
		isImageEdit ? t(`suggestions.${key}`) : composer(`ideas.${key}.prompt`),
	);

	useEffect(() => {
		if (upgradeOpen) void saasGrowthFunnel.upgradePromptViewed(values.productKey);
	}, [upgradeOpen, values.productKey]);

	const invalidateGenerationAction = generation.beginNewAction;
	const beginNewAction = useCallback(() => {
		actionVersion.current += 1;
		invalidateGenerationAction();
	}, [invalidateGenerationAction]);
	useEffectEditorBinding({
		prompt: values.prompt,
		busy: generation.createGeneration.isPending || sourcePending,
		hasCustomChanges: (preset) => hasEffectPresetChanges(form.getValues(), preset),
		applyPreset: (preset) => {
			form.reset(applyEffectPresetToValues(form.getValues(), preset));
			beginNewAction();
		},
	});
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
		(sourceAssetId: string, reference?: TemporaryReferenceReceipt) => {
			if (sourceAssetId === form.getValues("sourceAssetId")) return;
			setTemporaryReference(reference);
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
	useToolPromptBinding({
		prompt: values.prompt,
		busy: !ready || generation.createGeneration.isPending || sourcePending,
		applyPrompt: (prompt, options) => {
			if (options?.aspectRatio && !supportedAspectRatios.includes(options.aspectRatio))
				return false;
			updatePrompt(prompt);
			if (options?.aspectRatio)
				form.setValue("aspectRatio", options.aspectRatio, {
					shouldDirty: true,
					shouldValidate: true,
				});
			if (options?.clearReference) updateSourceAsset("");
			return true;
		},
	});

	useEffect(() => {
		function selectPrompt(event: Event) {
			const detail = (event as CustomEvent<LandingPromptSelectedDetail>).detail;
			if (typeof detail?.prompt === "string" && detail.prompt.trim()) {
				event.preventDefault();
				updatePrompt(detail.prompt.slice(0, 10000));
				const selection = detail.selection;
				const parsed = selection && parseImageSelection(selection.productKey, selection);
				if (selection && parsed && isEditorProductKey(selection.productKey) && !paidTemplate) {
					form.setValue("productKey", selection.productKey, {
						shouldDirty: true,
						shouldValidate: true,
					});
					for (const field of [
						"skuKey",
						"aspectRatio",
						"outputFormat",
						"background",
						"frameCount",
						"frameDurationMs",
					] as const) {
						form.setValue(field, parsed[field], { shouldDirty: true, shouldValidate: true });
					}
					replaceImageModelInUrl(selection.productKey);
				}
			}
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
	}, [updatePrompt, updateSourceAsset, form, paidTemplate]);

	useEffect(() => {
		if (!onDraftChange) return;
		onDraftChange(form.getValues(), temporaryReference, fundingSource);
		const subscription = form.watch(() =>
			onDraftChange(form.getValues(), temporaryReference, fundingSource),
		);
		return () => subscription.unsubscribe();
	}, [form, onDraftChange, temporaryReference, fundingSource]);

	function replaceControlValues(cell: PublicImageSpecCell) {
		const next = resolveImageSpecControlValues(cell, form.getValues());
		form.unregister(["outputFormat", "background", "frameCount", "frameDurationMs"]);
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
		form.setValue("frameCount", next.frameCount);
		form.setValue("frameDurationMs", next.frameDurationMs);
	}

	function updateProduct(productKey: EditorProductKey, skuKey?: string) {
		if (
			paidTemplate &&
			!isPaidTemplateSelection(
				{ productKey, skuKey: skuKey ?? effectPreset?.parameters.skuKey },
				effectPreset,
			)
		)
			return;
		if (skuKey && productKey === values.productKey) {
			updateSku(skuKey);
			return;
		}
		const nextProduct = products.find((candidate) => candidate.key === productKey);
		const defaultCell =
			(skuKey ? getImageSpecCell(nextProduct?.skuMatrix, skuKey) : undefined) ??
			getDefaultImageSpecCell(nextProduct?.skuMatrix);
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
		const nextAspectRatio =
			form.getValues("outputFormat") === "gif" ? "1:1" : publicImageAspectRatios(defaultCell)[0];
		if (nextAspectRatio) {
			form.setValue("aspectRatio", nextAspectRatio, {
				shouldDirty: true,
				shouldValidate: true,
			});
		}
		beginNewAction();
	}
	const modelNavigation = useModelNavigation({
		products,
		value: values.productKey,
		ready:
			ready &&
			!effectEditor &&
			Boolean(generation.catalog.data) &&
			!generation.createGeneration.isPending,
		onSelect: updateProduct,
	});

	function updateSku(skuKey: string) {
		if (
			paidTemplate &&
			!isPaidTemplateSelection({ productKey: values.productKey, skuKey }, effectPreset)
		)
			return;
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
		beginNewAction();
	}

	function updateAspectRatio(aspectRatio: ImageAspectRatio) {
		form.setValue("aspectRatio", aspectRatio, { shouldDirty: true, shouldValidate: true });
		beginNewAction();
	}

	function updateControl(key: ImageSpecControlChangeKey, value: string) {
		const next = resolveImageSpecControlValues(
			selectedCell,
			{ ...controlValues, [key]: value },
			key,
		);
		if (String(next[key]) !== value) return;
		for (const field of ["outputFormat", "background", "frameCount", "frameDurationMs"] as const) {
			form.setValue(field, next[field], { shouldDirty: true, shouldValidate: true });
		}
		if (next.outputFormat === "gif")
			form.setValue("aspectRatio", "1:1", { shouldDirty: true, shouldValidate: true });
		beginNewAction();
	}

	const saveDraftForPurchase = useCallback((): boolean => {
		const current = form.getValues();
		const currentProduct = products.find((candidate) => candidate.key === current.productKey);
		const currentCell = getImageSpecCell(currentProduct?.skuMatrix, current.skuKey);
		const currentControls = resolveImageSpecControlValues(currentCell, {
			outputFormat: current.outputFormat,
			background: current.background,
			frameCount: current.frameCount,
			frameDurationMs: current.frameDurationMs,
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
			parentJobId: current.sourceAssetId && !temporaryReference ? (parentJobId ?? null) : null,
			temporaryReference,
			sourceReady,
		});
		if (!saved) {
			setUpgradeStorageUnavailable(true);
			setUpgradeOpen(true);
		}
		return saved;
	}, [form, products, temporaryReference, parentJobId, sourceReady]);

	const continueToImagePass = useCallback(() => {
		if (!ownerId) return false;
		let saved = false;
		try {
			saved = saveWorkspaceDraft(
				window.sessionStorage,
				ownerId,
				{
					values: form.getValues(),
					parentJobId: temporaryReference ? null : (parentJobId ?? null),
					temporaryReference,
					fundingSource: paidTemplate ? "IMAGE_PASS" : fundingSource,
				},
				Date.now(),
				workspaceDraftPath,
			);
		} catch {
			// Keep the draft in place when browser storage is unavailable.
		}
		if (!saved) {
			setUpgradeStorageUnavailable(true);
			setUpgradeOpen(true);
			return false;
		}
		captureCheckoutTrigger();
		router.push("/image-pass");
		return true;
	}, [
		ownerId,
		form,
		temporaryReference,
		parentJobId,
		paidTemplate,
		fundingSource,
		workspaceDraftPath,
		router,
	]);

	const continueToUpgrade = useCallback(() => {
		if (!saveDraftForPurchase()) return false;
		void saasGrowthFunnel.upgradePromptViewed(values.productKey);
		captureCheckoutTrigger();
		router.push(
			createChoosePlanPath(effectEditor?.getReturnPath("upgrade") ?? "/create?upgrade=complete"),
		);
		return true;
	}, [saveDraftForPurchase, values.productKey, router, effectEditor]);

	async function confirmGeneration() {
		if (
			!ownerId ||
			!ready ||
			!input ||
			!paidSelectionValid ||
			displayedCredits === undefined ||
			(passSelected && !passReady) ||
			sourcePendingRef.current ||
			submittingRef.current
		)
			return;
		const operation = {};
		const version = actionVersion.current;
		submittingRef.current = operation;
		try {
			const result = await generation.createGeneration.mutateAsync({
				productKey: values.productKey,
				input,
				expectedCredits: String(displayedCredits),
				fundingSource,
				temporaryReferenceToken: temporaryReference?.token,
			});
			if (
				!result ||
				!mounted.current ||
				currentOwner.current !== ownerId ||
				actionVersion.current !== version
			)
				return;
			acceptedJob.current = { id: result.job.id, ownerId };
			onCreated(result.job.id);
			beginNewAction();
		} catch {
			// The mutation exposes only a stable, translated public error below.
		} finally {
			if (submittingRef.current === operation) submittingRef.current = null;
		}
	}
	useEffect(() => {
		if (
			!paidTemplate ||
			!effectEditor ||
			!ownerId ||
			!ready ||
			!sourceReady ||
			!values.sourceAssetId ||
			sourcePending ||
			!paidSelectionValid
		)
			return;
		try {
			const pending = readPaidTemplatePurchase(window.sessionStorage, {
				effectId: effectEditor.effect.id,
				presetId: effectEditor.selectedPreset.id,
			});
			if (!pending) return;
			// Sign-in may reveal an existing purchase. Let that owner continue in the editor.
			if (!generation.imagePass?.isError && passAvailable === undefined) return;
			const subscriptionEligible =
				allowedProductKeys.includes(values.productKey) &&
				allowedImageSkuKeys.includes(values.skuKey);
			if (subscriptionEligible && paidCreditBalance === undefined) return;
			if (
				(subscriptionEligible && !paidCreditsInsufficient) ||
				(!generation.imagePass?.isError &&
					(passAvailable ?? 0) > 0 &&
					imagePassIncludesSkuAccess(generation.imagePass?.data, values.skuKey))
			) {
				clearPaidTemplatePurchase(window.sessionStorage);
				return;
			}
			const saved = pending === "image-pass" ? continueToImagePass() : continueToUpgrade();
			if (saved) clearPaidTemplatePurchase(window.sessionStorage);
		} catch {
			setUpgradeStorageUnavailable(true);
		}
	}, [
		paidTemplate,
		effectEditor,
		ownerId,
		ready,
		sourceReady,
		values.sourceAssetId,
		sourcePending,
		paidSelectionValid,
		continueToImagePass,
		continueToUpgrade,
		generation.imagePass?.isError,
		generation.imagePass?.data,
		passAvailable,
		allowedProductKeys,
		allowedImageSkuKeys,
		values.productKey,
		values.skuKey,
		paidCreditBalance,
		paidCreditsInsufficient,
	]);

	return (
		<form
			data-task-order="source-prompt-service-action"
			data-composer-design="compact"
			data-composer-kind={isImageEdit ? "image-to-image" : "text-to-image"}
			className="studio-composer"
			data-layout={layout}
			data-test="registered-generator"
			data-editor-ready={ready}
			aria-busy={!ready}
			inert={!ready}
			id="registered-generator"
			onSubmit={form.handleSubmit((validated) => {
				trackGenerationAction({
					mediaKind: "image",
					phase: "confirm",
					publicModel: validated.productKey,
					textLength: textLengthBucket(validated.prompt.trim().length),
					inputCount: validated.sourceAssetId ? 1 : 0,
				});
				if (
					!modelAccessAllowed(validated.productKey, validated.skuKey) ||
					(paidTemplate && passSelected && !passReady)
				) {
					setUpgradeOpen(true);
					return;
				}
				void confirmGeneration();
			})}
		>
			{(!ready || (effectEditor && !generation.catalog.data && !generation.catalog.isError)) && (
				<output className="mb-3 text-sm block text-muted-foreground">{t("checking")}</output>
			)}
			{effectSelectionUnavailable && (
				<output className="mb-3 text-sm text-amber-200 block">{effects("modelUnavailable")}</output>
			)}
			<ComposerHeader />
			<ImageFundingSelector
				value={fundingSource}
				available={passAvailable}
				creditsAvailable={
					generation.creditAccount.isError
						? undefined
						: generation.creditAccount.data?.spendableCredits
				}
				reserved={generation.imagePass?.data?.reserved}
				failed={generation.imagePass?.isError}
				onRefresh={() => {
					void generation.imagePass?.refetch();
				}}
				disabled={generation.createGeneration.isPending}
				onChange={(source) => {
					setOwnedFunding({ ownerId, source });
					beginNewAction();
				}}
			/>
			{passSelected && !passAccessUnknown && !passSkuAllowed && (
				<output
					data-testid="image-pass-size-not-eligible"
					className="text-xs leading-5 text-amber-600 dark:text-amber-300 block"
				>
					{pass("fundingSizeNotEligible")}
				</output>
			)}
			{modelNavigation.unavailable && (
				<output className="mb-3 text-sm text-amber-200 block">
					{studio("tools.modelUnavailable")}
				</output>
			)}
			{requireReference && !values.sourceAssetId && (
				<p className="mb-3 text-sm text-violet-200">{imageToImage("referenceNotice")}</p>
			)}
			<div className="studio-composer-inputs">
				<PromptPanel
					referenceFirst
					disabled={generation.createGeneration.isPending}
					referencePanel={
						toolPrompt?.allowReference !== false && (
							<ImageSourcePanel
								active={active}
								ownerId={ownerId}
								compact
								presentation="composer"
								label={requireReference ? imageToImage("referenceLabel") : undefined}
								uploadLabel={
									requireReference ? imageToImage("referenceLabel") : composer("addReference")
								}
								sourceAssetId={values.sourceAssetId}
								temporaryReference={temporaryReference}
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
						)
					}
					maxLength={getImageProductSelectionContract(values.productKey)?.maximumPromptLength}
					label={isImageEdit ? t("fields.prompt") : studio("generation.promptLabel")}
					hint={isImageEdit ? composer("editHint") : composer("createHint")}
					suggestionsLabel={isImageEdit ? t("suggestions.label") : composer("promptIdeas")}
					suggestions={suggestions}
					suggestionLabels={suggestionKeys.map((key) =>
						isImageEdit ? studio(`promptSuggestions.${key}`) : composer(`ideas.${key}.label`),
					)}
					value={values.prompt}
					onChange={updatePrompt}
				/>
			</div>
			<div className="studio-composer-controls">
				<div className="image-edit-control-field composer-model-field">
					<span className="image-edit-control-label" aria-hidden="true">
						{imageToImage("composer.modelLabel")}
					</span>
					<ImageModelSelector
						idPrefix="editor"
						fundingCostLabel={passSelected ? pass("onePass") : undefined}
						products={products.flatMap((candidate) =>
							candidate.skuMatrix
								? [
										{
											...candidate,
											skuMatrix: candidate.skuMatrix,
											requiresUpgradeSkuKeys: candidate.skuMatrix.cells
												.filter(
													(cell) =>
														isEditorProductKey(candidate.key) &&
														!modelAccessAllowed(candidate.key, cell.skuKey),
												)
												.map((cell) => cell.skuKey),
											requiresUpgrade:
												isEditorProductKey(candidate.key) &&
												!modelAccessAllowed(
													candidate.key,
													candidate.key === values.productKey
														? values.skuKey
														: candidate.skuMatrix.defaultSkuKey,
												),
										},
									]
								: [],
						)}
						value={values.productKey}
						skuKey={values.skuKey}
						valueLabel={t(`products.${values.productKey}.label`)}
						onChange={(key, skuKey) => {
							if (isEditorProductKey(key)) {
								updateProduct(key, skuKey);
								if (!effectEditor) replaceImageModelInUrl(key);
							}
						}}
						disabled={paidTemplate || generation.createGeneration.isPending}
					/>
				</div>
				<div className="image-edit-control-field composer-output-field">
					<ImageOutputSettings
						idPrefix="editor"
						fundingCostLabel={passSelected ? pass("onePass") : undefined}
						presentation="composer"
						disabled={generation.createGeneration.isPending}
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
							oneImage: composer("oneImage"),
							shortAutomatic: composer("automatic"),
							coupledHint: composer("coupledHint"),
							trigger: t("outputSettings.trigger"),
							aspectRatio: t("outputSettings.aspectRatio"),
							automatic: t("outputSettings.automatic"),
							outputNumber: t("outputSettings.outputNumber"),
							oneOutput: t("outputSettings.oneOutput"),
							resolution: t("outputSettings.resolution"),
							quality: t("outputSettings.quality"),
							outputFormat: t("outputSettings.outputFormat"),
							background: t("outputSettings.background"),
							frameCount: t("outputSettings.frameCount"),
							frameDurationMs: t("outputSettings.frameDurationMs"),
							gifCanvas: t("outputSettings.gifCanvas"),
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
								svg: "SVG",
								gif: "GIF",
								auto: t("outputSettings.optionLabels.auto"),
								opaque: t("outputSettings.optionLabels.opaque"),
								transparent: t("outputSettings.optionLabels.transparent"),
							},
						}}
					/>
				</div>
				{upgradeRequired && !paidTemplate ? (
					<Button
						type="button"
						variant="primary"
						className="studio-submit"
						data-test="editor-model-upgrade"
						disabled={generation.createGeneration.isPending}
						onClick={continueToUpgrade}
					>
						<span>{t("modelMenu.viewPlans")}</span>
						<span className="composer-submit-cost">
							{composer("creditAmount", { credits: displayedCredits ?? "—" })}
						</span>
					</Button>
				) : (
					<Button
						type="submit"
						data-test="generation-submit"
						variant="primary"
						className="studio-submit"
						disabled={
							!input ||
							(!paidTemplate && passSelected && !passReady) ||
							generation.createQuote.isPending ||
							generation.createGeneration.isPending
						}
						loading={generation.createGeneration.isPending}
					>
						{generation.createQuote.isPending ? (
							t("checking")
						) : generation.createGeneration.isPending ? (
							t("starting")
						) : (
							<>
								<span>{composer(isImageEdit ? "edit" : "generate")}</span>
								<span className="composer-submit-cost">
									{passSelected
										? pass("onePass")
										: composer("creditAmount", { credits: displayedCredits ?? "—" })}
								</span>
							</>
						)}
					</Button>
				)}
			</div>
			{sourcePending && (
				<output className="mt-3 text-xs text-amber-200 block">
					{studio("generation.referencePending")}
				</output>
			)}
			{upgradeRequired && product && !paidTemplate && (
				<output
					data-test="editor-model-access-notice"
					className="mt-3 text-xs leading-5 text-violet-200 block"
				>
					{product.key === "image-minimax-h3"
						? t("modelMenu.minimaxUpgradeNotice")
						: t("modelMenu.upgradeNotice", { model: product.label })}
				</output>
			)}
			<div className="image-edit-composer-meta composer-meta">
				<details className="mt-3 text-xs text-muted-foreground">
					<summary className="py-2 cursor-pointer">
						{passSelected ? pass("fundingPolicyTitle") : t("creditPolicy")}
					</summary>
					<p className="mt-1 leading-relaxed">
						{passSelected ? pass("fundingPolicy") : t("moderationBillingPolicy")}
					</p>
				</details>
			</div>
			{error && safetyOutcome ? (
				<ContentSafetyNotice
					stage="prompt"
					outcome={safetyOutcome}
					reason={getModerationErrorReason(error)}
					billing="beforeGeneration"
					fundingSource={fundingSource}
					onRevise={() => document.getElementById("generation-prompt")?.focus()}
				/>
			) : error ? (
				<Alert variant="error">
					<AlertDescription>
						{t(`errors.${errorKey}`)}
						{errorKey === "insufficientImagePasses" && (
							<button
								type="button"
								data-testid="image-pass-buy-more"
								onClick={continueToImagePass}
								className="mt-2 block underline underline-offset-4"
							>
								{pass("buyMore")}
							</button>
						)}
						{errorKey === "insufficientCredits" && product && (
							<CreditBalanceSummary
								requiredCredits={selectionCredits ?? product.credits}
								availableCredits={generation.creditAccount.data?.spendableCredits ?? "0"}
								onUpgrade={continueToUpgrade}
							/>
						)}
					</AlertDescription>
				</Alert>
			) : null}
			{paidTemplate ? (
				<PaidTemplateDialog
					open={upgradeOpen && active}
					onOpenChange={setUpgradeOpen}
					onImagePass={continueToImagePass}
					onPlans={continueToUpgrade}
					storageUnavailable={upgradeStorageUnavailable}
				/>
			) : (
				<EditorUpgradeDialog
					modelLabel={product?.label}
					modelProductKey={values.productKey}
					open={upgradeOpen && active}
					onOpenChange={(open) => {
						setUpgradeOpen(open);
						if (!open) setUpgradeStorageUnavailable(false);
					}}
					onContinue={continueToUpgrade}
					storageUnavailable={upgradeStorageUnavailable}
				/>
			)}
			<RegisteredEditorDock prompt={values.prompt} jobId={jobId} />
		</form>
	);
}

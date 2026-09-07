"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CreditBalanceSummary } from "@payments/components/CreditBalanceSummary";
import { EditorUpgradeDialog } from "@payments/components/EditorUpgradeDialog";
import { createChoosePlanPath, writeEditorUpgradeDraft } from "@payments/lib/editor-upgrade";
import { EZPIC_PRODUCT_KEYS, getPlanEntitlement, type ImageAspectRatio } from "@repo/config/client";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { useRouter } from "@shared/hooks/router";
import { saasGrowthFunnel } from "@shared/lib/growth-analytics";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { useGeneration } from "../hooks/use-generation";
import { resolveEditorProductSelection } from "../lib/editor-entitlement";
import { getEditorErrorKey } from "../lib/editor-error";
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
import { EditModeSelector } from "./editor/EditModeSelector";
import { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";
import { ImageOutputSettings } from "./ImageOutputSettings";

export function GenerationForm({
	onCreated,
	initialDraft,
	allowedProductKeys = [...EZPIC_PRODUCT_KEYS],
	initialSourceReady = false,
	parentJobId,
}: {
	onCreated: (jobId: string) => void;
	initialDraft?: EditorDraftInput | null;
	allowedProductKeys?: EditorProductKey[];
	initialSourceReady?: boolean;
	parentJobId?: string | null;
}) {
	const t = useTranslations("media.create");
	const router = useRouter();
	const generation = useGeneration({ parentJobId });
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
	const [upgradeOpen, setUpgradeOpen] = useState(
		Boolean(initialDraft && !allowedProductKeys.includes(initialDraft.productKey)),
	);
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
			!supportedAspectRatios.includes(values.aspectRatio) ||
			!sourceReady ||
			!values.prompt.trim() ||
			!values.sourceAssetId
		) {
			return null;
		}
		try {
			return buildGenerationInput({
				kind: "image-to-image",
				prompt: values.prompt,
				sourceAssetId: values.sourceAssetId,
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
		supportedAspectRatios,
		values.aspectRatio,
		values.prompt,
		values.skuKey,
		values.sourceAssetId,
	]);
	const error = generation.createQuote.error ?? generation.createGeneration.error;
	const errorKey = getEditorErrorKey(error);
	const suggestions = ["background", "object", "lighting", "style"].map((key) =>
		t(`suggestions.${key}`),
	);

	useEffect(() => {
		if (upgradeOpen) void saasGrowthFunnel.upgradePromptViewed(values.productKey);
	}, [upgradeOpen, values.productKey]);

	function updatePrompt(prompt: string) {
		form.setValue("prompt", prompt, { shouldDirty: true, shouldValidate: true });
		generation.beginNewAction();
	}

	function updateSourceAsset(sourceAssetId: string) {
		form.setValue("sourceAssetId", sourceAssetId, {
			shouldDirty: true,
			shouldValidate: true,
		});
		generation.beginNewAction();
	}

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
		const selection = resolveEditorProductSelection(productKey, allowedProductKeys);
		const nextProduct = products.find((candidate) => candidate.key === productKey);
		const defaultCell = getDefaultImageSpecCell(nextProduct?.skuMatrix);
		if (!defaultCell) return;
		form.setValue("productKey", selection.productKey, {
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
		if (selection.upgradeRequired) setUpgradeOpen(true);
	}

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
					kind: "image-to-image",
					prompt: current.prompt,
					sourceAssetId: current.sourceAssetId,
					skuKey: current.skuKey,
					aspectRatio: current.aspectRatio,
					...currentControls,
				},
			},
			parentJobId: parentJobId ?? null,
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
		try {
			if (!generation.quote) return;
			await saasGrowthFunnel.generationConfirmed(generation.quote.id, generation.quote.productKey);
			const result = await generation.createGeneration.mutateAsync();
			onCreated(result.job.id);
			generation.beginNewAction();
		} catch {
			// The mutation exposes only a stable, translated public error below.
		}
	}

	return (
		<form
			data-task-order="source-prompt-service-action"
			className="space-y-6"
			onSubmit={form.handleSubmit((validated) => {
				if (!allowedProductKeys.includes(validated.productKey)) {
					setUpgradeOpen(true);
					return;
				}
				if (input) generation.createQuote.mutate({ productKey: validated.productKey, input });
			})}
		>
			<ImageSourcePanel
				sourceAssetId={values.sourceAssetId}
				maximumImageBytes={
					generation.creditAccount.data?.maximumInputBytes ??
					getPlanEntitlement("free").maximumInputBytes
				}
				onReadyChange={setSourceReady}
				onChange={(assetId) => {
					setSourceReady(false);
					updateSourceAsset(assetId);
				}}
			/>
			<PromptPanel
				label={t("fields.prompt")}
				hint={t("promptHint")}
				suggestionsLabel={t("suggestions.label")}
				suggestions={suggestions}
				value={values.prompt}
				onChange={updatePrompt}
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
				tone="light"
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
			<EditModeSelector
				value={values.productKey}
				onChange={updateProduct}
				onUpgrade={continueToUpgrade}
				products={products}
				allowedProductKeys={allowedProductKeys}
			/>
			{generation.quote ? (
				<div className="p-4 rounded-xl border bg-muted/40" aria-live="polite">
					<p className="font-medium">{t("quoteReady")}</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("quoteMode", {
							mode: product?.label ?? generation.quote.productKey,
							credits: generation.quote.credits,
						})}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("quoteExpires", {
							time: new Date(generation.quote.expiresAt).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							}),
						})}
					</p>
					<div className="mt-4 gap-2 flex flex-wrap">
						<Button
							type="button"
							variant="primary"
							loading={generation.createGeneration.isPending}
							disabled={generation.createGeneration.isPending}
							onClick={() => void confirmGeneration()}
						>
							{t("confirm")}
						</Button>
						<Button type="button" variant="ghost" onClick={generation.beginNewAction}>
							{t("edit")}
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="submit"
					variant="primary"
					className="min-h-12 bg-indigo-600 hover:bg-indigo-700 w-full"
					disabled={!input}
					loading={generation.createQuote.isPending}
				>
					{t("review")}
				</Button>
			)}
			{error && (
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
			)}
			<EditorUpgradeDialog
				open={upgradeOpen}
				onOpenChange={(open) => {
					setUpgradeOpen(open);
					if (!open) setUpgradeStorageUnavailable(false);
				}}
				onContinue={continueToUpgrade}
				storageUnavailable={upgradeStorageUnavailable}
			/>
		</form>
	);
}

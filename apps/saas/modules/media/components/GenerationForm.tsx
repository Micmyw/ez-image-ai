"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { useGeneration } from "../hooks/use-generation";
import { getEditorErrorKey } from "../lib/editor-error";
import type { EditorDraftInput, EditorProductKey } from "../lib/editor-recovery";
import {
	buildGenerationInput,
	type GenerationFormValues,
	generationFormValuesSchema,
} from "../lib/form-schema";
import { EditModeSelector } from "./editor/EditModeSelector";
import { ImageSourcePanel } from "./editor/ImageSourcePanel";
import { PromptPanel } from "./editor/PromptPanel";

export function GenerationForm({
	onCreated,
	initialDraft,
	allowedProductKeys = ["image-fast", "image-quality"],
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
	const generation = useGeneration({ parentJobId });
	const products = generation.catalog.data?.products ?? [];
	const [sourceReady, setSourceReady] = useState(initialSourceReady);
	const form = useForm<GenerationFormValues>({
		resolver: zodResolver(generationFormValuesSchema),
		mode: "onChange",
		defaultValues: {
			productKey: initialDraft?.productKey ?? "image-fast",
			prompt: initialDraft?.input.prompt ?? "",
			sourceAssetId: initialDraft?.input.sourceAssetId ?? "",
		},
	});
	const values = form.watch();
	const product = products.find((candidate) => candidate.key === values.productKey);
	const input = useMemo(() => {
		if (!product || !sourceReady || !values.prompt.trim() || !values.sourceAssetId) return null;
		try {
			return buildGenerationInput({
				kind: "image-to-image",
				prompt: values.prompt,
				sourceAssetId: values.sourceAssetId,
			});
		} catch {
			return null;
		}
	}, [product, sourceReady, values.prompt, values.sourceAssetId]);
	const error = generation.createQuote.error ?? generation.createGeneration.error;
	const suggestions = ["background", "object", "lighting", "style"].map((key) =>
		t(`suggestions.${key}`),
	);

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

	function updateProduct(productKey: EditorProductKey) {
		form.setValue("productKey", productKey, { shouldDirty: true, shouldValidate: true });
		generation.beginNewAction();
	}

	async function confirmGeneration() {
		try {
			const result = await generation.createGeneration.mutateAsync();
			onCreated(result.job.id);
			generation.beginNewAction();
		} catch {
			// The mutation exposes only a stable, translated public error below.
		}
	}

	return (
		<form
			className="space-y-6"
			onSubmit={form.handleSubmit((validated) => {
				if (input) generation.createQuote.mutate({ productKey: validated.productKey, input });
			})}
		>
			<ImageSourcePanel
				sourceAssetId={values.sourceAssetId}
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
			<EditModeSelector
				value={values.productKey}
				onChange={updateProduct}
				products={products}
				allowedProductKeys={allowedProductKeys}
			/>
			{generation.quote ? (
				<div className="p-4 rounded-xl border bg-muted/40" aria-live="polite">
					<p className="font-medium">{t("quoteReady")}</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("quoteMode", {
							mode: t(`products.${generation.quote.productKey}.label`),
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
					className="w-full"
					disabled={!input}
					loading={generation.createQuote.isPending}
				>
					{t("review")}
				</Button>
			)}
			{error && (
				<Alert variant="error">
					<AlertDescription>{t(`errors.${getEditorErrorKey(error)}`)}</AlertDescription>
				</Alert>
			)}
		</form>
	);
}

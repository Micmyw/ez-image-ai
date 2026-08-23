"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/components/select";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";

import { useGeneration } from "../hooks/use-generation";
import {
	buildGenerationInput,
	type GenerationFormValues,
	generationFormValuesSchema,
} from "../lib/form-schema";
import { GenerationFields, type PublicField } from "./GenerationFields";

type ProductKey = GenerationFormValues["productKey"];

export function GenerationForm({
	onCreated,
	initialDraft,
}: {
	onCreated: (jobId: string) => void;
	initialDraft?: { productKey: string | null; input: Record<string, unknown> } | null;
}) {
	const t = useTranslations("media.create");
	const generation = useGeneration();
	const products = generation.catalog.data?.products ?? [];
	const draftPrompt = initialDraft?.input.prompt;
	const draftDuration = initialDraft?.input.durationSeconds;
	const draftSourceAssetId = initialDraft?.input.sourceAssetId;
	const initialProductKey = isProductKey(initialDraft?.productKey)
		? initialDraft.productKey
		: "image-fast";
	const form = useForm<GenerationFormValues>({
		resolver: zodResolver(generationFormValuesSchema),
		mode: "onChange",
		defaultValues: {
			productKey: initialProductKey,
			prompt: typeof draftPrompt === "string" ? draftPrompt : "",
			aspectRatio: "1:1",
			durationSeconds: typeof draftDuration === "number" ? draftDuration : 5,
			sourceAssetId:
				typeof draftSourceAssetId === "string" && draftSourceAssetId
					? draftSourceAssetId
					: undefined,
		},
	});
	const values = form.watch();
	const product = products.find((candidate) => candidate.key === values.productKey) ?? products[0];
	const durationField = product?.fields.find((field) => field.key === "durationSeconds");
	const effectiveDuration = clampToField(values.durationSeconds, durationField);
	const input = useMemo(() => {
		if (!product || !values.prompt.trim()) return null;
		const sourceAssetId = values.sourceAssetId || undefined;
		const kind =
			product.mediaKind === "image"
				? sourceAssetId
					? "image-to-image"
					: "text-to-image"
				: sourceAssetId
					? "image-to-video"
					: "text-to-video";
		try {
			return buildGenerationInput({
				kind,
				prompt: values.prompt,
				sourceAssetId,
				aspectRatio: values.aspectRatio,
				...(product.mediaKind === "video" ? { durationSeconds: effectiveDuration } : {}),
			});
		} catch {
			return null;
		}
	}, [effectiveDuration, product, values]);
	const error = generation.createQuote.error ?? generation.createGeneration.error;

	async function confirmGeneration() {
		const result = await generation.createGeneration.mutateAsync();
		onCreated(result.job.id);
		generation.beginNewAction();
	}

	return (
		<form
			className="space-y-6"
			onSubmit={form.handleSubmit((validated) => {
				if (input) generation.createQuote.mutate({ productKey: validated.productKey, input });
			})}
		>
			<div className="space-y-2">
				<label htmlFor="generation-product" className="font-medium text-sm">
					{t("product")}
				</label>
				<Controller
					control={form.control}
					name="productKey"
					render={({ field }) => (
						<Select
							value={field.value}
							onValueChange={(value) => {
								field.onChange(value as ProductKey);
								generation.beginNewAction();
							}}
						>
							<SelectTrigger id="generation-product" aria-label={t("product")}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{products.map((entry) => (
									<SelectItem key={entry.key} value={entry.key}>
										<span className="gap-4 flex items-center justify-between">
											<span>{entry.label}</span>
											<span className="text-xs text-muted-foreground">
												{entry.credits} {t("credits")}
											</span>
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				/>
				{product && <p className="text-sm text-muted-foreground">{product.description}</p>}
			</div>
			{product && (
				<GenerationFields
					fields={product.fields as PublicField[]}
					values={{ ...values, durationSeconds: effectiveDuration }}
					onChange={(key, value) => {
						form.setValue(key as keyof GenerationFormValues, value as never, {
							shouldDirty: true,
							shouldValidate: true,
						});
						generation.beginNewAction();
					}}
				/>
			)}
			{generation.quote ? (
				<div className="p-4 rounded-xl border bg-muted/40" aria-live="polite">
					<p className="font-medium">{t("quoteReady")}</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("reserveCredits", { credits: generation.quote.credits })}
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
					disabled={!input || !form.formState.isValid}
					loading={generation.createQuote.isPending}
				>
					{t("review")}
				</Button>
			)}
			{error && (
				<Alert variant="error">
					<AlertDescription>{t("safeError")}</AlertDescription>
				</Alert>
			)}
		</form>
	);
}

function isProductKey(value: string | null | undefined): value is ProductKey {
	return ["image-fast", "image-quality", "video-fast", "video-quality"].includes(value ?? "");
}

function clampToField(
	value: number,
	field: { min?: number; max?: number; step?: number } | undefined,
): number {
	const min = field?.min ?? 1;
	const max = field?.max ?? 30;
	const step = field?.step ?? 1;
	return Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step));
}

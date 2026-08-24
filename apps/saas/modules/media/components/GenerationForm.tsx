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
			sourceAssetId:
				typeof draftSourceAssetId === "string" && draftSourceAssetId ? draftSourceAssetId : "",
		},
	});
	const values = form.watch();
	const product = products.find((candidate) => candidate.key === values.productKey) ?? products[0];
	const input = useMemo(() => {
		if (!product || !values.prompt.trim() || !values.sourceAssetId) return null;
		try {
			return buildGenerationInput({
				kind: "image-to-image",
				prompt: values.prompt,
				sourceAssetId: values.sourceAssetId,
			});
		} catch {
			return null;
		}
	}, [product, values]);
	const error = generation.createQuote.error ?? generation.createGeneration.error;
	const getProductCopy = (key: string) => {
		if (key === "image-fast") {
			return {
				label: t("products.image-fast.label"),
				description: t("products.image-fast.description"),
			};
		}
		if (key === "image-quality") {
			return {
				label: t("products.image-quality.label"),
				description: t("products.image-quality.description"),
			};
		}
		return null;
	};
	const localizedFields = ((product?.fields ?? []) as PublicField[]).map((field) => ({
		...field,
		label:
			field.key === "prompt"
				? t("fields.prompt")
				: field.key === "sourceAssetId"
					? t("fields.sourceAssetId")
					: field.label,
	}));

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
											<span>{getProductCopy(entry.key)?.label ?? entry.label}</span>
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
				{product && (
					<p className="text-sm text-muted-foreground">
						{getProductCopy(product.key)?.description ?? product.description}
					</p>
				)}
			</div>
			{product && (
				<GenerationFields
					fields={localizedFields}
					values={values}
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
	return ["image-fast", "image-quality"].includes(value ?? "");
}

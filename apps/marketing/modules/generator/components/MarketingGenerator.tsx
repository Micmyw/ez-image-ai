"use client";

import { config } from "@config";
import { Alert, AlertDescription } from "@repo/ui/components/alert";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
	buildMarketingImageEditDraft,
	createMarketingDraft,
	submitMarketingDraftHandoff,
} from "../lib/draft-client";

export function MarketingGenerator() {
	const t = useTranslations("home.generator");
	const [prompt, setPrompt] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [hasError, setHasError] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	async function submit() {
		if (!config.saasUrl || !prompt.trim() || !file) return;
		setIsSubmitting(true);
		setHasError(false);
		try {
			const handoff = await createMarketingDraft(
				config.saasUrl,
				buildMarketingImageEditDraft({
					prompt,
					upload: {
						contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
						base64: await fileToBase64(file),
					},
				}),
			);
			submitMarketingDraftHandoff(handoff);
		} catch {
			setHasError(true);
			setIsSubmitting(false);
		}
	}
	return (
		<section
			id="how-it-works"
			className="scroll-mt-20 py-12 lg:py-16"
			aria-labelledby="generator-title"
		>
			<div className="container">
				<div className="overflow-hidden rounded-4xl border bg-card">
					<div className="lg:grid-cols-[0.9fr_1.1fr] grid">
						<div className="p-6 md:p-10 lg:p-12">
							<div className="gap-2 px-3 py-1 text-xs font-medium inline-flex items-center rounded-full bg-primary/10 text-primary">
								<SparklesIcon className="size-3.5" />
								{t("eyebrow")}
							</div>
							<h2 id="generator-title" className="mt-5 text-3xl font-medium lg:text-4xl">
								{t("title")}
							</h2>
							<p className="mt-3 text-foreground/60">{t("subtitle")}</p>
							<div className="mt-8 gap-3 text-sm grid grid-cols-3">
								<div>
									<strong className="text-xl block">1</strong>
									{t("steps.idea")}
								</div>
								<div>
									<strong className="text-xl block">2</strong>
									{t("steps.control")}
								</div>
								<div>
									<strong className="text-xl block">3</strong>
									{t("steps.create")}
								</div>
							</div>
						</div>
						<div className="p-5 md:p-8 lg:border-l lg:border-t-0 border-t bg-background">
							<div className="space-y-5">
								<div>
									<label htmlFor="marketing-prompt" className="mb-2 text-sm font-medium block">
										{t("prompt")}
									</label>
									<Textarea
										id="marketing-prompt"
										rows={7}
										maxLength={10000}
										value={prompt}
										placeholder={t("placeholder")}
										onChange={(event) => setPrompt(event.target.value)}
									/>
								</div>
								<div>
									<label htmlFor="marketing-reference" className="mb-2 text-sm font-medium block">
										{t("reference")}
									</label>
									<input
										id="marketing-reference"
										aria-label={t("reference")}
										type="file"
										required
										accept="image/jpeg,image/png,image/webp"
										className="text-sm file:mr-3 file:px-3 file:py-2 block w-full file:rounded-md file:border-0 file:bg-muted"
										onChange={(event) => setFile(event.target.files?.[0] ?? null)}
									/>
								</div>
								<Button
									className="w-full"
									size="lg"
									variant="primary"
									loading={isSubmitting}
									disabled={!config.saasUrl || !prompt.trim() || !file}
									onClick={() => void submit()}
								>
									{t("continue")}
								</Button>
								<p className="text-xs text-center text-muted-foreground">{t("privacy")}</p>
								{hasError && (
									<Alert variant="error">
										<AlertDescription>{t("error")}</AlertDescription>
									</Alert>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
		reader.onload = () => {
			if (typeof reader.result !== "string") return reject(new Error("FILE_READ_FAILED"));
			resolve(reader.result.split(",")[1] ?? "");
		};
		reader.readAsDataURL(file);
	});
}

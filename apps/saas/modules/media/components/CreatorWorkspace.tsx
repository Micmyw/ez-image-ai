"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { CurrentGeneration } from "./CurrentGeneration";
import { GenerationForm } from "./GenerationForm";
import { RecentJobQueue } from "./RecentJobQueue";

export function CreatorWorkspace({
	draftInput,
}: {
	draftInput?: { productKey: string | null; input: Record<string, unknown> } | null;
}) {
	const t = useTranslations("media.create");
	const searchParams = useSearchParams();
	const [jobId, setJobId] = useState<string | null>(searchParams.get("job"));
	const [formKey, setFormKey] = useState(0);
	return (
		<div>
			<header className="mb-6">
				<p className="font-medium text-xs tracking-[0.18em] text-primary uppercase">
					{t("eyebrow")}
				</p>
				<h1 className="mt-2 text-3xl font-medium md:text-4xl">{t("title")}</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground">
					{draftInput ? t("draftRestored") : t("subtitle")}
				</p>
			</header>
			<div className="gap-5 xl:grid-cols-[minmax(19rem,0.8fr)_minmax(0,1.35fr)] grid">
				<section className="p-5 md:p-6 rounded-2xl border bg-background">
					<GenerationForm key={formKey} initialDraft={draftInput} onCreated={setJobId} />
				</section>
				<CurrentGeneration jobId={jobId} onNew={() => setFormKey((value) => value + 1)} />
			</div>
			<RecentJobQueue selectedJobId={jobId} onSelect={setJobId} />
		</div>
	);
}

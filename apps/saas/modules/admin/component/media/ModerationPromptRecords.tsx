"use client";

import { useLocale, useTranslations } from "next-intl";

interface PromptRecord {
	id: string;
	prompt: string;
	productKey: string;
	source: "REFERENCE_DRAFT" | "GENERATION_JOB" | "BLOCKED_REQUEST";
	createdAt: Date;
	jobId: string | null;
}

export function ModerationPromptRecords({ records }: { records: PromptRecord[] }) {
	const t = useTranslations("admin.media.moderation.prompts");
	const locale = useLocale();
	return (
		<section className="space-y-3" data-clarity-mask="true">
			<h3 className="font-medium">{t("title")}</h3>
			<p className="text-sm text-muted-foreground">{t(records.length ? "note" : "missing")}</p>
			{records.map((record) => (
				<details key={record.id} className="p-3 rounded-lg border" open={records.length === 1}>
					<summary className="text-sm cursor-pointer">
						{t(record.source)} ·{" "}
						{new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(
							new Date(record.createdAt),
						)}
					</summary>
					<p className="mt-2 text-xs break-all text-muted-foreground">
						{record.productKey}
						{record.jobId ? ` · ${record.jobId}` : ""}
					</p>
					<pre className="mt-2 text-sm break-words whitespace-pre-wrap">{record.prompt}</pre>
				</details>
			))}
		</section>
	);
}

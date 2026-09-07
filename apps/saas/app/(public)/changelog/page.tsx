import { getLocale, getTranslations } from "next-intl/server";

import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { getPublicChangelogEntries } from "../../../modules/public-content/lib/content";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata() {
	const t = await getTranslations();
	return createPublicPageMetadata({
		path: "/changelog",
		title: t("changelog.title"),
		description: t("changelog.description"),
		index: false,
	});
}

export default async function ChangelogPage() {
	const locale = await getLocale();
	const t = await getTranslations();
	const entries = getPublicChangelogEntries();

	return (
		<PublicPageShell title={t("changelog.title")} description={t("changelog.description")}>
			<div className="max-w-3xl gap-5 mx-auto grid">
				{entries.map((entry) => (
					<article
						key={entry.date}
						className="border-white/10 bg-white/[0.045] p-6 rounded-3xl border"
					>
						<time dateTime={entry.date} className="text-xs font-semibold text-violet-300 uppercase">
							{new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
								new Date(`${entry.date}T00:00:00.000Z`),
							)}
						</time>
						<h2 className="mt-3 text-2xl font-semibold text-white">{entry.title}</h2>
						<ul className="mt-4 space-y-2 pl-5 text-slate-300 list-disc">
							{entry.changes.map((change) => (
								<li key={change}>{change}</li>
							))}
						</ul>
					</article>
				))}
			</div>
		</PublicPageShell>
	);
}

import { config } from "@config";
import { getTranslations } from "next-intl/server";

import { PublicPageShell } from "../../../modules/public-content/components/PublicPageShell";
import { createPublicPageMetadata } from "../../../modules/public-content/lib/metadata";

export async function generateMetadata() {
	const t = await getTranslations();
	return createPublicPageMetadata({
		path: "/contact",
		title: t("contact.title"),
		description: t("publicContent.contact.description", { appName: config.appName }),
		index: false,
	});
}

export default async function ContactPage() {
	const t = await getTranslations();
	const description = t("publicContent.contact.description", { appName: config.appName });

	return (
		<PublicPageShell title={t("contact.title")} description={description}>
			<div className="border-white/10 bg-white/[0.045] p-7 max-w-xl mx-auto rounded-3xl border text-center">
				{config.supportEmail ? (
					<>
						<p className="text-slate-300">{t("publicContent.contact.emailCta")}</p>
						<a
							href={`mailto:${config.supportEmail}`}
							className="mt-5 min-h-12 px-5 font-semibold text-white inline-flex items-center rounded-xl bg-[#6c4dff] hover:bg-[#7d63ff]"
						>
							{config.supportEmail}
						</a>
					</>
				) : (
					<p className="text-slate-300">{t("publicContent.contact.unavailable")}</p>
				)}
			</div>
		</PublicPageShell>
	);
}

import { config } from "@config";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

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
	const reportSubject = encodeURIComponent("Content report");

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
			<section
				id="report-content"
				aria-labelledby="report-content-title"
				className="border-white/10 bg-white/[0.045] mt-8 p-6 sm:p-8 max-w-3xl scroll-mt-28 mx-auto rounded-3xl border"
			>
				<h2 id="report-content-title" className="text-2xl font-semibold text-white">
					{t("publicContent.contact.reporting.title")}
				</h2>
				<p className="mt-3 text-slate-300 leading-7">
					{t("publicContent.contact.reporting.description")}
				</p>
				{config.supportEmail ? (
					<a
						href={`mailto:${config.supportEmail}?subject=${reportSubject}`}
						className="mt-5 min-h-12 px-5 py-3 font-semibold text-white focus-visible:outline-violet-300 inline-flex items-center justify-center rounded-xl bg-[#6c4dff] text-center hover:bg-[#7d63ff] focus-visible:outline-2 focus-visible:outline-offset-4"
					>
						{t("publicContent.contact.reporting.emailCta")}
					</a>
				) : (
					<p className="mt-5 text-slate-300">{t("publicContent.contact.unavailable")}</p>
				)}
				<h3 className="mt-7 font-semibold text-white">
					{t("publicContent.contact.reporting.detailsTitle")}
				</h3>
				<ul className="mt-3 space-y-2 pl-5 text-slate-300 leading-7 list-disc">
					{(["violation", "reference", "reply"] as const).map((key) => (
						<li key={key}>{t(`publicContent.contact.reporting.details.${key}`)}</li>
					))}
				</ul>
				<p className="mt-4 text-sm text-slate-400 leading-6">
					{t("publicContent.contact.reporting.safety")}
				</p>
				<div className="border-white/10 mt-6 pt-6 border-t">
					<h3 className="font-semibold text-white">
						{t("publicContent.contact.reporting.urgentTitle")}
					</h3>
					<p className="mt-2 text-slate-300 leading-7">
						{t("publicContent.contact.reporting.urgent")}
					</p>
					<p className="mt-3 text-slate-300 leading-7">
						{t("publicContent.contact.reporting.process")}
					</p>
					<p className="mt-3 text-slate-300 leading-7">
						{t("publicContent.contact.reporting.appeal")}
					</p>
					<Link
						href="/terms"
						className="mt-4 text-violet-200 rounded hover:text-white focus-visible:outline-violet-300 inline-block underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
					>
						{t("publicContent.contact.reporting.policyLink")}
					</Link>
				</div>
			</section>
		</PublicPageShell>
	);
}

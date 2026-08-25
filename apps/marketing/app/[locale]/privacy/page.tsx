import { getApprovedMarketingPageRobots } from "@i18n/config";
import { LegalContent } from "@legal/components/LegalContent";
import { getLegalPageByPath } from "@legal/lib/pages";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ locale: string }>;
}): Promise<Metadata> {
	const { locale } = await params;
	return {
		title: { absolute: "Privacy Policy | EzPic" },
		alternates: { canonical: new URL("/privacy", getBaseUrl()).href },
		robots: getApprovedMarketingPageRobots(locale, "/privacy"),
	};
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	setRequestLocale(locale);
	const page = await getLegalPageByPath("privacy-policy", { locale });
	if (!page) notFound();
	return (
		<div className="max-w-6xl py-16 container">
			<div className="mb-12 max-w-2xl mx-auto">
				<h1 className="font-bold text-4xl text-center">{page.title}</h1>
			</div>
			<LegalContent content={page.content} />
		</div>
	);
}

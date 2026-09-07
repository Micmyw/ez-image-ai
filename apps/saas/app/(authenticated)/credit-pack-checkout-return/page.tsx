import { getSession } from "@auth/lib/server";
import { CreditPackCheckoutReturnContent } from "@payments/components/CreditPackCheckoutReturnContent";
import { AuthWrapper } from "@shared/components/AuthWrapper";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("creditPackCheckoutReturn");

	return { title: t("title") };
}

export default async function CreditPackCheckoutReturnPage({
	searchParams,
}: {
	searchParams: Promise<{ intentId?: string; token?: string }>;
}) {
	const [session, t, params] = await Promise.all([
		getSession(),
		getTranslations("creditPackCheckoutReturn"),
		searchParams,
	]);

	if (!session) redirect("/login");

	const intentId = params.intentId?.trim();
	if (!intentId) redirect("/pricing");
	const providerOrderId = params.token?.trim() || undefined;

	return (
		<AuthWrapper>
			<div className="mb-4 text-center">
				<h1 className="font-bold text-2xl lg:text-3xl">{t("title")}</h1>
				<p className="text-sm lg:text-base text-muted-foreground">{t("description")}</p>
			</div>
			<CreditPackCheckoutReturnContent intentId={intentId} providerOrderId={providerOrderId} />
		</AuthWrapper>
	);
}

import { ImagePassCheckoutReturnContent } from "@payments/components/ImagePassCheckoutReturnContent";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function generateMetadata() {
	const t = await getTranslations("imagePass");
	return { title: t("returnTitle"), robots: { index: false, follow: false } };
}
export default async function ImagePassReturnPage({
	searchParams,
}: {
	searchParams: Promise<{ intentId?: string; token?: string }>;
}) {
	const params = await searchParams;
	const intentId = params.intentId?.trim();
	if (!intentId) redirect("/image-pass");
	return (
		<main className="px-4 py-16 min-h-screen">
			<ImagePassCheckoutReturnContent
				intentId={intentId}
				providerOrderId={params.token?.trim() || undefined}
			/>
		</main>
	);
}

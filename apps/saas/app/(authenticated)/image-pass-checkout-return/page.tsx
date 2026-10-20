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
	searchParams: Promise<{
		intentId?: string | string[];
		token?: string | string[];
		canceled?: string | string[];
		approved?: string | string[];
	}>;
}) {
	const params = await searchParams;
	const intentId = typeof params.intentId === "string" ? params.intentId.trim() : undefined;
	if (!intentId || intentId.length > 128) redirect("/image-pass");
	const canceled = params.canceled !== undefined;
	if (canceled) redirect(`/image-pass?canceled=1&intentId=${encodeURIComponent(intentId)}`);
	return (
		<main className="px-4 py-16 min-h-screen">
			<ImagePassCheckoutReturnContent
				intentId={intentId}
				providerOrderId={
					typeof params.token === "string" ? params.token.trim() || undefined : undefined
				}
				canceled={canceled}
				approved={params.approved === "1"}
			/>
		</main>
	);
}

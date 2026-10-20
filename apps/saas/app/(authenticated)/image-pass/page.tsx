import { ImagePassPurchase } from "@payments/components/ImagePassPurchase";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function generateMetadata() {
	const t = await getTranslations("imagePass");
	return { title: t("pageTitle"), robots: { index: false, follow: false } };
}
export default async function ImagePassPage({
	searchParams,
}: {
	searchParams: Promise<{ intentId?: string | string[]; canceled?: string | string[] }>;
}) {
	const params = await searchParams;
	const intentId = typeof params.intentId === "string" ? params.intentId.trim() : undefined;
	return (
		<main className="px-4 py-12 sm:py-20 min-h-screen bg-[#140e1d]">
			<ImagePassPurchase
				intentId={intentId && intentId.length <= 128 ? intentId : undefined}
				canceled={params.canceled !== undefined}
			/>
		</main>
	);
}

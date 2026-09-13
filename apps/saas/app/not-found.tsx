import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PublicPageShell } from "../modules/public-content/components/PublicPageShell";

export default async function NotFoundPage() {
	const t = await getTranslations("notFound");
	return (
		<PublicPageShell title={t("code")} description={t("title")}>
			<div className="text-center">
				<Link
					href="/"
					className="min-h-11 px-5 font-semibold text-white inline-flex items-center rounded-xl bg-[#6c4dff] hover:bg-[#7d63ff]"
				>
					{t("goToHome")}
				</Link>
			</div>
		</PublicPageShell>
	);
}

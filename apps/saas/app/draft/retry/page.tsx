import { buttonVariants } from "@repo/ui/components/button";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function DraftRetryPage() {
	const t = await getTranslations("media.draftRecovery");
	return (
		<main className="max-w-lg px-4 py-12 mx-auto flex min-h-[70vh] items-center">
			<section
				className="space-y-5 p-6 sm:p-8 w-full rounded-2xl border bg-card"
				aria-labelledby="draft-retry-title"
			>
				<h1 id="draft-retry-title" className="text-2xl font-semibold">
					{t("title")}
				</h1>
				<p className="text-muted-foreground">{t("description")}</p>
				<div className="gap-3 flex flex-wrap">
					{/* A full navigation sends the path-scoped HttpOnly cookie to the claim handler. */}
					<a href="/draft/continue" className={buttonVariants({ variant: "primary", size: "lg" })}>
						{t("retry")}
					</a>
					<a href="/" className={buttonVariants({ variant: "outline", size: "lg" })}>
						{t("back")}
					</a>
				</div>
			</section>
		</main>
	);
}

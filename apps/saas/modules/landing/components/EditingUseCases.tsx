import { getTranslations } from "next-intl/server";
import Link from "next/link";

const cases = [
	["background", "/blog/ai-image-editing-prompts#change-a-photo-background-with-a-prompt"],
	["portrait", "/blog/1980s-ai-photo"],
	["coloring", "/photo-to-coloring-page"],
] as const;

export async function EditingUseCases() {
	const t = await getTranslations("home.useCases");
	return (
		<section className="py-16 text-white container" aria-labelledby="editing-use-cases">
			<h2 id="editing-use-cases" className="text-3xl font-semibold">
				{t("title")}
			</h2>
			<div className="mt-6 gap-5 md:grid-cols-3 grid">
				{cases.map(([key, href]) => (
					<article key={key} className="border-white/10 bg-white/[0.04] p-6 rounded-2xl border">
						<h3 className="text-xl font-medium">
							<Link href={href} className="underline underline-offset-4">
								{t(`${key}.title`)}
							</Link>
						</h3>
						<p className="mt-3 text-sm leading-6 text-slate-300">{t(`${key}.description`)}</p>
					</article>
				))}
			</div>
		</section>
	);
}

import {
	VIDEO_TEMPLATE_LIBRARY,
	videoTemplateDescriptionKey,
	type PublicVideoTemplate,
} from "@repo/config/video-template-library";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { publicPagePath } from "../../public-content/lib/indexing";

/** Public explanatory copy only. Execution prompts and reference bindings remain server-owned. */
export async function TemplateGuide({ template }: { template: PublicVideoTemplate }) {
	const t = await getTranslations("videoTemplates");
	const locale = await getLocale();
	const key = videoTemplateDescriptionKey(template) as "original-rap";
	const name = t(`details.${key}.title`);
	const related = VIDEO_TEMPLATE_LIBRARY.filter(
		(item) => item.sample && videoTemplateDescriptionKey(item) !== key,
	)
		.sort(
			(a, b) => Number(b.category === template.category) - Number(a.category === template.category),
		)
		.slice(0, 3);
	return (
		<div className="vt-guide">
			<section className="vt-about" aria-labelledby="vt-about-title">
				<div>
					<span className="vt-eyebrow">{t(`categories.${template.category}`)}</span>
					<h2 id="vt-about-title">{t("guide.about", { name })}</h2>
				</div>
				<p>{t(`details.${key}.about`)}</p>
			</section>
			<section aria-labelledby="vt-how-title">
				<h2 id="vt-how-title">{t("guide.how")}</h2>
				<ol className="vt-guide-steps">
					<li>
						<span>1</span>
						<h3>{t("guide.photos")}</h3>
						<p>{t(`details.${key}.photoHint`)}</p>
					</li>
					<li>
						<span>2</span>
						<h3>{t("guide.settings")}</h3>
						<p>{t("guide.settingsText")}</p>
					</li>
					<li>
						<span>3</span>
						<h3>{t("guide.result")}</h3>
						<p>{t("guide.resultText")}</p>
					</li>
				</ol>
			</section>
			<section className="vt-faq" aria-labelledby="vt-faq-title">
				<h2 id="vt-faq-title">{t("guide.faq")}</h2>
				<div>
					<details open>
						<summary>{t(`details.${key}.faqQ`)}</summary>
						<p>{t(`details.${key}.faqA`)}</p>
					</details>
					<details>
						<summary>{t("guide.uploadQ")}</summary>
						<p>{t("guide.uploadA")}</p>
					</details>
					<details>
						<summary>{t("guide.costQ")}</summary>
						<p>{t("guide.costA")}</p>
					</details>
					<details>
						<summary>{t("guide.sampleQ")}</summary>
						<p>{t("guide.sampleA")}</p>
					</details>
				</div>
			</section>
			<section className="vt-related" aria-labelledby="vt-related-title">
				<h2 id="vt-related-title">{t("guide.related")}</h2>
				<div>
					{related.map((item) => (
						<Link key={item.key} href={publicPagePath(item.canonicalPath, locale)} prefetch={false}>
							<strong>
								{item.name}
								<span aria-hidden>↗</span>
							</strong>
							<span>{t(`descriptions.${videoTemplateDescriptionKey(item)}`)}</span>
						</Link>
					))}
				</div>
			</section>
			<div className="vt-bottom-cta">
				<h2>{t("guide.cta")}</h2>
				<a href="#template-creator" className="vt-primary">
					{t("guide.ctaLink")} <span aria-hidden>↑</span>
				</a>
			</div>
		</div>
	);
}

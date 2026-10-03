"use client";

import { ImagePrintButton } from "@media/components/ImagePrintButton";
import { useTranslations } from "next-intl";
import Image from "next/image";

export function ColoringExample() {
	const t = useTranslations("coloring");
	return (
		<aside className="coloring-example" aria-label={t("exampleTitle")}>
			<div className="coloring-example-heading">
				<h2>{t("exampleTitle")}</h2>
				<span>{t("demo")}</span>
			</div>
			<div className="coloring-comparison">
				<figure>
					<Image
						src="/images/coloring/dog-photo.webp"
						alt="AI-generated golden retriever wearing a teal bandana, sitting with a ball in a garden"
						width={800}
						height={1000}
						sizes="(max-width: 700px) 44vw, 260px"
						priority
					/>
					<figcaption>{t("before")}</figcaption>
				</figure>
				<figure>
					<Image
						src="/images/coloring/dog-coloring-page.webp"
						alt="Black contour drawing of the same dog and ball with open white areas for coloring"
						width={800}
						height={1000}
						sizes="(max-width: 700px) 44vw, 260px"
						priority
					/>
					<figcaption>{t("after")}</figcaption>
				</figure>
			</div>
			<p className="coloring-demo-note">{t("demoNotice")}</p>
			<div className="coloring-sample-actions">
				<span>{t("printSample")}</span>
				<ImagePrintButton imageUrl="/images/coloring/dog-coloring-page.webp" />
			</div>
			<p className="coloring-print-hint">{t("print.hint")}</p>
		</aside>
	);
}

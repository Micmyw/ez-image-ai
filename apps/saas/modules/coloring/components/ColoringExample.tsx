"use client";

import { ImagePrintButton } from "@media/components/ImagePrintButton";
import { useTranslations } from "next-intl";
import { getImageProps } from "next/image";

const samples = [
	{
		label: "before" as const,
		image: getImageProps({
			src: "/images/coloring/dog-photo.webp",
			alt: "AI-generated golden retriever wearing a teal bandana, sitting with a ball in a garden",
			width: 800,
			height: 1000,
			sizes: "(max-width: 700px) 44vw, 260px",
		}).props,
	},
	{
		label: "after" as const,
		image: getImageProps({
			src: "/images/coloring/dog-coloring-page.webp",
			alt: "Black contour drawing of the same dog and ball with open white areas for coloring",
			width: 800,
			height: 1000,
			sizes: "(max-width: 700px) 44vw, 260px",
		}).props,
	},
];

export function ColoringExample() {
	const t = useTranslations("coloring");
	return (
		<aside className="coloring-example" aria-label={t("exampleTitle")}>
			<div className="coloring-example-heading">
				<h2>{t("exampleTitle")}</h2>
				<span>{t("demo")}</span>
			</div>
			<div className="coloring-comparison">
				{samples.map(({ label, image }) => (
					<figure key={label}>
						{/* The comparison follows the editor below the 1000px layout breakpoint. */}
						<link
							rel="preload"
							as="image"
							media="(min-width: 1001px)"
							imageSrcSet={image.srcSet}
							imageSizes={image.sizes}
							fetchPriority="high"
						/>
						<img {...image} alt={image.alt} />
						<figcaption>{t(label)}</figcaption>
					</figure>
				))}
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

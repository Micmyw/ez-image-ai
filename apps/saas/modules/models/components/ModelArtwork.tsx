import { INSPIRATION, type InspirationKey } from "../lib/model-artwork";
import variants from "../lib/model-artwork-variants.json";

export function ModelArtwork({
	artwork,
	sizes,
	className,
	loading = "lazy",
}: {
	artwork: InspirationKey;
	sizes: string;
	className?: string;
	loading?: "eager" | "lazy";
}) {
	const image = variants[artwork];
	return (
		<img
			srcSet={image.variants.map(({ src, width }) => `${src} ${width}w`).join(", ")}
			sizes={loading === "lazy" ? `auto, ${sizes}` : sizes}
			src={image.variants.at(-1)!.src}
			alt={INSPIRATION[artwork].alt}
			width={image.width}
			height={image.height}
			className={className}
			loading={loading}
			decoding="async"
		/>
	);
}

import variants from "../lib/landing-artwork-variants.json";

export function LandingArtwork({
	src,
	alt,
	sizes,
	className,
	desktopPreload = false,
}: {
	src: string;
	alt: string;
	sizes: string;
	className?: string;
	desktopPreload?: boolean;
}) {
	const image = variants[src as keyof typeof variants];
	if (!image) throw new Error(`Missing landing artwork: ${src}`);
	const srcSet = image.variants.map(({ src, width }) => `${src} ${width}w`).join(", ");
	return (
		<>
			{desktopPreload && (
				<link
					rel="preload"
					as="image"
					media="(min-width: 768px)"
					imageSrcSet={srcSet}
					imageSizes={sizes}
					fetchPriority="high"
				/>
			)}
			<img
				src={image.variants.at(-1)!.src}
				srcSet={srcSet}
				sizes={`auto, ${sizes}`}
				alt={alt}
				width={image.width}
				height={image.height}
				className={className}
				loading="lazy"
				decoding="async"
			/>
		</>
	);
}

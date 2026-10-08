import Image from "next/image";

/** Brand marks retain their original colors across every model entry point. */
export function ImageModelIcon({
	productKey,
	size = 20,
}: {
	productKey?: string | null;
	size?: number;
}) {
	const family = productKey?.startsWith("image-nano-banana")
		? "nano-banana"
		: productKey?.startsWith("image-seedream")
			? "seedream"
			: productKey?.startsWith("image-gpt-image")
				? "openai"
				: null;
	if (!family) return null;
	return <ModelBrandIcon brand={family} size={size} />;
}

/** Shared original-color renderer; source provenance lives beside the SVG assets. */
export function ModelBrandIcon({
	brand,
	size = 20,
}: {
	brand:
		| "nano-banana"
		| "seedream"
		| "openai"
		| "minimax"
		| "bytedance"
		| "gemini"
		| "kling"
		| "google";
	size?: number;
}) {
	return (
		<span
			aria-hidden="true"
			data-model-icon={brand}
			className="inline-flex shrink-0 items-center justify-center leading-none"
			style={{ width: size, height: size }}
		>
			{brand === "nano-banana" ? (
				<span style={{ fontSize: size, lineHeight: 1 }}>🍌</span>
			) : (
				<Image
					src={`/images/model-logos/${brand}.svg`}
					alt=""
					width={size}
					height={size}
					unoptimized
					className="block object-contain"
				/>
			)}
		</span>
	);
}

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
	return (
		<span
			aria-hidden="true"
			data-model-icon={family}
			className="inline-flex shrink-0 items-center justify-center leading-none"
			style={{ width: size, height: size }}
		>
			{family === "nano-banana" ? (
				<span style={{ fontSize: size, lineHeight: 1 }}>🍌</span>
			) : (
				<Image
					src={`/images/model-logos/${family}.svg`}
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

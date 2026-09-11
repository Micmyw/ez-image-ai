import { ImageProcessingError } from "./types";

export function assertGuestImageDimensions(width: number, height: number): void {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 64 ||
		height < 64 ||
		width > 16_384 ||
		height > 16_384
	) {
		throw new ImageProcessingError("GUEST_WATERMARK_DIMENSIONS_INVALID");
	}
}

export function guestWatermarkGeometry(width: number, height: number) {
	assertGuestImageDimensions(width, height);
	const shortest = Math.min(width, height);
	const padding = Math.max(4, Math.round(shortest * 0.025));
	const maximumPlateWidth = Math.max(1, width - padding * 2);
	const plateWidth = Math.min(maximumPlateWidth, Math.max(72, Math.round(width * 0.24)));
	const plateHeight = Math.min(
		Math.max(1, height - padding * 2),
		Math.max(26, Math.round(plateWidth * 0.3)),
	);
	return {
		plateWidth,
		plateHeight,
		fontSize: Math.max(12, Math.round(plateHeight * 0.48)),
		radius: Math.max(4, Math.round(plateHeight * 0.18)),
		left: width - padding - plateWidth,
		top: height - padding - plateHeight,
	};
}

export function guestWatermarkSvg(geometry: ReturnType<typeof guestWatermarkGeometry>): string {
	return `<svg width="${geometry.plateWidth}" height="${geometry.plateHeight}" xmlns="http://www.w3.org/2000/svg">
				<rect width="${geometry.plateWidth}" height="${geometry.plateHeight}" rx="${geometry.radius}" fill="#111827" fill-opacity="0.72"/>
				<text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="${geometry.fontSize}" font-weight="700" letter-spacing="0.5">EzPic</text>
			</svg>`;
}

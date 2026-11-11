import {
	IMAGE_ASPECT_RATIOS,
	IMAGE_BACKGROUNDS,
	IMAGE_OUTPUT_FORMATS,
	IMAGE_SKU_KEYS,
	imageGifFrameCountSchema,
	imageGifFrameDurationMsSchema,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "@repo/config/client";

export type ImageSpecDimensionKey = "resolution" | "quality";
export type ImageSpecControlKey = "outputFormat" | "background";
export type ImageSpecControlChangeKey = ImageSpecControlKey | "frameCount" | "frameDurationMs";

export interface PublicImageSpecControl {
	key: ImageSpecControlKey;
	label: string;
	defaultValue: string;
	options: ReadonlyArray<{ key: string; label: string }>;
}

export interface ImageSpecControlValues {
	outputFormat?: ImageOutputFormat;
	background?: ImageBackground;
	frameCount?: number;
	frameDurationMs?: number;
}

export interface PublicImageSpecCell {
	skuKey: string;
	label: string;
	parameterValues: Partial<Record<ImageSpecDimensionKey, string>>;
	credits: number;
	aspectRatios: readonly string[];
	controls: readonly PublicImageSpecControl[];
}

export interface PublicImageSpecMatrix {
	defaultSkuKey: string;
	dimensions: ReadonlyArray<{
		key: ImageSpecDimensionKey;
		label: string;
		options: ReadonlyArray<{ key: string; label: string }>;
	}>;
	cells: readonly PublicImageSpecCell[];
}

export function constrainImageSpecMatrixToOutputFormat<T extends PublicImageSpecMatrix>(
	matrix: T,
	outputFormat: ImageOutputFormat,
): T {
	const cells = matrix.cells
		.filter((cell) =>
			cell.controls.some(
				(control) =>
					control.key === "outputFormat" &&
					control.options.some((option) => option.key === outputFormat),
			),
		)
		.map((cell) => ({
			...cell,
			controls: cell.controls.map((control) =>
				control.key === "outputFormat"
					? {
							...control,
							defaultValue: outputFormat,
							options: control.options.filter((option) => option.key === outputFormat),
						}
					: control,
			),
		}));
	return {
		...matrix,
		defaultSkuKey: cells.some((cell) => cell.skuKey === matrix.defaultSkuKey)
			? matrix.defaultSkuKey
			: (cells[0]?.skuKey ?? matrix.defaultSkuKey),
		cells,
		dimensions: matrix.dimensions.map((dimension) => ({
			...dimension,
			options: dimension.options.filter((option) =>
				cells.some((cell) => cell.parameterValues[dimension.key] === option.key),
			),
		})),
	};
}

export function getImageSpecCell(
	matrix: PublicImageSpecMatrix | undefined,
	skuKey: string | undefined,
): PublicImageSpecCell | null {
	if (!matrix) return null;
	return matrix.cells.find((cell) => cell.skuKey === skuKey) ?? null;
}

export function getDefaultImageSpecCell(
	matrix: PublicImageSpecMatrix | undefined,
): PublicImageSpecCell | null {
	return getImageSpecCell(matrix, matrix?.defaultSkuKey);
}

export function selectImageSkuForDimension(
	matrix: PublicImageSpecMatrix,
	currentSkuKey: string,
	dimensionKey: ImageSpecDimensionKey,
	optionKey: string,
): PublicImageSpecCell | null {
	const dimension = matrix.dimensions.find((candidate) => candidate.key === dimensionKey);
	if (!dimension?.options.some((option) => option.key === optionKey)) return null;
	const current = getImageSpecCell(matrix, currentSkuKey);
	const exact = matrix.cells.find(
		(cell) =>
			cell.parameterValues[dimensionKey] === optionKey &&
			matrix.dimensions.every(
				(other) =>
					other.key === dimensionKey ||
					cell.parameterValues[other.key] === current?.parameterValues[other.key],
			),
	);
	return (
		exact ?? matrix.cells.find((cell) => cell.parameterValues[dimensionKey] === optionKey) ?? null
	);
}

export function isPublicImageSkuKey(value: string): value is ImageSkuKey {
	return IMAGE_SKU_KEYS.includes(value as ImageSkuKey);
}

export function publicImageAspectRatios(cell: PublicImageSpecCell | null): ImageAspectRatio[] {
	return (cell?.aspectRatios ?? []).filter((value): value is ImageAspectRatio =>
		IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio),
	);
}

export function resolveImageSpecControlValues(
	cell: PublicImageSpecCell | null,
	current: Partial<Record<ImageSpecControlChangeKey, string | number | undefined>>,
): ImageSpecControlValues {
	const next: ImageSpecControlValues = {};
	for (const control of cell?.controls ?? []) {
		const currentValue = current[control.key];
		const defaultValue = control.options.some((option) => option.key === control.defaultValue)
			? control.defaultValue
			: undefined;
		const value =
			currentValue && control.options.some((option) => option.key === currentValue)
				? currentValue
				: defaultValue;
		if (!value) continue;
		if (
			control.key === "outputFormat" &&
			IMAGE_OUTPUT_FORMATS.includes(value as ImageOutputFormat)
		) {
			next.outputFormat = value as ImageOutputFormat;
		}
		if (control.key === "background" && IMAGE_BACKGROUNDS.includes(value as ImageBackground)) {
			next.background = value as ImageBackground;
		}
	}
	if (next.outputFormat === "gif") {
		const frameCount = imageGifFrameCountSchema.safeParse(Number(current.frameCount ?? 9));
		const frameDuration = imageGifFrameDurationMsSchema.safeParse(
			Number(current.frameDurationMs ?? 200),
		);
		next.frameCount = frameCount.success ? frameCount.data : 9;
		next.frameDurationMs = frameDuration.success ? frameDuration.data : 200;
	}
	if (
		cell?.skuKey.startsWith("gpt-image-2-6-") &&
		next.background === "transparent" &&
		next.outputFormat !== "png"
	)
		next.background = "opaque";
	return next;
}

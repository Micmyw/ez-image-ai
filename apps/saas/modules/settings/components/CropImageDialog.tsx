"use client";

import { Button } from "@repo/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { useCallback, useEffect, useMemo, useRef } from "react";

const CROPPER_TEMPLATE =
	'<cropper-canvas background scale-step="0">' +
	'<div class="cropper-image-clip">' +
	'<cropper-image initial-center-size="cover" rotatable scalable skewable translatable></cropper-image>' +
	"</div>" +
	'<div class="cropper-shade-clip">' +
	"<cropper-shade hidden></cropper-shade>" +
	"</div>" +
	'<cropper-handle action="select" plain></cropper-handle>' +
	'<cropper-selection aspect-ratio="1" initial-coverage="0.95" movable resizable outlined>' +
	'<cropper-grid role="grid" bordered covered></cropper-grid>' +
	"<cropper-crosshair centered></cropper-crosshair>" +
	'<cropper-handle action="move" theme-color="rgba(255, 255, 255, 0.35)"></cropper-handle>' +
	'<cropper-handle action="n-resize"></cropper-handle>' +
	'<cropper-handle action="e-resize"></cropper-handle>' +
	'<cropper-handle action="s-resize"></cropper-handle>' +
	'<cropper-handle action="w-resize"></cropper-handle>' +
	'<cropper-handle action="ne-resize"></cropper-handle>' +
	'<cropper-handle action="nw-resize"></cropper-handle>' +
	'<cropper-handle action="se-resize"></cropper-handle>' +
	'<cropper-handle action="sw-resize"></cropper-handle>' +
	"</cropper-selection>" +
	"</cropper-canvas>";

type CropperInstance = InstanceType<Awaited<typeof import("cropperjs")>["default"]>;

const getAvailableSelectionBounds = (
	canvas: HTMLElement,
	cropperImage = canvas.querySelector("cropper-image"),
) => {
	const canvasRect = canvas.getBoundingClientRect();

	if (!cropperImage) {
		return {
			x: 0,
			y: 0,
			width: canvas.offsetWidth,
			height: canvas.offsetHeight,
		};
	}

	const imageRect = cropperImage.getBoundingClientRect();
	const x = Math.max(0, Math.ceil(imageRect.left - canvasRect.left));
	const y = Math.max(0, Math.ceil(imageRect.top - canvasRect.top));
	const right = Math.min(canvas.offsetWidth, Math.floor(imageRect.right - canvasRect.left));
	const bottom = Math.min(canvas.offsetHeight, Math.floor(imageRect.bottom - canvasRect.top));

	if (right <= x || bottom <= y) {
		return {
			x: 0,
			y: 0,
			width: canvas.offsetWidth,
			height: canvas.offsetHeight,
		};
	}

	return {
		x,
		y,
		width: right - x,
		height: bottom - y,
	};
};

export function CropImageDialog({
	image,
	open,
	onOpenChange,
	onCrop,
}: {
	image: File | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCrop: (croppedImage: Blob | null) => void;
}) {
	const imageRef = useRef<HTMLImageElement>(null);
	const cropperContainerRef = useRef<HTMLDivElement>(null);
	const cropperRef = useRef<CropperInstance | null>(null);
	const cropperInitIdRef = useRef(0);
	const recenterTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const imageSrc = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);

	useEffect(() => {
		return () => {
			if (imageSrc) {
				URL.revokeObjectURL(imageSrc);
			}
		};
	}, [imageSrc]);

	const constrainSelection = useCallback((e: Event) => {
		const detail = (e as CustomEvent).detail;
		const { x, y, width, height } = detail;
		const canvas = (e.target as Element).closest("cropper-canvas");
		if (!canvas) return;

		const bounds = getAvailableSelectionBounds(canvas as HTMLElement);

		if (
			x < bounds.x ||
			y < bounds.y ||
			x + width > bounds.x + bounds.width ||
			y + height > bounds.y + bounds.height
		) {
			e.preventDefault();
		}
	}, []);

	const syncCropperLayout = useCallback(async (currentInitId: number) => {
		const currentCropper = cropperRef.current;
		if (!currentCropper || currentInitId !== cropperInitIdRef.current) return;

		const cropperImage = currentCropper.getCropperImage();
		await cropperImage?.$ready();

		if (!cropperRef.current || currentInitId !== cropperInitIdRef.current) return;

		cropperImage?.$resetTransform();
		cropperImage?.$center("cover");

		const canvas = currentCropper.getCropperCanvas();
		const selection = currentCropper.getCropperSelection();
		if (canvas && selection) {
			const bounds = getAvailableSelectionBounds(canvas, cropperImage);
			const selectionSize = Math.min(bounds.width, bounds.height) * 0.95;
			selection.$change(
				bounds.x + (bounds.width - selectionSize) / 2,
				bounds.y + (bounds.height - selectionSize) / 2,
				selectionSize,
				selectionSize,
				1,
				true,
			);
		}
	}, []);

	const initCropper = useCallback(async () => {
		const currentInitId = ++cropperInitIdRef.current;

		if (recenterTimeoutRef.current) {
			clearTimeout(recenterTimeoutRef.current);
		}

		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		if (!imageRef.current?.src || !cropperContainerRef.current || !open) return;

		cropperRef.current?.destroy();
		const { default: Cropper } = await import("cropperjs");

		if (currentInitId !== cropperInitIdRef.current) return;

		cropperRef.current = new Cropper(imageRef.current, {
			container: cropperContainerRef.current,
			template: CROPPER_TEMPLATE,
		});

		await syncCropperLayout(currentInitId);

		const selection = cropperRef.current.getCropperSelection();
		selection?.addEventListener("change", constrainSelection);

		recenterTimeoutRef.current = setTimeout(() => {
			void syncCropperLayout(currentInitId);
		}, 150);
	}, [constrainSelection, open, syncCropperLayout]);

	useEffect(() => {
		if (!open) {
			cropperInitIdRef.current++;
			if (recenterTimeoutRef.current) {
				clearTimeout(recenterTimeoutRef.current);
			}
			cropperRef.current?.destroy();
			cropperRef.current = null;
			return;
		}

		if (imageSrc && imageRef.current?.complete) {
			void initCropper();
		}
	}, [imageSrc, initCropper, open]);

	useEffect(() => {
		return () => {
			if (recenterTimeoutRef.current) {
				clearTimeout(recenterTimeoutRef.current);
			}
			cropperRef.current?.destroy();
		};
	}, []);

	const getCroppedImage = async () => {
		const selection = cropperRef.current?.getCropperSelection();
		if (!selection) {
			return null;
		}

		const canvas = await selection.$toCanvas({
			width: 256,
			height: 256,
		});

		if (!canvas) {
			return null;
		}

		return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="overflow-hidden">
				<DialogHeader>
					<DialogTitle />
				</DialogHeader>
				<div
					ref={cropperContainerRef}
					className="min-w-0 p-2 [&_.cropper-image-clip]:inset-0 [&_.cropper-shade-clip]:inset-0 [&_cropper-canvas]:min-w-0 relative aspect-square w-full overflow-hidden [&_.cropper-image-clip]:pointer-events-none [&_.cropper-image-clip]:absolute [&_.cropper-image-clip]:overflow-hidden [&_.cropper-shade-clip]:pointer-events-none [&_.cropper-shade-clip]:absolute [&_.cropper-shade-clip]:overflow-hidden [&_.cropper-shade-clip]:[clip-path:inset(0)] [&_cropper-canvas]:relative [&_cropper-canvas]:block [&_cropper-canvas]:aspect-square [&_cropper-canvas]:h-full [&_cropper-canvas]:max-h-full [&_cropper-canvas]:w-full [&_cropper-canvas]:max-w-full [&_cropper-canvas]:overflow-hidden"
				>
					{imageSrc && (
						<img
							ref={imageRef}
							src={imageSrc}
							alt=""
							className="block size-full object-contain"
							onLoad={() => {
								if (open) {
									void initCropper();
								}
							}}
						/>
					)}
				</div>
				<DialogFooter>
					<Button
						onClick={async () => {
							onCrop(await getCroppedImage());
							onOpenChange(false);
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

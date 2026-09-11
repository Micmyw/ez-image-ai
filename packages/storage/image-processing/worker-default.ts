import { ImageProcessingError, type ImageProcessor } from "./types";

export function getDefaultImageProcessor(): ImageProcessor {
	throw new ImageProcessingError("IMAGE_PROCESSOR_BINDING_REQUIRED");
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const dropzoneState = vi.hoisted(() => ({
	accept: undefined as Record<string, string[]> | undefined,
	maxSize: undefined as number | undefined,
}));

vi.mock("react-dropzone", () => ({
	useDropzone: (options: { accept?: Record<string, string[]>; maxSize?: number }) => {
		dropzoneState.accept = options.accept;
		dropzoneState.maxSize = options.maxSize;
		return {
			getInputProps: () => ({}),
			getRootProps: () => ({}),
			isDragActive: false,
		};
	},
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, number>) =>
		({
			active: "Drop images here",
			idle: "Drag images here, paste, or choose files",
			label: "Upload images",
			limit: `Images up to ${values?.megabytes} MB.`,
		})[key] ?? key,
}));
vi.mock("../hooks/use-media-upload", () => ({
	useMediaUpload: () => ({
		addFiles: vi.fn(),
		items: [],
		pause: vi.fn(),
		remove: vi.fn(),
		resume: vi.fn(),
		retry: vi.fn(),
	}),
}));

import { filterEzPicImageFiles, MediaUploader } from "./MediaUploader";

describe("EzPic media uploader", () => {
	it("accepts and describes source images only", () => {
		const markup = renderToStaticMarkup(<MediaUploader onChange={() => undefined} />);

		expect(Object.keys(dropzoneState.accept ?? {})).toEqual([
			"image/jpeg",
			"image/png",
			"image/webp",
		]);
		expect(markup).toMatch(/upload images/i);
		expect(markup).not.toMatch(/video/i);
	});

	it("filters pasted and dropped files to supported images within 20 MB", () => {
		const allowed = { name: "source.webp", size: 20 * 1024 * 1024, type: "image/webp" } as File;
		const tooLarge = {
			name: "large.png",
			size: 20 * 1024 * 1024 + 1,
			type: "image/png",
		} as File;
		const video = { name: "clip.mp4", size: 1024, type: "video/mp4" } as File;

		expect(filterEzPicImageFiles([allowed, tooLarge, video])).toEqual([allowed]);
	});

	it("uses the current plan's smaller image limit for selection and guidance", () => {
		const limit = 10 * 1024 * 1024;
		const allowed = { name: "source.webp", size: limit, type: "image/webp" } as File;
		const tooLarge = { name: "large.webp", size: limit + 1, type: "image/webp" } as File;

		const markup = renderToStaticMarkup(
			<MediaUploader onChange={() => undefined} maximumImageBytes={limit} />,
		);

		expect(dropzoneState.maxSize).toBe(limit);
		expect(markup).toContain("Images up to 10 MB.");
		expect(filterEzPicImageFiles([allowed, tooLarge], limit)).toEqual([allowed]);
	});
});

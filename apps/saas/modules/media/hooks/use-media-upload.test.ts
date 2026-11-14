import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	cursor: 0,
	refs: [] as Array<{ current: unknown }>,
	states: [] as unknown[],
	refCursor: 0,
	useState<T>(initial: T) {
		const index = this.cursor++;
		if (!(index in this.states)) this.states[index] = initial;
		return [
			this.states[index] as T,
			(value: T | ((previous: T) => T)) => {
				this.states[index] =
					typeof value === "function"
						? (value as (previous: T) => T)(this.states[index] as T)
						: value;
			},
		] as const;
	},
	useRef<T>(initial: T) {
		const index = this.refCursor++;
		this.refs[index] ??= { current: initial };
		return this.refs[index] as { current: T };
	},
}));
const mocks = vi.hoisted(() => ({
	prepareImageUpload: vi.fn(),
	uploadTemporaryReferenceFile: vi.fn(),
}));
vi.mock("react", () => ({
	useState: runtime.useState.bind(runtime),
	useRef: runtime.useRef.bind(runtime),
	useCallback: <T>(callback: T) => callback,
	useEffect: () => undefined,
}));
vi.mock("../lib/prepare-image-upload", () => ({ prepareImageUpload: mocks.prepareImageUpload }));
vi.mock("../lib/temporary-reference-upload", () => ({
	uploadTemporaryReferenceFile: mocks.uploadTemporaryReferenceFile,
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: { media: {} } }));

import { getFileFingerprint } from "../lib/upload-state";
import { useMediaUpload } from "./use-media-upload";

function render() {
	runtime.cursor = 0;
	runtime.refCursor = 0;
	return useMediaUpload(undefined, true);
}
const receipt = { assetId: "asset", token: "receipt", expiresAt: "2035-01-01T00:00:00.000Z" };
let createObjectUrl: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	runtime.states = [];
	runtime.refs = [];
	vi.clearAllMocks();
	createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:normalized");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
	vi.stubGlobal("localStorage", { getItem: () => null, removeItem: vi.fn() });
	mocks.uploadTemporaryReferenceFile.mockResolvedValue(receipt);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("normalized image upload entry", () => {
	it("previews exactly the prepared upload File and never previews the undecoded source", async () => {
		const source = new File(["HEIC bytes"], "photo.heic", { type: "image/heic" });
		const prepared = new File(["normalized PNG"], "photo.png", { type: "image/png" });
		let finish!: (file: File) => void;
		mocks.prepareImageUpload.mockReturnValue(
			new Promise<File>((resolve) => {
				finish = resolve;
			}),
		);
		render().addFiles([source]);
		expect(createObjectUrl).not.toHaveBeenCalled();
		expect(mocks.uploadTemporaryReferenceFile).not.toHaveBeenCalled();
		finish(prepared);
		await vi.waitFor(() => expect(render().items[0]?.status).toBe("uploaded"));
		expect(createObjectUrl).toHaveBeenCalledWith(prepared);
		expect(mocks.uploadTemporaryReferenceFile).toHaveBeenCalledWith(
			prepared,
			expect.any(AbortSignal),
		);
		expect(render().items[0]).toMatchObject({
			file: source,
			preparedFile: prepared,
			previewUrl: "blob:normalized",
		});
	});
	it("does not create a preview or upload after removing a file during normalization", async () => {
		const source = new File(["HEIC bytes"], "photo.heic", { type: "image/heic" });
		let finish!: (file: File) => void;
		mocks.prepareImageUpload.mockReturnValue(
			new Promise<File>((resolve) => {
				finish = resolve;
			}),
		);
		render().addFiles([source]);
		await render().remove(getFileFingerprint(source));
		finish(new File(["normalized PNG"], "photo.png", { type: "image/png" }));
		await Promise.resolve();
		await Promise.resolve();
		expect(render().items).toEqual([]);
		expect(createObjectUrl).not.toHaveBeenCalled();
		expect(mocks.uploadTemporaryReferenceFile).not.toHaveBeenCalled();
	});
	it("keeps preview and prepared bytes stable for an explicit retry", async () => {
		const source = new File(["EXIF bytes"], "photo.jpg", { type: "image/jpeg" });
		const prepared = new File(["normalized JPEG"], "photo.jpg", { type: "image/jpeg" });
		mocks.prepareImageUpload.mockResolvedValue(prepared);
		mocks.uploadTemporaryReferenceFile.mockRejectedValueOnce(new Error("UPLOAD_FAILED"));
		render().addFiles([source]);
		await vi.waitFor(() => expect(render().items[0]?.status).toBe("error"));
		render().retry(getFileFingerprint(source));
		await vi.waitFor(() => expect(render().items[0]?.status).toBe("uploaded"));
		expect(createObjectUrl).toHaveBeenCalledOnce();
		expect(mocks.uploadTemporaryReferenceFile.mock.calls.map(([file]) => file)).toEqual([
			prepared,
			prepared,
		]);
	});
});

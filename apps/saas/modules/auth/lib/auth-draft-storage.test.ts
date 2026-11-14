import { File } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
	AUTH_DRAFT_MAX_ENTRIES,
	AUTH_DRAFT_MAX_FILE_BYTES,
	AUTH_DRAFT_POINTER_KEY,
	AUTH_DRAFT_TTL_MS,
	authDraftsToRetain,
	createAuthDraftStorage,
	safeAuthDraftReturnPath,
	type AuthDraftInput,
	type StoredAuthDraft,
} from "./auth-draft-storage";

const id = "10000000-0000-4000-8000-000000000001";
const now = 1_800_000_000_000;
const input: AuthDraftInput = {
	file: new File([new Uint8Array([1, 2, 3, 255])], "original.png", {
		type: "image/png",
		lastModified: 42,
	}) as globalThis.File,
	values: {
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		prompt: "Keep this exact prompt",
		sourceAssetId: "",
		aspectRatio: "16:9",
		outputFormat: "png",
	},
	returnPath: "/create?model=image-nano-banana-2-lite",
	originPath: "/",
};
function fixture() {
	const records = new Map<string, StoredAuthDraft>();
	const pointer = new Map<string, string>();
	let time = now;
	let counter = 0;
	const repository = {
		put: vi.fn(async (record: StoredAuthDraft, savedAt: number) => {
			const retained = authDraftsToRetain([...records.values()], record, savedAt);
			records.clear();
			for (const retainedRecord of retained) records.set(retainedRecord.id, retainedRecord);
			records.set(record.id, record);
		}),
		get: vi.fn(async (key: string) => records.get(key)),
		bindOwner: vi.fn(async (key: string, ownerId: string) => {
			const record = records.get(key);
			if (!record || (record.boundOwnerId && record.boundOwnerId !== ownerId)) return false;
			records.set(key, { ...record, boundOwnerId: ownerId });
			return true;
		}),
		deleteOwner: vi.fn(async (ownerId: string) => {
			for (const [key, record] of records)
				if (record.sourceOwnerId === ownerId || record.boundOwnerId === ownerId)
					records.delete(key);
		}),
	};
	const dependencies = {
		repository,
		pointerStorage: {
			getItem: (key: string) => pointer.get(key) ?? null,
			setItem: (key: string, value: string) => pointer.set(key, value),
			removeItem: (key: string) => pointer.delete(key),
		},
		now: () => time,
		createId: () => `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
	};
	return {
		records,
		pointer,
		repository,
		store: createAuthDraftStorage(dependencies),
		newTab: () => createAuthDraftStorage({ ...dependencies, pointerStorage: null }),
		advance: (ms: number) => {
			time += ms;
		},
	};
}

describe("local authentication draft capsules", () => {
	it("preserves original bytes and all public parameters while session storage holds only a pointer", async () => {
		const f = fixture();
		const saved = await f.store.save(input);
		expect(saved).toEqual({ id, returnPath: `${input.returnPath}&authDraft=${id}` });
		expect([...f.pointer]).toEqual([[AUTH_DRAFT_POINTER_KEY, id]]);
		const restored = await f.store.read({ returnPath: "/" });
		expect(restored?.values).toEqual(input.values);
		expect(restored?.file?.name).toBe("original.png");
		expect(restored?.file?.lastModified).toBe(42);
		expect(new Uint8Array(await restored!.file!.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3, 255]),
		);
		expect(await f.store.read({ returnPath: "/models/seedream-5-5" })).toBeNull();
	});
	it("reads after cancelled OAuth and in a same-browser magic-link tab without consuming the capsule", async () => {
		const f = fixture();
		await f.store.save(input);
		expect(await f.store.read({ id, returnPath: "/" })).not.toBeNull();
		expect(await f.store.read({ id, returnPath: "/" })).not.toBeNull();
		expect(
			await f.newTab().restore({ id, ownerId: "registered", returnPath: input.returnPath }),
		).toMatchObject({ file: input.file, values: input.values });
		expect(f.records.size).toBe(1);
	});
	it("deduplicates repeated and concurrent save clicks for the same File and exact settings", async () => {
		const f = fixture();
		const [a, b] = await Promise.all([f.store.save(input), f.store.save({ ...input })]);
		expect(a).toEqual(b);
		expect(f.repository.put).toHaveBeenCalledOnce();
		await f.store.save({ ...input, values: { ...input.values, prompt: "A changed prompt" } });
		expect(f.repository.put).toHaveBeenCalledTimes(2);
	});
	it("never restores another owner's server receipt, asset ID or parent job", async () => {
		const f = fixture();
		const reference = {
			assetId: "20000000-0000-4000-8000-000000000002",
			token: "private-receipt",
			expiresAt: new Date(now + 60_000).toISOString(),
		};
		await f.store.save({
			...input,
			sourceOwnerId: "owner-a",
			temporaryReference: reference,
			values: { ...input.values, sourceAssetId: reference.assetId },
			parentJobId: "parent-a",
		});
		expect(await f.store.read({ id, ownerId: "owner-a" })).toMatchObject({
			temporaryReference: reference,
			parentJobId: "parent-a",
		});
		const other = await f.store.read({ id, ownerId: "owner-b" });
		expect(other).toBeNull();
		expect(await f.store.restore({ id, ownerId: "owner-a" })).not.toBeNull();
		expect(await f.store.restore({ id, ownerId: "owner-b" })).toBeNull();
		expect(await f.store.read({ id })).toBeNull();
		await f.store.clearOwner("owner-a");
		expect(f.records.size).toBe(0);
		expect(f.pointer.size).toBe(0);
	});
	it("retains an expired temporary reference's local file without presenting expired authorization", async () => {
		const f = fixture();
		const reference = {
			assetId: "20000000-0000-4000-8000-000000000002",
			token: "expired",
			expiresAt: new Date(now - 1).toISOString(),
		};
		await f.store.save({
			...input,
			sourceOwnerId: "owner-a",
			temporaryReference: reference,
			values: { ...input.values, sourceAssetId: reference.assetId },
		});
		const saved = await f.store.restore({ id, ownerId: "owner-a" });
		expect(saved?.file).toBe(input.file);
		expect(saved?.values.sourceAssetId).toBe("");
		expect(saved).not.toHaveProperty("temporaryReference");
	});
	it("expires after one hour, bounds disk entries and rejects oversized originals before writing", async () => {
		const f = fixture();
		await f.store.save(input);
		f.advance(AUTH_DRAFT_TTL_MS + 1);
		expect(await f.store.read({ id })).toBeNull();
		for (let index = 0; index < 5; index++) {
			f.advance(1);
			await f.store.save({ ...input, values: { ...input.values, prompt: String(index) } });
		}
		expect(f.records.size).toBe(AUTH_DRAFT_MAX_ENTRIES);
		const oversized = new File([new Uint8Array(AUTH_DRAFT_MAX_FILE_BYTES + 1)], "large.png", {
			type: "image/png",
		});
		expect(await f.store.save({ ...input, file: oversized as globalThis.File })).toBeNull();
		expect(f.records.size).toBe(AUTH_DRAFT_MAX_ENTRIES);
	});
	it("saves an image before any prompt is entered and retries after browser storage fails", async () => {
		const f = fixture();
		f.repository.put.mockRejectedValueOnce(new Error("quota"));
		expect(await f.store.save(input)).toBeNull();
		expect(
			await f.store.save({ ...input, values: { ...input.values, prompt: "" } }),
		).not.toBeNull();
	});
	it("retains safe model/preset destinations and removes arbitrary private URL state", () => {
		expect(
			safeAuthDraftReturnPath(
				"/blog/sheru-bhai-ai-photo?preset=hero&resume=text&token=secret&authDraft=123",
			),
		).toBe("/blog/sheru-bhai-ai-photo?preset=hero");
		for (const path of [
			"//attacker.test/path",
			"/\\attacker.test/path",
			"https://attacker.test",
			"/api/media/assets",
			"/login",
		])
			expect(safeAuthDraftReturnPath(path)).toBeNull();
	});
});

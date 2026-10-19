import { describe, expect, it } from "vitest";

import type {
	AccountInputCopyClaim,
	AccountInputCopyDependencies,
	AccountInputCopyOrphanDependencies,
} from "../contracts";
import {
	cleanupAccountInputCopyOrphan,
	copyAccountInput,
	recoverAccountInputCopyTasks,
} from "./account-input-copy";

const claim: AccountInputCopyClaim = {
	promotionId: "promotion",
	leaseToken: "lease-1",
	source: {
		assetId: "guest-input",
		objectKey: "users/guest/assets/source/versions/one/original.png",
		checksum: "a".repeat(64),
		bytes: 16,
		mimeType: "image/png",
	},
	target: {
		assetId: "account-input",
		ownerId: "account",
		objectKey: "users/account/assets/account-input/versions/copy/original.png",
	},
};

function fixture() {
	const events: string[] = [];
	let owned: AccountInputCopyClaim | null = structuredClone(claim);
	let immutableTarget:
		| { bytes: number; sha256: string; etag: string; versionId: string }
		| undefined;
	let committed = false;
	const failures: Array<{ reasonCode: string; definitive: boolean }> = [];
	const dependencies: AccountInputCopyDependencies = {
		claim: async () => owned,
		registerMultipart: async (input) => {
			if (input.leaseToken !== owned?.leaseToken) throw new Error("STALE_COPY_LEASE");
			events.push("mpu-persisted");
			owned.multipartUploadId = input.multipartUploadId;
		},
		clearMultipart: async (input) => {
			if (
				input.leaseToken !== owned?.leaseToken ||
				input.multipartUploadId !== owned.multipartUploadId
			)
				throw new Error("STALE_COPY_LEASE");
			delete owned.multipartUploadId;
			events.push("missing-mpu-cleared");
		},
		copy: async (input) => {
			expect(input.staging.key).toBe(claim.source.objectKey);
			expect(input.final.key).toBe(claim.target.objectKey);
			expect(input.expectedSha256).toBe(claim.source.checksum);
			expect(input.acceptExistingFinalIdentity).not.toBe(true);
			expect(input.preferSinglePut).not.toBe(true);
			if (immutableTarget) return immutableTarget;
			await input.promotion?.onMultipartUploadCreated?.({ uploadId: "mpu-1" });
			events.push("bytes-copied-and-verified");
			immutableTarget = {
				bytes: 16,
				sha256: claim.source.checksum,
				etag: "etag",
				versionId: "version",
			};
			return immutableTarget;
		},
		commit: async (input) => {
			if (input.leaseToken !== owned?.leaseToken) throw new Error("STALE_COPY_LEASE");
			expect(input).toMatchObject({
				promotionId: claim.promotionId,
				checksum: claim.source.checksum,
				bytes: 16,
				mimeType: "image/png",
				storageEtag: "etag",
				storageVersionId: "version",
			});
			events.push("materialized-verifying");
			committed = true;
		},
		fail: async (input) => {
			failures.push(input);
		},
	};
	return {
		dependencies,
		events,
		failures,
		get committed() {
			return committed;
		},
		setClaim(value: AccountInputCopyClaim | null) {
			owned = value;
		},
	};
}

describe("account INPUT copy worker", () => {
	it("persists multipart identity before copying and materializes only verified destination bytes", async () => {
		const state = fixture();
		await copyAccountInput({ promotionId: "promotion" }, state.dependencies);
		expect(state.events).toEqual([
			"mpu-persisted",
			"bytes-copied-and-verified",
			"materialized-verifying",
		]);
		expect(state.committed).toBe(true);
		expect(state.failures).toEqual([]);
	});

	it("skips storage and commit when no current business lease can be claimed", async () => {
		const state = fixture();
		state.setClaim(null);
		expect(await copyAccountInput({ promotionId: "promotion" }, state.dependencies)).toEqual({
			outcome: "SKIPPED",
		});
		expect(state.events).toEqual([]);
	});

	it("recovers the same immutable destination after storage success and a lost DB response", async () => {
		const state = fixture();
		const commit = state.dependencies.commit;
		let first = true;
		state.dependencies.commit = async (input) => {
			if (first) {
				first = false;
				throw new Error("DB_RESPONSE_LOST");
			}
			await commit(input);
		};
		await expect(
			copyAccountInput({ promotionId: "promotion" }, state.dependencies),
		).rejects.toThrow("DB_RESPONSE_LOST");
		expect(state.failures).toMatchObject([{ definitive: false }]);
		await copyAccountInput({ promotionId: "promotion" }, state.dependencies);
		expect(state.events.filter((event) => event === "bytes-copied-and-verified")).toHaveLength(1);
		expect(state.committed).toBe(true);
	});

	it.each(["TimeoutError", "AccessDenied", "NoSuchKey"])(
		"retains the destination and reservation after uncertain %s",
		async (name) => {
			const state = fixture();
			state.dependencies.copy = async () => {
				throw Object.assign(new Error(name), { name });
			};
			await expect(
				copyAccountInput({ promotionId: "promotion" }, state.dependencies),
			).rejects.toThrow(name);
			expect(state.committed).toBe(false);
			expect(state.failures).toMatchObject([{ definitive: false }]);
		},
	);

	it("requires an irreversible DB failure before acknowledging invalid bytes", async () => {
		const state = fixture();
		state.dependencies.copy = async () => {
			throw Object.assign(new Error("invalid bytes"), {
				name: "MediaValidationError",
				code: "OUTPUT_MEDIA_TYPE_MISMATCH",
			});
		};
		expect(await copyAccountInput({ promotionId: "promotion" }, state.dependencies)).toEqual({
			outcome: "FAILED",
		});
		expect(state.failures).toMatchObject([
			{ definitive: true, reasonCode: "ACCOUNT_INPUT_COPY_CONTENT_INVALID" },
		]);
		expect(state.committed).toBe(false);
	});

	it("cannot materialize a stale lease even when its storage operation finished", async () => {
		const state = fixture();
		const copy = state.dependencies.copy;
		state.dependencies.copy = async (input) => {
			const result = await copy(input);
			state.setClaim({ ...claim, leaseToken: "lease-2" });
			return result;
		};
		await expect(
			copyAccountInput({ promotionId: "promotion" }, state.dependencies),
		).rejects.toThrow("STALE_COPY_LEASE");
		expect(state.committed).toBe(false);
		expect(state.failures).toMatchObject([{ definitive: false }]);
	});

	it("clears only an explicit missing persisted MPU under the current token before retrying the same key", async () => {
		const state = fixture();
		state.setClaim({ ...claim, multipartUploadId: "missing-mpu" });
		const copy = state.dependencies.copy;
		let attempts = 0;
		state.dependencies.copy = async (input) => {
			attempts++;
			if (input.promotion?.uploadId === "missing-mpu")
				throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
			return copy(input);
		};
		await copyAccountInput({ promotionId: "promotion" }, state.dependencies);
		expect(attempts).toBe(2);
		expect(state.events).toEqual([
			"missing-mpu-cleared",
			"mpu-persisted",
			"bytes-copied-and-verified",
			"materialized-verifying",
		]);
	});

	it("cannot clear a newer actor's MPU after the old lease sees NoSuchUpload", async () => {
		const state = fixture();
		state.setClaim({ ...claim, multipartUploadId: "old-mpu" });
		state.dependencies.copy = async () => {
			state.setClaim({ ...claim, leaseToken: "lease-2", multipartUploadId: "current-mpu" });
			throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
		};
		await expect(
			copyAccountInput({ promotionId: "promotion" }, state.dependencies),
		).rejects.toThrow("STALE_COPY_LEASE");
		expect(state.events).toEqual([]);
		expect(state.committed).toBe(false);
	});

	it("does not trust a mismatched adapter result or a missing source checksum", async () => {
		const state = fixture();
		state.dependencies.copy = async () => ({
			bytes: 16,
			sha256: "b".repeat(64),
			etag: null,
			versionId: null,
		});
		await copyAccountInput({ promotionId: "promotion" }, state.dependencies);
		expect(state.committed).toBe(false);
		expect(state.failures).toMatchObject([{ definitive: true }]);
		const missing = fixture();
		missing.setClaim({ ...claim, source: { ...claim.source, checksum: "" } });
		await copyAccountInput({ promotionId: "promotion" }, missing.dependencies);
		expect(missing.events).toEqual([]);
		expect(missing.failures).toMatchObject([{ definitive: true }]);
	});
});

describe("terminal account-copy orphan recovery", () => {
	function orphanFixture() {
		let terminal = false;
		let objectExists = true;
		let passes = 0;
		const removed: string[] = [];
		const dependencies: AccountInputCopyOrphanDependencies = {
			claim: async () =>
				terminal
					? {
							promotionId: "promotion",
							assetId: claim.target.assetId,
							objectKey: claim.target.objectKey,
							multipartUploadId: "old-mpu",
						}
					: null,
			listMultipartUploads: async () => ["old-mpu", "zero-part-mpu"],
			abortMultipartUpload: async (input) => {
				removed.push(input.key);
			},
			deleteObject: async (input) => {
				removed.push(input.key);
				objectExists = false;
			},
			recordPass: async () => {
				passes++;
			},
		};
		return {
			dependencies,
			removed,
			setTerminal() {
				terminal = true;
			},
			lateWrite() {
				objectExists = true;
			},
			get exists() {
				return objectExists;
			},
			get passes() {
				return passes;
			},
		};
	}

	it("never deletes or aborts a destination that has not been terminally tombstoned", async () => {
		const state = orphanFixture();
		await cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, state.dependencies);
		expect(state.removed).toEqual([]);
		expect(state.passes).toBe(0);
		expect(state.exists).toBe(true);
	});

	it("rechecks a permanently abandoned key after a late writer recreates it", async () => {
		const state = orphanFixture();
		state.setTerminal();
		await cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, state.dependencies);
		expect(state.exists).toBe(false);
		expect(state.passes).toBe(1);
		state.lateWrite();
		await cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, state.dependencies);
		expect(state.exists).toBe(false);
		expect(state.passes).toBe(2);
		expect(new Set(state.removed)).toEqual(new Set([claim.target.objectKey]));
	});

	it("does not record a successful pass when physical deletion is uncertain", async () => {
		const state = orphanFixture();
		state.setTerminal();
		state.dependencies.deleteObject = async () => {
			throw new Error("DELETE_TIMEOUT");
		};
		await expect(
			cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, state.dependencies),
		).rejects.toThrow("DELETE_TIMEOUT");
		expect(state.passes).toBe(0);
	});

	it("gives repeated recovery runs distinct dispatch identities for unresolved late writes", async () => {
		const dispatched: Array<{ task: string; key: string }> = [];
		const dependencies = {
			recover: async () => ({ promotionIds: ["copy"], orphanIds: ["abandoned"] }),
			dispatch: async (
				task: string,
				_payload: Record<string, unknown>,
				options: { idempotencyKey: string },
			) => {
				dispatched.push({ task, key: options.idempotencyKey });
			},
		};
		await recoverAccountInputCopyTasks({ timestamp: 1000 }, dependencies);
		await recoverAccountInputCopyTasks({ timestamp: 2000 }, dependencies);
		expect(dispatched.map((entry) => entry.task)).toEqual([
			"media-copy-account-input",
			"media-cleanup-account-input-copy",
			"media-copy-account-input",
			"media-cleanup-account-input-copy",
		]);
		expect(new Set(dispatched.map((entry) => entry.key)).size).toBe(4);
	});
});

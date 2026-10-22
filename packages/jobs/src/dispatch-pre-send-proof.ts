import type { GenerationSubmissionPreparation, ImagePhaseOwner } from "@repo/database";

import type { DispatchClaim } from "./contracts";

function immutableJsonCopy(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || ancestors.has(value))
		throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
	const prototype = Object.getPrototypeOf(value);
	if (
		Array.isArray(value)
			? prototype !== Array.prototype
			: prototype !== Object.prototype && prototype !== null
	)
		throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
	ancestors.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length)
			throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
		if (Array.isArray(value)) {
			if (Object.keys(descriptors).length !== value.length + 1)
				throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const property = descriptors[index];
				if (!property?.enumerable || !("value" in property))
					throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
				result.push(immutableJsonCopy(property.value, ancestors));
			}
			return Object.freeze(result);
		}
		const result: Record<string, unknown> = {};
		for (const [key, property] of Object.entries(descriptors)) {
			if (!property.enumerable || !("value" in property))
				throw new Error("INVALID_DISPATCH_CLAIM_SNAPSHOT");
			if (property.value === undefined) continue;
			Object.defineProperty(result, key, {
				value: immutableJsonCopy(property.value, ancestors),
				enumerable: true,
			});
		}
		return Object.freeze(result);
	} finally {
		ancestors.delete(value);
	}
}

function sameOwner(left: ImagePhaseOwner | undefined, right: ImagePhaseOwner | undefined): boolean {
	return left
		? !!right &&
				left.phaseKey === right.phaseKey &&
				left.workflowId === right.workflowId &&
				left.epoch === right.epoch
		: right === undefined;
}

/** A request-owned store never accepts a serialized, copied or another store's claim. */
export function createDispatchPreSendProofs() {
	const committed = new WeakMap<DispatchClaim, GenerationSubmissionPreparation>();
	return {
		/** Call only after the preparation transaction has acknowledged its commit. */
		register(claim: DispatchClaim, prepared: GenerationSubmissionPreparation): DispatchClaim {
			const immutable = immutableJsonCopy(claim) as DispatchClaim;
			committed.set(immutable, Object.freeze({ ...prepared }));
			return immutable;
		},
		consume(
			claim: DispatchClaim,
			attemptId: string,
			phaseOwner: ImagePhaseOwner | undefined,
		): GenerationSubmissionPreparation | undefined {
			const prepared = committed.get(claim);
			// Consume synchronously before any database I/O, including failed/unknown checks.
			committed.delete(claim);
			return prepared && prepared.attemptId === attemptId && sameOwner(claim.phaseOwner, phaseOwner)
				? prepared
				: undefined;
		},
	};
}

"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

export interface AdminExecution<T = unknown> {
	executionId: string;
	replayed: boolean;
	result: T;
}

export function useAdminOperation<T>(
	operation: string,
	input: Record<string, unknown> = {},
	enabled = true,
) {
	return useQuery({
		queryKey: ["admin-capabilities", operation, input],
		queryFn: async () => {
			const response = await orpcClient.admin.capabilities.execute({ operation, input });
			return response.result as T;
		},
		enabled,
		retry: false,
	});
}

export function useAdminCapabilities() {
	return useQuery({
		queryKey: ["admin-capabilities", "operations"],
		queryFn: () => orpcClient.admin.capabilities.operations({}),
		retry: false,
	});
}

export function errorCode(error: unknown): string {
	if (!error || typeof error !== "object") return "UNKNOWN";
	const candidate = error as { code?: unknown; data?: { code?: unknown } };
	if (typeof candidate.data?.code === "string") return candidate.data.code;
	return typeof candidate.code === "string" ? candidate.code : "UNKNOWN";
}

export function isUncertainWrite(error: unknown): boolean {
	return ![
		"BAD_REQUEST",
		"UNAUTHORIZED",
		"FORBIDDEN",
		"NOT_FOUND",
		"UNPROCESSABLE_CONTENT",
		"VALIDATION_ERROR",
	].includes(errorCode(error));
}

/** A submission keeps its identity and immutable input until a definite result. */
export function createWriteAttempt<T>(input: T, key = crypto.randomUUID()) {
	return { input: structuredClone(input), idempotencyKey: key };
}

export function createWriteCoordinator<TInput, TResult>() {
	let busy = false;
	let uncertain = false;
	let attempt: ReturnType<typeof createWriteAttempt<TInput>> | null = null;
	return {
		get uncertain() {
			return uncertain;
		},
		get attempt() {
			return attempt;
		},
		async run(
			input: TInput,
			execute: (request: TInput & { idempotencyKey: string }) => Promise<TResult>,
		) {
			if (busy || uncertain) return undefined;
			busy = true;
			attempt ??= createWriteAttempt(input);
			try {
				const result = await execute({ ...attempt.input, idempotencyKey: attempt.idempotencyKey });
				attempt = null;
				return result;
			} catch (error) {
				uncertain = isUncertainWrite(error);
				if (!uncertain) attempt = null;
				throw error;
			} finally {
				busy = false;
			}
		},
	};
}

export function useAdminWrite<TInput, TResult>(
	execute: (input: TInput & { idempotencyKey: string }) => Promise<AdminExecution<TResult>>,
) {
	const coordinator = useRef(createWriteCoordinator<TInput, AdminExecution<TResult>>());
	const [uncertain, setUncertain] = useState(false);
	const mutation = useMutation({
		mutationFn: execute,
		retry: false,
		gcTime: 0,
	});

	async function submit(input: TInput) {
		try {
			return await coordinator.current.run(input, mutation.mutateAsync);
		} catch {
			setUncertain(coordinator.current.uncertain);
			return undefined;
		}
	}

	return {
		...mutation,
		submit,
		uncertain,
		locked: mutation.isPending || uncertain,
		idempotencyKey: coordinator.current.attempt?.idempotencyKey,
	};
}

export function useAdminOperationWrite<TInput, TResult>(operation: string) {
	return useAdminWrite<TInput, TResult>(async ({ idempotencyKey, ...input }) => {
		const result = await orpcClient.admin.capabilities.execute({
			operation,
			input,
			idempotencyKey,
		});
		return result as AdminExecution<TResult>;
	});
}

export function moneyMicros(value: string | null, currency: string | null, locale = "en") {
	if (value === null || !currency) return "—";
	if (!/^-?\d+$/.test(value)) return "—";
	try {
		const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
		const amount = BigInt(value);
		const negative = amount < 0n;
		const absolute = negative ? -amount : amount;
		const divisor = 10n ** BigInt(6 - digits);
		const rounded = (absolute + divisor / 2n) / divisor;
		const base = 10n ** BigInt(digits);
		const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
			rounded / base,
		);
		const fraction = digits
			? new Intl.NumberFormat(locale, {
					useGrouping: false,
					minimumIntegerDigits: digits,
					maximumFractionDigits: 0,
				}).format(rounded % base)
			: "";
		return formatter
			.formatToParts(negative ? -1n : 1n)
			.map((part) =>
				part.type === "integer" ? integer : part.type === "fraction" ? fraction : part.value,
			)
			.join("");
	} catch {
		return "—";
	}
}

export type SourceFilterMode = "all" | "empty" | "value" | "unknown" | `source:${string}`;

export function sourceFilterInput(mode: SourceFilterMode, value: string) {
	if (mode === "all") return undefined;
	if (mode === "unknown") return null;
	if (mode.startsWith("source:")) return mode.slice("source:".length);
	return mode === "empty" ? "" : value.trim();
}

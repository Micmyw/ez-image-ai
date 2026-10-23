export type CallbackDatabaseStage =
	| "transaction-start"
	| "transaction-finish"
	| "lock"
	| "read"
	| "persist"
	| "owner";

export interface CallbackDatabaseTimingOptions {
	onTiming?: (stage: CallbackDatabaseStage, elapsedMs: number, outcome: "ok" | "error") => void;
}

/** Measures client-side boundaries only, without SQL, payloads, retries or additional queries. */
export function createCallbackDatabaseTiming(
	options: CallbackDatabaseTimingOptions,
	now = () => performance.now(),
) {
	function report(stage: CallbackDatabaseStage, start: number, outcome: "ok" | "error") {
		try {
			options.onTiming?.(stage, Math.max(0, now() - start), outcome);
		} catch {
			// A diagnostics sink cannot alter a commit, rollback or wake decision.
		}
	}
	return {
		async measure<T>(stage: CallbackDatabaseStage, operation: () => Promise<T>): Promise<T> {
			const start = now();
			let outcome: "ok" | "error" = "ok";
			try {
				return await operation();
			} catch (error) {
				outcome = "error";
				throw error;
			} finally {
				report(stage, start, outcome);
			}
		},
		async transaction<T, Client>(
			run: (body: (client: Client) => Promise<T>) => Promise<T>,
			body: (client: Client) => Promise<T>,
		): Promise<T> {
			const start = now();
			let entered = false;
			let bodyFinished: number | undefined;
			let outcome: "ok" | "error" = "ok";
			try {
				return await run(async (client) => {
					entered = true;
					report("transaction-start", start, "ok");
					try {
						return await body(client);
					} finally {
						bodyFinished = now();
					}
				});
			} catch (error) {
				outcome = "error";
				throw error;
			} finally {
				if (!entered) report("transaction-start", start, "error");
				if (bodyFinished !== undefined) report("transaction-finish", bodyFinished, outcome);
			}
		},
	};
}

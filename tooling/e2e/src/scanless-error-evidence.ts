/** Local fixture diagnostics only. Never return SQL, messages, parameters or URLs. */
export function safeDatabaseFailure(error: unknown) {
	const object = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const source = object(error);
	const cause = object(source.cause);
	const adapter = object(object(object(source.meta).driverAdapterError).cause);
	const name =
		typeof source.name === "string" &&
		new Set([
			"Error",
			"TypeError",
			"PrismaClientKnownRequestError",
			"PrismaClientUnknownRequestError",
			"PrismaClientInitializationError",
			"PrismaClientRustPanicError",
			"PrismaClientValidationError",
		]).has(source.name)
			? source.name
			: "OtherError";
	const code = (value: unknown) =>
		typeof value === "string" && /^(?:P\d{4}|[0-9][A-Z0-9]{4})$/.test(value) ? value : null;
	const kind = (value: unknown) =>
		typeof value === "string" &&
		new Set([
			"TransactionWriteConflict",
			"UniqueConstraintViolation",
			"ForeignKeyConstraintViolation",
			"DatabaseNotReachable",
			"AuthenticationFailed",
			"ConnectionClosed",
			"SocketTimeout",
			"InvalidIsolationLevel",
			"TransactionAlreadyClosed",
			"DatabaseError",
			"GenericJs",
		]).has(value)
			? value
			: null;
	const message = typeof source.message === "string" ? source.message : "";
	const category = /could not serialize|serialization|transaction write conflict/i.test(message)
		? "serialization-conflict"
		: /unable to start a transaction|transaction.*maxwait/i.test(message)
			? "transaction-start-timeout"
			: /transaction already closed|expired transaction|transaction.*timed? ?out/i.test(message)
				? "transaction-expired"
				: /deadlock/i.test(message)
					? "deadlock"
					: /(?:pool|connection).*(?:timed? ?out|exhaust)|too many connections/i.test(message)
						? "connection-wait"
						: "other";
	return {
		errorName: name,
		errorCode: code(source.code),
		messageCategory: category,
		causeKind: kind(cause.kind),
		causeOriginalCode: code(cause.originalCode),
		adapterCauseKind: kind(adapter.kind),
		adapterOriginalCode: code(adapter.originalCode),
	};
}

/** Observe the existing client without replacing its pool or transaction policy. */
export function observeDatabaseTransactions<Client extends object>(
	client: Client,
	onFailure: (
		evidence: ReturnType<typeof safeDatabaseFailure> & {
			transactionAttempt: number;
			startedAt: number;
		},
	) => void,
): Client {
	let transactionAttempt = 0;
	return new Proxy(client, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "$transaction" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (...args: unknown[]) => {
				const attempt = ++transactionAttempt;
				const startedAt = Date.now();
				const rethrow = (error: unknown): never => {
					try {
						onFailure({ transactionAttempt: attempt, startedAt, ...safeDatabaseFailure(error) });
					} catch {
						// A broken diagnostic sink must never replace the database error.
					}
					throw error;
				};
				let result;
				try {
					result = Reflect.apply(value, target, args);
				} catch (error) {
					return rethrow(error);
				}
				return result && typeof result.catch === "function" ? result.catch(rethrow) : result;
			};
		},
	});
}

import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
	requestId?: string;
	traceId?: string;
	generationJobId?: string;
	attemptId?: string;
	provider?: string;
	productModelKey?: string;
	pricingVersion?: string;
	deploymentVersion?: string;
}

const logContextStorage = new AsyncLocalStorage<Readonly<LogContext>>();

export function getLogContext(): Readonly<LogContext> {
	return logContextStorage.getStore() ?? {};
}

export function withLogContext<T>(context: LogContext, callback: () => T): T {
	return logContextStorage.run(
		Object.freeze({
			...getLogContext(),
			...removeUndefinedValues(context),
		}),
		callback,
	);
}

function removeUndefinedValues(context: LogContext): LogContext {
	return Object.fromEntries(
		Object.entries(context).filter(
			(entry): entry is [keyof LogContext, string] => entry[1] !== undefined,
		),
	) as LogContext;
}

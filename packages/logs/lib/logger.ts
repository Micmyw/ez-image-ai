import { createConsola } from "consola";

import { getLogContext } from "./context";
import { redactForLog } from "./redaction";

const baseLogger = createConsola({
	formatOptions: {
		date: false,
	},
});

const LOG_METHODS = new Set([
	"debug",
	"error",
	"fatal",
	"info",
	"log",
	"ready",
	"start",
	"success",
	"trace",
	"verbose",
	"warn",
]);

export const logger = new Proxy(baseLogger, {
	get(target, property, receiver) {
		const value = Reflect.get(target, property, receiver);
		if (typeof property !== "string" || !LOG_METHODS.has(property) || typeof value !== "function") {
			return typeof value === "function" ? value.bind(target) : value;
		}
		return (...args: unknown[]) => {
			const context = getLogContext();
			const safeArgs = args.map(redactForLog);
			if (Object.keys(context).length > 0) safeArgs.push({ context: redactForLog(context) });
			return Reflect.apply(value, target, safeArgs);
		};
	},
});

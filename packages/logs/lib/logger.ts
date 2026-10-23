import { createConsola } from "consola";

import { getLogContext } from "./context";
import { redactForLog } from "./redaction";

const baseLogger = createConsola({
	formatOptions: {
		date: false,
	},
});

// Format only this high-frequency diagnostic at the reporter boundary. Calls
// still pass through Consola's level, pause, throttle and method interception.
const defaultReporters = [...baseLogger.options.reporters];
baseLogger.setReporters([
	{
		log(record, reporterContext) {
			const [message, fields, extra] = record.args;
			const context =
				extra && typeof extra === "object" && "context" in extra ? extra.context : undefined;
			if (
				record.type === "info" &&
				message === "media.flow.timing" &&
				fields !== null &&
				typeof fields === "object" &&
				!Array.isArray(fields) &&
				(record.args.length === 2 || (record.args.length === 3 && context !== undefined))
			) {
				console.info(
					JSON.stringify({
						...(redactForLog(fields) as Record<string, unknown>),
						message: "media.flow.timing",
						...(context === undefined ? {} : { context: redactForLog(context) }),
					}),
				);
				return;
			}
			for (const reporter of defaultReporters) reporter.log(record, reporterContext);
		},
	},
]);

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

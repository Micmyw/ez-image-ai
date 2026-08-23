const REDACTED = "[REDACTED]";
const REDACTED_URL = "[REDACTED_URL]";
const CIRCULAR = "[Circular]";

const SENSITIVE_KEY_PATTERN =
	/(?:^|[_-])(?:authorization|cookie|set-cookie|prompt|negativeprompt|api[-_]?key|access[-_]?key|secret|token|password|credential|signature|stripe[-_]?signature)(?:$|[_-])/i;
const SENSITIVE_CONTAINER_PATTERN = /(?:provider.*(?:raw|payload)|raw.*provider)/i;
const URL_KEY_PATTERN = /(?:url|uri|href)$/i;
const SENSITIVE_QUERY_PATTERN = /(?:x-amz-|signature|credential|token|secret|key)=/i;
const MEDIA_URL_PATTERN = /\.(?:avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)(?:[?#]|$)/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const INLINE_SECRET_PATTERNS = [
	/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
	/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_-]+\b/gi,
	/\b(?:whsec|repl|fal|kie|AIza)[A-Za-z0-9_-]{8,}\b/gi,
];

export function redactForLog(value: unknown): unknown {
	return redactValue(value, new WeakSet<object>(), false);
}

function redactValue(value: unknown, seen: WeakSet<object>, redactContainer: boolean): unknown {
	if (redactContainer) return REDACTED;
	if (typeof value === "string") return redactString(value);
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return CIRCULAR;
	seen.add(value);

	if (value instanceof Date) return value.toISOString();
	if (value instanceof URL) return redactUrl(value.toString());
	if (value instanceof Error) return redactError(value, seen);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, false));
	if (value instanceof Map) {
		return Object.fromEntries(
			Array.from(value.entries(), ([key, item]) => [
				redactString(String(key)),
				redactValue(item, seen, false),
			]),
		);
	}
	if (value instanceof Set) {
		return Array.from(value, (item) => redactValue(item, seen, false));
	}

	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_KEY_PATTERN.test(normalizeKey(key))) {
			result[key] = REDACTED;
			continue;
		}
		if (URL_KEY_PATTERN.test(key) && typeof item === "string") {
			result[key] = redactUrl(item, true);
			continue;
		}
		result[key] = redactValue(item, seen, SENSITIVE_CONTAINER_PATTERN.test(key));
	}
	return result;
}

function redactError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
	const errorWithCause = error as Error & { cause?: unknown };
	const result: Record<string, unknown> = {
		name: redactString(error.name),
		message: redactString(error.message),
	};
	if (error.stack) result.stack = redactString(error.stack);
	if (errorWithCause.cause !== undefined) {
		result.cause = redactValue(errorWithCause.cause, seen, false);
	}
	for (const [key, value] of Object.entries(error)) {
		result[key] = SENSITIVE_KEY_PATTERN.test(normalizeKey(key))
			? REDACTED
			: redactValue(value, seen, SENSITIVE_CONTAINER_PATTERN.test(key));
	}
	return result;
}

function redactString(value: string): string {
	let result = value;
	for (const pattern of INLINE_SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
	return result.replace(URL_PATTERN, (url) => redactUrl(url));
}

function redactUrl(value: string, force = false): string {
	if (force || SENSITIVE_QUERY_PATTERN.test(value) || MEDIA_URL_PATTERN.test(value))
		return REDACTED_URL;
	return value;
}

function normalizeKey(value: string): string {
	return value.replace(/([a-z])([A-Z])/g, "$1_$2");
}

const SOURCES = [
	"AUTHENTICATED_RETRIEVAL",
	"AUTHENTICATED_SUBMISSION",
	"CALLBACK_DIAGNOSTIC",
	"INTERNAL_DIAGNOSTIC",
] as const;

/** Private, informational text. This never authorizes settlement, retry or task completion. */
export interface ProviderDiagnostic {
	version: 1;
	attemptId: string;
	provider: string;
	providerTaskId?: string;
	message: string;
	source: (typeof SOURCES)[number];
	observedAt: string;
}

export interface ProviderDiagnosticIdentity {
	id: string;
	provider: string;
	providerTaskId?: string | null;
}

/** Selected provider message leaves only; never serialize an arbitrary response or error object. */
export function sanitizeProviderDiagnosticMessage(
	value: unknown,
	sensitiveValues: readonly string[] = [],
): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	// Bound work before matching. Redact before truncating the persisted text so a
	// token or signed URL that straddles the output boundary is never partly kept.
	let text = value.slice(0, 16_384);
	if (value.length > text.length) text = text.replace(/\S+$/, "");
	// Provider messages occasionally contain escaped JSON or percent-encoded URLs.
	// Decode bounded text before redaction, never after it.
	for (let pass = 0; pass < 2; pass++) {
		text = text
			.replace(/\\u00([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\([/"'])/g, "$1")
			.replace(/(?:%[a-f0-9]{2})+/gi, (encoded) => {
				try {
					return decodeURIComponent(encoded);
				} catch {
					return encoded;
				}
			});
	}
	for (const secret of sensitiveValues) {
		if (secret && secret.length >= 4) {
			text = text.replaceAll(secret, "[redacted credential]");
			text = text.replaceAll(encodeURIComponent(secret), "[redacted credential]");
		}
	}
	text = text
		.replace(/-----BEGIN[\s\S]*?(?:-----END[^\r\n]*|$)/g, "[redacted credential]")
		.replace(/(?:https?|s3|r2|data):(?:\/\/|[^\s]*;base64,)[^\s<>"']*/gi, "[redacted URL]")
		.replace(/(?:https?|s3|r2)%3a(?:%2f){2}[^\s<>"']*/gi, "[redacted URL]")
		.replace(
			/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|signature|secret|password|credential|token|key|object[-_ ]?key)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:(?:Bearer|Basic|Key)\s+)?[^\s,;}>]+)/gi,
			"[redacted credential]",
		)
		.replace(/\b(?:Bearer|Basic|Authorization\s+Key)\s+[^\s,;"'}]+/gi, "[redacted credential]")
		.replace(
			/\b(?:users|organizations|temporary-references|guests)\/[^\s<>"']+/gi,
			"[redacted object]",
		)
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[redacted credential]")
		.replace(/\b(?:sk|rk|pk)[_-][a-z0-9_-]{8,}\b/gi, "[redacted credential]")
		.replace(/\b[A-Za-z0-9_+/=.-]{32,}\b/g, "[redacted identifier]")
		// eslint-disable-next-line no-control-regex -- Remove controls from persisted private display text.
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text ? text.slice(0, 500) : null;
}

/** Shape validation is not evidence of origin; writers must select source from their call path. */
export function parseProviderDiagnostic(value: unknown): ProviderDiagnostic | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const message = sanitizeProviderDiagnosticMessage(record.message);
	if (
		record.version !== 1 ||
		!identifier(record.attemptId) ||
		typeof record.provider !== "string" ||
		!/^[a-z][a-z0-9-]{0,39}$/.test(record.provider) ||
		!SOURCES.includes(record.source as ProviderDiagnostic["source"]) ||
		!canonicalTimestamp(record.observedAt) ||
		!message ||
		(record.providerTaskId !== undefined && !identifier(record.providerTaskId)) ||
		((record.source === "AUTHENTICATED_RETRIEVAL" || record.source === "CALLBACK_DIAGNOSTIC") &&
			!record.providerTaskId)
	)
		return null;
	return {
		version: 1,
		attemptId: record.attemptId,
		provider: record.provider,
		...(typeof record.providerTaskId === "string" ? { providerTaskId: record.providerTaskId } : {}),
		message,
		source: record.source as ProviderDiagnostic["source"],
		observedAt: record.observedAt,
	};
}

/** Revalidate persisted diagnostics against the actual attempt; no origin inference from raw JSON. */
export function readProviderDiagnostic(
	value: unknown,
	identity: ProviderDiagnosticIdentity,
): ProviderDiagnostic | null {
	const diagnostic = parseProviderDiagnostic(value);
	if (
		!diagnostic ||
		diagnostic.attemptId !== identity.id ||
		diagnostic.provider !== identity.provider ||
		(diagnostic.providerTaskId !== undefined &&
			diagnostic.providerTaskId !== identity.providerTaskId)
	)
		return null;
	return diagnostic;
}

export function createProviderDiagnostic(
	identity: ProviderDiagnosticIdentity,
	input: { message: unknown; source: ProviderDiagnostic["source"]; observedAt?: string },
	sensitiveValues: readonly string[] = [],
): ProviderDiagnostic | null {
	return readProviderDiagnostic(
		{
			version: 1,
			attemptId: identity.id,
			provider: identity.provider,
			...(identity.providerTaskId ? { providerTaskId: identity.providerTaskId } : {}),
			message: sanitizeProviderDiagnosticMessage(input.message, sensitiveValues),
			source: input.source,
			observedAt: input.observedAt ?? new Date().toISOString(),
		},
		identity,
	);
}

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		/^[A-Za-z0-9_.:-]+$/.test(value)
	);
}
function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
		return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

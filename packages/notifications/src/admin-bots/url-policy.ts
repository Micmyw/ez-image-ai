import { AdminBotInputError, type BotChannel } from "./types";

const officialHosts: Record<BotChannel, readonly string[]> = {
	telegram: ["api.telegram.org"],
	feishu: ["open.feishu.cn", "open.larksuite.com"],
	wecom: ["qyapi.weixin.qq.com"],
	webhook: [],
};

export function validateBotUrl(
	value: string,
	channel: BotChannel,
	allowedHosts = process.env.ADMIN_BOT_ALLOWED_HOSTS ?? "",
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AdminBotInputError("ADMIN_BOT_URL_INVALID");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		url.hostname.endsWith(".") ||
		!url.hostname.includes(".") ||
		!/^[a-z0-9.-]+$/i.test(url.hostname) ||
		/^[\d.]+$/.test(url.hostname)
	)
		throw new AdminBotInputError("ADMIN_BOT_URL_REJECTED");
	const allowed = [
		...officialHosts[channel],
		...allowedHosts.split(",").map((host) => host.trim().toLowerCase()),
	];
	if (!allowed.includes(url.hostname.toLowerCase()))
		throw new AdminBotInputError("ADMIN_BOT_HOST_NOT_ALLOWED");
	return url;
}

/** Reject reserved IPv4 and non-global IPv6 before Node pins the connection. */
export function isPublicBotAddress(address: string): boolean {
	if (address.includes(":")) {
		// Global unicast only. Reject mapped IPv4, link local, transition and documentation space.
		const normalized = address.toLowerCase();
		const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
		return (
			first >= 0x2000 &&
			first <= 0x3fff &&
			!/^2001:(?:0:|db8:|10:|20:)/.test(normalized) &&
			!normalized.startsWith("2002:") &&
			!normalized.includes(".") &&
			!normalized.includes("%")
		);
	}
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
		return false;
	const [a, b, c] = parts as [number, number, number, number];
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113)
	);
}

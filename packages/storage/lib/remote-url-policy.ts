import { promises as dns } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}

export interface RemoteUrlPolicyOptions {
	allowedHosts: readonly string[];
	resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface ValidatedRemoteUrl {
	url: URL;
	addresses: ResolvedAddress[];
	lookup: LookupFunction;
}

function hostMatches(hostname: string, rule: string): boolean {
	const normalized = rule.toLowerCase();
	if (normalized.startsWith("*.")) {
		const suffix = normalized.slice(1);
		return hostname.endsWith(suffix) && hostname.length > suffix.length;
	}
	return hostname === normalized;
}

function parseIpv4(address: string): number | null {
	if (isIP(address) !== 4) return null;
	return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (value & mask) === (base & mask);
}

function isUnsafeIpv4(address: string): boolean {
	const value = parseIpv4(address);
	if (value === null) return true;
	return [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	].some(([base, prefix]) => inIpv4Range(value, parseIpv4(base as string)!, prefix as number));
}

function expandIpv6(address: string): number[] | null {
	if (isIP(address) !== 6) return null;
	const lower = address.toLowerCase().split("%")[0]!;
	const [leftText, rightText] = lower.split("::", 2);
	const left = leftText ? leftText.split(":") : [];
	const right = rightText ? rightText.split(":") : [];
	const missing = 8 - left.length - right.length;
	const parts = lower.includes("::") ? [...left, ...Array(missing).fill("0"), ...right] : left;
	if (parts.length !== 8) return null;
	return parts.map((part) => Number.parseInt(part, 16));
}

function isUnsafeIpv6(address: string): boolean {
	const parts = expandIpv6(address);
	if (!parts || parts.some((part) => !Number.isInteger(part))) return true;
	if (parts.slice(0, 7).every((part) => part === 0) && (parts[7] === 0 || parts[7] === 1))
		return true;
	if ((parts[0]! & 0xfe00) === 0xfc00) return true;
	if ((parts[0]! & 0xffc0) === 0xfe80) return true;
	if ((parts[0]! & 0xff00) === 0xff00) return true;
	if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true;
	if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
		return isUnsafeIpv4(
			`${parts[6]! >> 8}.${parts[6]! & 0xff}.${parts[7]! >> 8}.${parts[7]! & 0xff}`,
		);
	}
	return false;
}

function isUnsafeAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4 ? isUnsafeIpv4(address) : family === 6 ? isUnsafeIpv6(address) : true;
}

export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
	const validated = [...addresses];
	return ((
		_hostname: string,
		options: { all?: boolean; family?: number } | number,
		callback: (
			error: NodeJS.ErrnoException | null,
			address: string | ResolvedAddress[],
			family?: number,
		) => void,
	) => {
		const requestedFamily = typeof options === "number" ? options : options.family;
		const candidates = requestedFamily
			? validated.filter((entry) => entry.family === requestedFamily)
			: validated;
		if (candidates.length === 0) {
			const error = new Error(
				"No validated remote address matches the requested family",
			) as NodeJS.ErrnoException;
			error.code = "ENOTFOUND";
			callback(error, "", 0);
			return;
		}
		if (typeof options === "object" && options.all) callback(null, candidates);
		else callback(null, candidates[0]!.address, candidates[0]!.family);
	}) as LookupFunction;
}

export async function assertAllowedRemoteUrl(
	value: string | URL,
	options: RemoteUrlPolicyOptions,
): Promise<ValidatedRemoteUrl> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Remote URL is invalid");
	}
	if (url.protocol !== "https:") throw new Error("Remote URL must use HTTPS");
	if (url.username || url.password || url.port) throw new Error("Remote URL authority is invalid");
	const hostname = url.hostname.toLowerCase();
	if (!options.allowedHosts.some((rule) => hostMatches(hostname, rule))) {
		throw new Error("Remote URL host is not allowed");
	}
	if (isIP(hostname)) throw new Error("Remote URL must use an allowed provider hostname");
	const resolver =
		options.resolve ??
		(async (name: string) => {
			const records = await dns.lookup(name, { all: true, verbatim: true });
			return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
		});
	const addresses = await resolver(hostname);
	if (addresses.length === 0 || addresses.some((entry) => isUnsafeAddress(entry.address))) {
		throw new Error("Remote URL resolved to a private or reserved address");
	}
	return { url, addresses, lookup: createPinnedLookup(addresses) };
}

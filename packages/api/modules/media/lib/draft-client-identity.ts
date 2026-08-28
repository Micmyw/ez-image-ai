import { isIP } from "node:net";

import { isLocalProductionBuildE2EEnvironment } from "@repo/config/server";

export function draftClientIdentity(
	headers: Headers,
	environment: Record<string, string | undefined>,
): string {
	if (isLocalProductionBuildE2EEnvironment(environment)) return "127.0.0.1";
	const provider = environment.MEDIA_TRUSTED_PROXY_PROVIDER?.trim().toLowerCase();
	const value =
		provider === "vercel"
			? headers.get("x-vercel-forwarded-for")?.split(",")[0]
			: provider === "cloudflare"
				? headers.get("cf-connecting-ip")
				: undefined;
	return normalizeAddress(value) ?? "unattributed";
}

export function trustedGuestClientIdentity(
	headers: Headers,
	environment: Record<string, string | undefined>,
): { ip: string; subnet: string } | null {
	const ip = draftClientIdentity(headers, environment);
	const version = isIP(ip);
	if (!version) return null;
	if (version === 4) {
		const octets = ip.split(".");
		return { ip, subnet: `${octets[0]}.${octets[1]}.${octets[2]}.0/24` };
	}
	const groups = parseIpv6Groups(ip);
	if (!groups) return null;
	return {
		ip: formatIpv6(groups),
		subnet: `${formatIpv6([...groups.slice(0, 4), "0", "0", "0", "0"])}/64`,
	};
}

function normalizeAddress(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 64 || !/^[0-9a-f:.]+$/i.test(trimmed)) return null;
	return trimmed.toLowerCase();
}

function parseIpv6Groups(value: string): string[] | null {
	let address = value.toLowerCase();
	if (address.includes(".")) {
		const separator = address.lastIndexOf(":");
		const octets = address
			.slice(separator + 1)
			.split(".")
			.map(Number);
		if (separator < 0 || octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
			return null;
		}
		address = `${address.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
	if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return null;
	const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16).toString(16));
}

function formatIpv6(groups: string[]): string {
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < groups.length;) {
		if (groups[index] !== "0") {
			index += 1;
			continue;
		}
		let end = index;
		while (groups[end] === "0") end += 1;
		if (end - index > bestLength) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	if (bestLength < 2) return groups.join(":");
	const left = groups.slice(0, bestStart).join(":");
	const right = groups.slice(bestStart + bestLength).join(":");
	return `${left}::${right}`;
}

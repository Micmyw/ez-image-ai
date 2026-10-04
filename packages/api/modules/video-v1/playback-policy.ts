import { createHmac, timingSafeEqual } from "node:crypto";

type PlaybackIdentity = {
	userId: string;
	jobId: string;
	assetId: string;
	checksum: string;
	expires: number;
	download: boolean;
};
export function signPlaybackGrant(identity: PlaybackIdentity, secret: string): string {
	if (secret.length < 32) throw new Error("VIDEO_PLAYBACK_SIGNING_UNAVAILABLE");
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				identity.userId,
				identity.jobId,
				identity.assetId,
				identity.checksum,
				identity.expires,
				identity.download,
			]),
		)
		.digest("hex");
}
export function verifyPlaybackGrant(
	identity: PlaybackIdentity,
	signature: string,
	secret: string,
	now = Date.now(),
): boolean {
	if (
		!Number.isSafeInteger(identity.expires) ||
		identity.expires <= now ||
		identity.expires > now + 300_000 ||
		!/^[a-f0-9]{64}$/.test(signature)
	)
		return false;
	return timingSafeEqual(
		Buffer.from(signPlaybackGrant(identity, secret), "hex"),
		Buffer.from(signature, "hex"),
	);
}
export function parseVideoRange(
	header: string | null,
	bytes: number,
): { start: number; end: number } | "invalid" | null {
	if (!header || header.includes(",")) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) return "invalid";
	const first = match[1] ? Number(match[1]) : null;
	const last = match[2] ? Number(match[2]) : null;
	if (
		(first !== null && !Number.isSafeInteger(first)) ||
		(last !== null && !Number.isSafeInteger(last))
	)
		return "invalid";
	const start = first ?? Math.max(0, bytes - (last ?? 0));
	const end = first === null ? bytes - 1 : Math.min(last ?? bytes - 1, bytes - 1);
	return start < 0 || start >= bytes || end < start ? "invalid" : { start, end };
}

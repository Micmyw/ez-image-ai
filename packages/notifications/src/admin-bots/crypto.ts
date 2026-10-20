const purpose = new TextEncoder().encode("ezpic:admin-bot-secrets:v1:platform");
const prefix = "aesgcm:v1:";

function decode(value: string): Uint8Array<ArrayBuffer> {
	try {
		return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
	} catch {
		throw new AdminBotInputError("ADMIN_BOT_ENCRYPTION_KEY_INVALID");
	}
}
function encode(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes));
}
export function hasBotEncryptionKey(value = process.env.ADMIN_BOT_ENCRYPTION_KEY): boolean {
	try {
		return !!value && decode(value).byteLength === 32;
	} catch {
		return false;
	}
}
async function encryptionKey(value = process.env.ADMIN_BOT_ENCRYPTION_KEY) {
	if (!value) throw new AdminBotInputError("ADMIN_BOT_ENCRYPTION_KEY_REQUIRED");
	const bytes = decode(value);
	if (bytes.byteLength !== 32) throw new AdminBotInputError("ADMIN_BOT_ENCRYPTION_KEY_INVALID");
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptBotSecrets(value: unknown, keyValue?: string) {
	const key = await encryptionKey(keyValue);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: purpose },
		key,
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return `${prefix}${encode(iv)}:${encode(new Uint8Array(encrypted))}`;
}
export async function decryptBotSecrets(value: string, keyValue?: string): Promise<unknown> {
	if (!value.startsWith(prefix)) throw new AdminBotInputError("ADMIN_BOT_SECRET_FORMAT_INVALID");
	const [iv, encrypted, extra] = value.slice(prefix.length).split(":");
	if (!iv || !encrypted || extra) throw new AdminBotInputError("ADMIN_BOT_SECRET_FORMAT_INVALID");
	try {
		const key = await encryptionKey(keyValue);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: decode(iv), additionalData: purpose },
			key,
			decode(encrypted),
		);
		return JSON.parse(new TextDecoder().decode(plaintext));
	} catch {
		throw new AdminBotInputError("ADMIN_BOT_SECRET_DECRYPT_FAILED");
	}
}
import { AdminBotInputError } from "./types";

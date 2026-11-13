import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const dataHome = () => resolve(process.env.GSC_HOME || join(homedir(), ".gsc-seo"));
export const configPath = () => resolve(process.env.GSC_CONFIG || join(dataHome(), "config.json"));
export const propertyKey = (property) =>
	createHash("sha256").update(property).digest("hex").slice(0, 24);
export const searchTypes = ["web", "image", "video", "news"];

export function validateProperty(property) {
	if (typeof property !== "string") throw new Error("A Search Console property is required.");
	if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(property)) return property;
	const url = new URL(property);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!property.endsWith("/")
	)
		throw new Error("Use an exact sc-domain:example.com or URL-prefix property ending in /.");
	return property;
}

export function assertDate(value) {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(Date.parse(`${value}T12:00:00Z`)) ||
		new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
	)
		throw new Error("Date must be a valid YYYY-MM-DD.");
	return value;
}

export function shiftDate(value, days) {
	const date = new Date(`${assertDate(value)}T12:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

export function pacificDate(now = new Date()) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

export function integer(value, name, min, max) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max)
		throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return number;
}

export async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw new Error(`Cannot read valid JSON from ${path}.`);
	}
}

export async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try {
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function loadConfig() {
	const config = await readJson(configPath());
	if (!config || config.version !== 1 || !Array.isArray(config.sites) || !config.sites.length)
		throw new Error("GSC is not configured. Run the configure command first.");
	if (!isAbsolute(config.credentialsFile) || !isAbsolute(config.dataDir))
		throw new Error("Credential and data paths must be absolute.");
	for (const site of config.sites) {
		validateProperty(site.property);
		if (
			!site.name ||
			!Array.isArray(site.brandTerms) ||
			site.brandTerms.some((term) => typeof term !== "string" || !term.trim())
		)
			throw new Error("Invalid site configuration.");
	}
	return config;
}

export function selectSite(config, name) {
	const matches = name
		? config.sites.filter((site) => site.name === name || site.property === name)
		: config.sites.length === 1
			? config.sites
			: [];
	if (matches.length !== 1)
		throw new Error("Select exactly one configured site by name or property.");
	return matches[0];
}

export function validateType(type = "web") {
	if (!searchTypes.includes(type))
		throw new Error(`Search type must be ${searchTypes.join(", ")}.`);
	return type;
}

export function assertInspectionUrl(property, value) {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error("An HTTP(S) URL without credentials or fragment is required.");
	if (property.startsWith("sc-domain:")) {
		const domain = property.slice(10).toLowerCase();
		if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
			throw new Error("URL is outside the configured property.");
	} else {
		const prefix = new URL(property);
		if (url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname))
			throw new Error("URL is outside the configured property.");
	}
	return url.href;
}

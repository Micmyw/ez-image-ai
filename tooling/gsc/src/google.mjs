import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { GoogleAuth, OAuth2Client } from "google-auth-library";

import { assertInspectionUrl } from "./config.mjs";

export const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export class GscClient {
	constructor(auth, { fetchImpl = fetch, sleep = delay } = {}) {
		this.auth = auth;
		this.fetch = fetchImpl;
		this.sleep = sleep;
	}

	async request(url, body) {
		if (
			!(
				url === `${API}/sites` ||
				/^https:\/\/www\.googleapis\.com\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/.test(
					url,
				) ||
				url === INSPECT
			)
		)
			throw new Error("Only read-only GSC endpoints are allowed.");
		for (let attempt = 0; attempt < 4; attempt++) {
			let response;
			try {
				const headers = new Headers(await this.auth.getRequestHeaders(url));
				headers.set("content-type", "application/json");
				response = await this.fetch(url, {
					method: body ? "POST" : "GET",
					headers,
					body: body ? JSON.stringify(body) : undefined,
					redirect: "error",
					signal: AbortSignal.timeout(30000),
				});
			} catch {
				// Never expose auth-library errors, which can embed credentials and request headers.
				throw new Error(
					"GSC authentication or network request failed. Check the credential file, network and Google access; no secrets were logged.",
				);
			}
			if (response.ok) return response.json();
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				const retryAfter = Number(response.headers.get("retry-after"));
				await response.body?.cancel();
				await this.sleep(
					Math.min(
						30000,
						Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0),
					),
				);
				continue;
			}
			await response.body?.cancel();
			throw new Error(
				`GSC HTTP ${response.status}. ${response.status === 403 ? "Check API enablement, the authorized account's property permission and Google quota." : response.status === 401 ? "Refresh the Google authorization or check the service-account credential." : "Request failed; the current day was not saved."}`,
			);
		}
	}

	sites() {
		return this.request(`${API}/sites`);
	}
	query(property, body) {
		return this.request(`${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, body);
	}
	inspect(property, url) {
		return this.request(INSPECT, {
			siteUrl: property,
			inspectionUrl: assertInspectionUrl(property, url),
			languageCode: "zh-CN",
		});
	}
}

export async function createClient(config) {
	let credentials;
	try {
		credentials = JSON.parse(await readFile(config.credentialsFile, "utf8"));
	} catch {
		throw new Error(
			"Cannot read the configured Google credential file. Do not paste its contents into chat.",
		);
	}
	if (credentials.type === "authorized_user") {
		if (
			!credentials.client_id?.endsWith(".apps.googleusercontent.com") ||
			!credentials.client_secret ||
			!credentials.refresh_token ||
			credentials.scope !== READONLY_SCOPE
		)
			throw new Error(
				"Expected the dedicated readonly OAuth credential from the authorize command.",
			);
		const auth = new OAuth2Client(credentials.client_id, credentials.client_secret);
		auth.setCredentials({ refresh_token: credentials.refresh_token });
		return new GscClient(auth);
	}
	if (
		credentials.type !== "service_account" ||
		!credentials.client_email?.endsWith(".iam.gserviceaccount.com") ||
		!credentials.private_key?.startsWith("-----BEGIN PRIVATE KEY-----") ||
		credentials.token_uri !== "https://oauth2.googleapis.com/token" ||
		(credentials.universe_domain && credentials.universe_domain !== "googleapis.com")
	)
		throw new Error("Expected a Google service-account key for the googleapis.com universe.");
	const auth = new GoogleAuth({ credentials, scopes: [READONLY_SCOPE] });
	return new GscClient(await auth.getClient());
}

export async function queryAll(client, property, body, { pageSize = 25000, maxRows = 50000 } = {}) {
	const rows = [];
	let aggregation;
	for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
		const response = await client.query(property, {
			...body,
			rowLimit: Math.min(pageSize, maxRows - startRow),
			startRow,
		});
		if (
			!response ||
			typeof response !== "object" ||
			(response.rows !== undefined && !Array.isArray(response.rows))
		)
			throw new Error("Unexpected Search Analytics response.");
		const batch = response.rows ?? [];
		aggregation = response.responseAggregationType ?? aggregation;
		for (const row of batch) {
			if (
				![row.clicks, row.impressions, row.ctr, row.position].every(
					(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
				) ||
				(!Array.isArray(row.keys) && body.dimensions?.length)
			)
				throw new Error("Invalid Search Analytics metrics.");
		}
		rows.push(...batch);
		if (batch.length < Math.min(pageSize, maxRows - startRow))
			return { rows, aggregation, hitRowCap: false };
	}
	return { rows, aggregation, hitRowCap: true };
}

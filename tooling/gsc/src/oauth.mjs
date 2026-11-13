import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { OAuth2Client } from "google-auth-library";

import { writeJson } from "./config.mjs";
import { READONLY_SCOPE } from "./google.mjs";

export function validState(expected, actual) {
	return (
		typeof actual === "string" &&
		Buffer.byteLength(expected) === Buffer.byteLength(actual) &&
		timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
	);
}

export async function authorize({
	clientFile,
	credentialsFile,
	onReady = console.log,
	timeoutMs = 480000,
}) {
	let installed;
	try {
		installed = JSON.parse(await readFile(clientFile, "utf8")).installed;
	} catch {
		throw new Error("Cannot read the downloaded OAuth desktop client JSON.");
	}
	if (
		!installed?.client_id?.endsWith(".apps.googleusercontent.com") ||
		!installed.client_secret ||
		installed.auth_uri !== "https://accounts.google.com/o/oauth2/auth" ||
		installed.token_uri !== "https://oauth2.googleapis.com/token"
	)
		throw new Error("Use the Google OAuth Desktop app JSON, not the production web-login client.");
	const state = randomBytes(32).toString("base64url");
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
	const client = new OAuth2Client(installed.client_id, installed.client_secret, redirectUri);
	const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
	let handled = false;
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("OAuth browser authorization timed out; run authorize again.")),
				timeoutMs,
			);
			server.on("request", async (request, response) => {
				response.setHeader("Cache-Control", "no-store");
				response.setHeader("Referrer-Policy", "no-referrer");
				response.setHeader("Content-Security-Policy", "default-src 'none'");
				const url = new URL(request.url, redirectUri);
				if (
					request.method !== "GET" ||
					request.headers.host !== new URL(redirectUri).host ||
					url.pathname !== "/oauth2callback" ||
					!validState(state, url.searchParams.get("state"))
				) {
					response.writeHead(400).end("Invalid OAuth callback.");
					return;
				}
				if (handled) {
					response.writeHead(409).end("Authorization already being processed.");
					return;
				}
				handled = true;
				try {
					if (url.searchParams.has("error") || !url.searchParams.get("code"))
						throw new Error("Authorization was declined.");
					const { tokens } = await client.getToken({
						code: url.searchParams.get("code"),
						codeVerifier,
						redirect_uri: redirectUri,
					});
					if (!tokens.refresh_token || !tokens.access_token)
						throw new Error("No offline authorization token was returned.");
					const scopes = tokens.scope
						? tokens.scope.split(" ")
						: (await client.getTokenInfo(tokens.access_token)).scopes;
					if (scopes.length !== 1 || scopes[0] !== READONLY_SCOPE)
						throw new Error("Expected only the Search Console readonly scope.");
					await writeJson(credentialsFile, {
						type: "authorized_user",
						client_id: installed.client_id,
						client_secret: installed.client_secret,
						refresh_token: tokens.refresh_token,
						scope: READONLY_SCOPE,
						authorizedAt: new Date().toISOString(),
					});
					response
						.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
						.end(
							"GSC read-only authorization completed. Credentials were saved locally. You can close this tab.",
						);
					clearTimeout(timer);
					resolve();
				} catch {
					response
						.writeHead(400)
						.end("GSC authorization failed; no credentials were logged. Return to the local tool.");
					clearTimeout(timer);
					reject(
						new Error(
							"OAuth consent or token exchange failed. Check the Google client settings and retry; no credentials were logged.",
						),
					);
				}
			});
			onReady({
				pid: process.pid,
				authorizationUrl: client.generateAuthUrl({
					access_type: "offline",
					scope: [READONLY_SCOPE],
					prompt: "consent",
					state,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					include_granted_scopes: false,
				}),
				callbackOrigin: new URL(redirectUri).origin,
			});
		});
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	return { authorized: true, scope: READONLY_SCOPE, credentialsFile };
}

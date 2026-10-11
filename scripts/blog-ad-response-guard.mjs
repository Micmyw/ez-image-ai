import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function bounded(operation, label, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timeout.`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Public CDP transport only: flattened sessionId envelopes over the owned
// Chromium's loopback browser debugger socket. No Playwright private objects.
export async function ownedBrowserDebuggerUrl(browser) {
	const session = await browser.newBrowserCDPSession();
	try {
		const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
		if (!args.includes("--remote-debugging-port=0")) {
			throw new Error("Launch the fresh owned Chromium with --remote-debugging-port=0.");
		}
		const profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
		if (!profile || !/^playwright_chromiumdev_profile-/.test(path.basename(profile))) {
			throw new Error("Only a fresh Playwright Chromium temporary profile is supported.");
		}
		const relative = path.relative(os.tmpdir(), path.resolve(profile));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error("The owned temporary browser profile is outside the OS temp directory.");
		}
		const [port, socketPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
			.trim()
			.split(/\r?\n/);
		if (
			!/^\d+$/.test(port) ||
			+port < 1 ||
			+port > 65535 ||
			!/^\/devtools\/browser\/[a-f0-9-]+$/i.test(socketPath)
		) {
			throw new Error("Invalid owned browser debugger endpoint.");
		}
		return `ws://127.0.0.1:${port}${socketPath}`;
	} finally {
		await session.detach();
	}
}

class PublicBrowserCdp {
	constructor(socket, onProtocol, onFailure, timeoutMs) {
		this.socket = socket;
		this.onProtocol = onProtocol;
		this.onFailure = onFailure;
		this.timeoutMs = timeoutMs;
		this.sequence = 0;
		this.pending = new Map();
		this.closed = false;
		this.socketClosed = new Promise((resolve) => {
			this.resolveSocketClosed = resolve;
		});
		socket.addEventListener("message", (event) => {
			try {
				const message = JSON.parse(String(event.data));
				if (message.id) {
					const pending = this.pending.get(message.id);
					if (!pending) return;
					this.pending.delete(message.id);
					clearTimeout(pending.timer);
					if (message.error)
						pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
					else pending.resolve(message.result ?? {});
				} else if (message.method) {
					void Promise.resolve(this.onProtocol(message)).catch((error) => this.onFailure(error));
				}
			} catch (error) {
				void this.onFailure(error);
			}
		});
		socket.addEventListener("close", () => {
			this.resolveSocketClosed();
			if (!this.closed)
				void this.onFailure(new Error("Owned browser CDP socket closed unexpectedly."));
			this.close();
		});
		socket.addEventListener("error", () => {
			if (!this.closed) void this.onFailure(new Error("Owned browser CDP socket error."));
		});
	}
	send(method, params = {}, sessionId) {
		if (this.closed) return Promise.reject(new Error("Response guard CDP is closed."));
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(`CDP timeout: ${method}`);
				reject(error);
				void this.onFailure(error);
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			try {
				this.socket.send(
					JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
				);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
				void this.onFailure(error);
			}
		});
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Response guard closed."));
		}
		this.pending.clear();
		this.socket.close();
	}
}

export async function installBlogAdResponseGuard({
	browser,
	page,
	onResponse,
	onEvent,
	onTrace = () => {},
	onFailure = () => {},
	destroyOwnedBrowser,
	guardedOrigins,
	beforeTargetConfigure,
	timeoutMs = 5000,
}) {
	if (typeof destroyOwnedBrowser !== "function")
		throw new Error(
			"Provide destruction of the fresh owned browser process, not a client disconnect.",
		);
	if (page.context().browser() !== browser || page.url() !== "about:blank")
		throw new Error(
			"Install the guard on a blank page in the fresh owned browser before navigation.",
		);
	if (!onResponse || timeoutMs < 100 || timeoutMs > 10_000)
		throw new Error("Provide an explicit response policy and bounded command timeout.");
	if (
		!Array.isArray(guardedOrigins) ||
		!guardedOrigins.length ||
		new Set(guardedOrigins).size !== guardedOrigins.length
	)
		throw new Error("Provide unique exact guarded origins.");
	for (const origin of guardedOrigins) {
		const url = new URL(origin);
		if (
			url.origin !== origin ||
			url.username ||
			url.password ||
			!["http:", "https:"].includes(url.protocol)
		)
			throw new Error("Only exact HTTP(S) origins are supported.");
	}
	const parentSession = await page.context().newCDPSession(page);
	const { targetInfo: parentInfo } = await parentSession.send("Target.getTargetInfo");
	await parentSession.detach();
	const endpoint = await ownedBrowserDebuggerUrl(browser);
	const socket = new WebSocket(endpoint);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error("Browser CDP connect timeout."));
		}, timeoutMs);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				reject(new Error("Browser CDP connect failed."));
			},
			{ once: true },
		);
	});
	let stopped = false;
	let closing = false;
	let cdp;
	const targets = new Map();
	const sessions = new Map();
	let rootResolve;
	let rootReject;
	let stopResolve;
	const stopComplete = new Promise((resolve) => {
		stopResolve = resolve;
	});
	const rootReady = new Promise((resolve, reject) => {
		rootResolve = resolve;
		rootReject = reject;
	});
	void rootReady.catch(() => {});
	let destructionPromise;
	const destroy = () =>
		(destructionPromise ??= (async () => {
			// A connected Playwright Browser.close can merely disconnect. Caller
			// must close its own BrowserServer (or its directly launched Browser).
			await bounded(destroyOwnedBrowser, "Owned browser process destruction", timeoutMs);
			await bounded(() => cdp.socketClosed, "Owned browser debugger closure", timeoutMs);
			cdp.close(); // Never detach interception from a still-running process.
		})());
	const fail = async (error) => {
		if (stopped || closing) return;
		stopped = true;
		rootReject(error);
		// Start destroying the owned browser before a user callback can delay it.
		const destruction = destroy();
		try {
			void Promise.resolve(
				onFailure({
					reason: error instanceof Error ? error.message : "Unknown response guard failure.",
				}),
			).catch(() => {});
		} catch {}
		try {
			await destruction;
			stopResolve();
		} catch (destructionError) {
			// Keep all interception/target waits attached if destruction failed.
			try {
				void Promise.resolve(onFailure({ reason: destructionError.message })).catch(() => {});
			} catch {}
		}
	};
	const trace = (meta, phase, extra = {}) =>
		onTrace({
			owner: meta.owner,
			targetId: meta.targetId,
			sessionId: meta.sessionId,
			type: meta.type,
			phase,
			...extra,
		});
	const configure = async (params) => {
		const info = params.targetInfo;
		const owner = info.targetId === parentInfo.targetId ? "parent" : "child";
		const meta = { owner, targetId: info.targetId, sessionId: params.sessionId, type: info.type };
		if (
			(owner === "parent" && info.type !== "page") ||
			(owner === "child" && info.type !== "iframe")
		)
			throw new Error(`Unknown related target type: ${info.type}`);
		if (info.browserContextId && info.browserContextId !== parentInfo.browserContextId)
			throw new Error("A related target left the owned browser context.");
		if (owner === "child" && !params.waitingForDebugger)
			throw new Error("New child target was not paused before guard installation.");
		trace(meta, "attached", { waitingForDebugger: params.waitingForDebugger });
		const existing = targets.get(info.targetId);
		if (existing) {
			throw new Error("Duplicate target attachment has unproven guard ownership.");
		}
		targets.set(info.targetId, meta);
		sessions.set(params.sessionId, meta);
		await bounded(
			() => beforeTargetConfigure?.({ ...meta, waitingForDebugger: params.waitingForDebugger }),
			"Target configuration hook",
			timeoutMs,
		);
		if (stopped || closing) return;
		await cdp.send(
			"Target.setAutoAttach",
			{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			params.sessionId,
		);
		trace(meta, "recursive-auto-attach-ack");
		await cdp.send("Runtime.enable", {}, params.sessionId);
		await cdp.send("Network.enable", {}, params.sessionId);
		await cdp.send("Audits.enable", {}, params.sessionId);
		await cdp.send(
			"Fetch.enable",
			{
				patterns: guardedOrigins.map((origin) => ({
					urlPattern: `${origin}/*`,
					requestStage: "Response",
				})),
			},
			params.sessionId,
		);
		trace(meta, "fetch-response-enable-ack");
		if (stopped || closing) return;
		await cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
		trace(meta, "runtime-resume-ack");
		if (owner === "parent") rootResolve();
	};
	cdp = new PublicBrowserCdp(
		socket,
		async ({ method, params, sessionId }) => {
			if (stopped || closing) return;
			if (method === "Target.attachedToTarget") {
				await configure(params);
				return;
			}
			if (method === "Target.detachedFromTarget") {
				const detached = sessions.get(params.sessionId);
				if (detached) {
					trace(detached, "detached");
					sessions.delete(params.sessionId);
					targets.delete(detached.targetId);
					if (detached.owner === "parent")
						throw new Error("Parent response guard session detached.");
				}
				return;
			}
			const meta = sessions.get(sessionId);
			if (!meta) {
				if (method === "Fetch.requestPaused")
					throw new Error("Response from an unknown guarded session.");
				return;
			}
			const send = (name, data) => {
				if (stopped || closing)
					return Promise.reject(
						new Error("Response guard is stopping; no further commands allowed."),
					);
				return cdp.send(name, data, sessionId);
			};
			if (method === "Fetch.requestPaused") {
				trace(meta, "response-paused", {
					status: params.responseStatusCode,
					resourceType: params.resourceType,
				});
				let policyTimer;
				const policyTimeout = new Promise((_, reject) => {
					policyTimer = setTimeout(() => reject(new Error("Response policy timeout.")), timeoutMs);
				});
				let decision;
				try {
					decision = await Promise.race([
						onResponse({ ...meta, event: params, send }),
						policyTimeout,
					]);
				} finally {
					clearTimeout(policyTimer);
				}
				if (stopped || closing) return;
				if (typeof params.responseStatusCode !== "number")
					throw new Error("Missing HTTP response status at Response interception.");
				if (
					decision !== "continue" ||
					(params.responseStatusCode >= 300 && params.responseStatusCode < 400)
				) {
					await send("Fetch.failRequest", {
						requestId: params.requestId,
						errorReason: "BlockedByClient",
					});
					trace(meta, "response-fail-ack", { status: params.responseStatusCode });
					await fail(new Error("Response rejected before browser follow/execute."));
				} else {
					await send("Fetch.continueResponse", { requestId: params.requestId });
					trace(meta, "response-continue-ack", { status: params.responseStatusCode });
				}
			} else
				await bounded(
					() => onEvent?.({ ...meta, method, params, send }),
					"Event observer",
					timeoutMs,
				);
		},
		fail,
		timeoutMs,
	);
	try {
		// Attach this already blank root once, then recursively pause all new
		// children in its own Target handler before any app navigation starts.
		// Mixing Browser autoAttachRelated with recursive setAutoAttach creates
		// competing duplicate debugger waits; this tree has one owning session.
		await cdp.send("Target.attachToTarget", {
			targetId: parentInfo.targetId,
			flatten: true,
		});
		let rootTimer;
		try {
			await Promise.race([
				rootReady,
				new Promise((_, reject) => {
					rootTimer = setTimeout(
						() => reject(new Error("Root guard installation timeout.")),
						timeoutMs,
					);
				}),
			]);
		} finally {
			clearTimeout(rootTimer);
		}
		if (stopped) throw new Error("Response guard stopped during installation.");
		return {
			parentTargetId: parentInfo.targetId,
			waitForStop: () => stopComplete,
			get stopped() {
				return stopped;
			},
			async close() {
				closing = true;
				await destroy();
				stopResolve();
			},
		};
	} catch (error) {
		await fail(error);
		throw error;
	}
}

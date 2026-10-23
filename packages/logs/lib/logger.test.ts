import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withLogContext } from "./context";
import { logger } from "./logger";

const originalLevel = logger.level;
beforeEach(() => {
	logger.level = 3;
});
afterEach(() => {
	logger.level = originalLevel;
	vi.restoreAllMocks();
});

describe("structured media timing logs", () => {
	it("preserves method interception and the existing event/fields call contract", () => {
		const write = vi.spyOn(console, "info").mockImplementation(() => {});
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		logger.info("media.flow.timing", { stage: "intercepted", stageMs: 5 });
		expect(info).toHaveBeenCalledWith("media.flow.timing", { stage: "intercepted", stageMs: 5 });
		expect(write).not.toHaveBeenCalled();
	});

	it("retains pause and resume semantics before writing the structured record", () => {
		const write = vi.spyOn(console, "info").mockImplementation(() => {});
		logger.pauseLogs();
		try {
			logger.info("media.flow.timing", { stage: "paused", stageMs: 6 });
			expect(write).not.toHaveBeenCalled();
		} finally {
			logger.resumeLogs();
		}
		expect(write).toHaveBeenCalledOnce();
		expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({ stage: "paused" });
	});

	it("respects the configured info log level", () => {
		const write = vi.spyOn(console, "info").mockImplementation(() => {});
		const level = logger.level;
		try {
			logger.level = 0;
			logger.info("media.flow.timing", { stage: "status.query" });
			expect(write).not.toHaveBeenCalled();
		} finally {
			logger.level = level;
		}
	});

	it("writes one parseable line with correlation without expanding fields into pretty output", () => {
		const write = vi.spyOn(console, "info").mockImplementation(() => {});
		withLogContext({ requestId: "request-1", deploymentVersion: "release-1" }, () => {
			logger.info("media.flow.timing", { stage: "status.query", stageMs: 12, outcome: "ok" });
		});
		expect(write).toHaveBeenCalledTimes(1);
		const [line, ...extra] = write.mock.calls[0]!;
		expect(extra).toEqual([]);
		expect(typeof line).toBe("string");
		expect(line).not.toContain("\n");
		expect(JSON.parse(line as string)).toEqual({
			message: "media.flow.timing",
			stage: "status.query",
			stageMs: 12,
			outcome: "ok",
			context: { requestId: "request-1", deploymentVersion: "release-1" },
		});
	});

	it("keeps redaction and serializable diagnostics without mutating the input", () => {
		const write = vi.spyOn(console, "info").mockImplementation(() => {});
		const fields: Record<string, unknown> = {
			stage: "request.identity",
			prompt: "private prompt",
			token: "private token",
			url: "https://private.test/image.png?token=private",
			count: 1n,
		};
		fields.self = fields;
		logger.info("media.flow.timing", fields);
		const line = write.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			message: "media.flow.timing",
			prompt: "[REDACTED]",
			token: "[REDACTED]",
			url: "[REDACTED_URL]",
			count: "1",
			self: "[Circular]",
		});
		expect(line).not.toContain("private");
		expect(fields.prompt).toBe("private prompt");
		expect(fields.self).toBe(fields);
	});
});

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { parseMediaEnabledProviders } from "../../packages/config/env";
import {
	packEzPicImageModelFlags,
	parseEzPicImageModelFlags,
} from "../../packages/config/production-launch";
import {
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_TEMPLATE_VERSION,
	resolveVideoEffectPrice,
} from "../../packages/config/video-effects.server";
import {
	isVideoModelOptionAllowed,
	readVideoModelAccess,
} from "../../packages/config/video-model-access";
import {
	expandVideoRuntimeEnvironment,
	HOTEL_LOBBY_RUNTIME_OVERRIDE_KEYS,
	packVideoRuntimeEnvironment,
	parseHotelLobbyRuntimeOverride,
} from "../../packages/config/video-runtime-environment";
import { VIDEO_TEXT_SAFETY_RULE_VERSION } from "../../packages/config/video-text-safety";

export const HOTEL_LOBBY_PRICE_SOURCE = "docs/operations/hotel-lobby-pricing-2026-10-05.md";
export const DEFAULT_HOTEL_LOBBY_OUTPUT = ".wrangler/hotel-lobby/prepared/.env.local";
export const DEFAULT_HOTEL_LOBBY_OVERLAY_OUTPUT =
	".wrangler/hotel-lobby/prepared/build-overlay.env";
const maximumApprovalExpiry = "2026-10-12T00:00:00.000Z";
const selection = {
	productKey: "video-seedance-1-5-pro",
	mode: "image-to-video" as const,
	duration: 5,
	resolution: "720p",
	sound: false,
};
const minimumGroup = {
	productKey: selection.productKey,
	modes: [selection.mode],
	durations: [selection.duration],
	resolutions: [selection.resolution],
	sounds: [selection.sound],
};

function expiry(environment: Record<string, string>): string {
	const values = [
		maximumApprovalExpiry,
		environment.VIDEO_PRICE_VALID_UNTIL,
		environment.HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL?.trim() || undefined,
	].filter((value) => value !== undefined);
	const times = values.map((value) => Date.parse(value));
	if (times.some((value) => !Number.isFinite(value)))
		throw new Error("HOTEL_LOBBY_PREPARATION_EXPIRY_INVALID");
	return new Date(Math.min(...times)).toISOString();
}

/** Offline budget preparation only: no account, provider, database or deployment access. */
export function prepareHotelLobbyEnvironment(input: Record<string, string>) {
	const previous = expandVideoRuntimeEnvironment(input);
	const environment: Record<string, string> = { ...previous };
	delete environment.VIDEO_RUNTIME_CONFIG;
	const access = readVideoModelAccess(environment);
	if (environment.VIDEO_MODEL_ALLOWED_OPTIONS !== undefined && !access.ready)
		throw new Error("HOTEL_LOBBY_PREPARATION_ALLOWLIST_INVALID");
	if (!isVideoModelOptionAllowed(access, selection)) {
		// Add one independent group; merging dimensions would grant unintended combinations.
		const groups: unknown[] = environment.VIDEO_MODEL_ALLOWED_OPTIONS
			? JSON.parse(environment.VIDEO_MODEL_ALLOWED_OPTIONS)
			: [];
		environment.VIDEO_MODEL_ALLOWED_OPTIONS = JSON.stringify([...groups, minimumGroup]);
	}
	if (!readVideoModelAccess(environment).ready)
		throw new Error("HOTEL_LOBBY_PREPARATION_ALLOWLIST_INVALID");

	// Validate existing packed/flat image flags before updating only the selected product.
	packEzPicImageModelFlags(environment);
	if (environment.MEDIA_IMAGE_MODEL_FLAGS !== undefined) {
		const flags = parseEzPicImageModelFlags(environment.MEDIA_IMAGE_MODEL_FLAGS);
		environment.MEDIA_IMAGE_MODEL_FLAGS = JSON.stringify({
			...flags,
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
		});
		if (environment.MEDIA_NANO_BANANA_2_LITE_ENABLED !== undefined)
			environment.MEDIA_NANO_BANANA_2_LITE_ENABLED = "true";
	} else environment.MEDIA_NANO_BANANA_2_LITE_ENABLED = "true";
	const providers = parseMediaEnabledProviders({
		MEDIA_ENABLED_PROVIDERS:
			environment.MEDIA_ENABLED_PROVIDERS ??
			(environment.MEDIA_PROVIDER_ADAPTER === "mock" ? "" : environment.MEDIA_PROVIDER_ADAPTER),
	});
	if (!providers.includes("kie"))
		environment.MEDIA_ENABLED_PROVIDERS = [...providers, "kie"].join(",");

	Object.assign(environment, {
		HOTEL_LOBBY_DUO_ENABLED: "false",
		HOTEL_LOBBY_DUO_BUILD_ENABLED: "false",
		HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
		HOTEL_LOBBY_DUO_PRICE_BASIS: `Conservative budget, not invoice; ${HOTEL_LOBBY_PRICE_SOURCE}`,
		HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: expiry(environment),
		HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "20000",
		HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: "750",
		HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: `7.5% revenue allowance; budget, not invoice; ${HOTEL_LOBBY_PRICE_SOURCE}`,
		HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
		HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: VIDEO_TEXT_SAFETY_RULE_VERSION,
		HOTEL_LOBBY_DUO_TEXT_COST_BASIS: `Two text reviews budgeted at zero; budget, not invoice; ${HOTEL_LOBBY_PRICE_SOURCE}`,
		HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
		HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
		HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
		HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
		HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
		HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
	});
	const packed = packVideoRuntimeEnvironment(environment);
	// This temporary copy evaluates arithmetic only. Never persist quality acceptance or enablement.
	const quote = resolveVideoEffectPrice(
		{
			effectId: "hotel-lobby-duo",
			presetKey: "standard",
			inputs: { leftAssetId: "offline-left", rightAssetId: "offline-right" },
		},
		{
			...environment,
			HOTEL_LOBBY_DUO_ENABLED: "true",
			HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
		},
	);
	return {
		environment: packed,
		summary: {
			status: "PREPARED_CLOSED" as const,
			priceSource: HOTEL_LOBBY_PRICE_SOURCE,
			costEvidence: "BUDGET_NOT_INVOICE" as const,
			pricingVersion: quote.pricingVersion,
			credits: quote.credits.toString(),
			referenceCredits: "69",
			matchesReferenceBudget: quote.credits === 69n,
			validUntil: quote.pricingDetails.validUntil,
			providerCostMicros: quote.providerCostMicros.toString(),
			completeCostMicros: quote.pricingDetails.completeCostMicros,
			minimumGrossRevenueMicros: quote.pricingDetails.minimumGrossRevenueMicros,
			profitMicros: quote.pricingDetails.profitMicros,
			profitToCostBps: quote.pricingDetails.markupBps,
			paymentFeeBps: quote.pricingDetails.costPolicy.paymentFeeBps,
			packedBytes: Buffer.byteLength(packed.VIDEO_RUNTIME_CONFIG, "utf8"),
			changedKeys: Object.keys(environment)
				.filter((key) => environment[key] !== previous[key as keyof typeof previous])
				.sort(),
			acceptedTemplateVersionPreserved: true,
			templateEnabled: false,
			buildEnabled: false,
			modelAccountPermission: "NOT_VERIFIED" as const,
			qualityAcceptance: "NOT_RUN" as const,
			production: "NOT_RUN" as const,
		},
	};
}

/** Only the template patch leaves this path; the build runner supplies its current private base. */
export function prepareHotelLobbyBuildOverlay(
	input: Record<string, string>,
	access: "internal" | "authenticated" = "internal",
) {
	const prepared = prepareHotelLobbyEnvironment(input);
	const expanded = expandVideoRuntimeEnvironment(prepared.environment);
	const patch = Object.fromEntries(
		HOTEL_LOBBY_RUNTIME_OVERRIDE_KEYS.filter((key) => expanded[key]?.trim()).map((key) => [
			key,
			expanded[key],
		]),
	);
	patch.HOTEL_LOBBY_DUO_ACCESS = access;
	const encoded = JSON.stringify(parseHotelLobbyRuntimeOverride(JSON.stringify(patch)));
	return {
		environment: {
			HOTEL_LOBBY_DUO_RUNTIME_CONFIG: encoded,
			HOTEL_LOBBY_DUO_BUILD_ENABLED: "false",
		},
		summary: {
			...prepared.summary,
			status: "BUILD_OVERLAY_PREPARED_CLOSED" as const,
			packedBytes: Buffer.byteLength(encoded, "utf8"),
			changedKeys: Object.keys(patch).sort(),
			access,
			existingBaseRequired: true,
			includesBaseSnapshot: false,
			addsOnlyDefaultVideoTuple: true,
			sceneModelConfiguration: "UNCHANGED_BY_BUILD_OVERLAY" as const,
		},
	};
}

/** Fail closed if a dotenv value cannot be round-tripped without changing its bytes. */
export function serializePrivateEnvironment(environment: Record<string, string>): string {
	const lines = Object.entries(environment).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			throw new Error("HOTEL_LOBBY_PREPARATION_DOTENV_INVALID");
		const delimiter = ["'", '"', "`"].find(
			(quote) => !value.includes(quote) && (quote !== '"' || !/\\[nr]/.test(value)),
		);
		if (!delimiter) throw new Error("HOTEL_LOBBY_PREPARATION_DOTENV_UNREPRESENTABLE");
		return `${key}=${delimiter}${value}${delimiter}`;
	});
	const source = `${lines.join("\n")}\n`;
	const parsed = parseEnv(source);
	if (
		Object.keys(parsed).length !== Object.keys(environment).length ||
		Object.entries(environment).some(([key, value]) => parsed[key] !== value)
	)
		throw new Error("HOTEL_LOBBY_PREPARATION_DOTENV_ROUNDTRIP_FAILED");
	return source;
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative !== "" &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}

export async function prepareHotelLobbyConfig(options: {
	inputPath: string;
	outputPath?: string;
	repositoryRoot?: string;
	buildOverlay?: boolean;
	access?: "internal" | "authenticated";
}) {
	const directory = path.resolve(options.repositoryRoot ?? process.cwd());
	const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: directory,
		encoding: "utf8",
	});
	if (gitRoot.status !== 0) throw new Error("HOTEL_LOBBY_PREPARATION_REPOSITORY_REQUIRED");
	const root = realpathSync(gitRoot.stdout.trim());
	const inputPath = realpathSync(path.resolve(directory, options.inputPath));
	const outputPath = path.resolve(
		root,
		options.outputPath ??
			(options.buildOverlay ? DEFAULT_HOTEL_LOBBY_OVERLAY_OUTPUT : DEFAULT_HOTEL_LOBBY_OUTPUT),
	);
	if (inputPath === outputPath || existsSync(outputPath))
		throw new Error("HOTEL_LOBBY_PREPARATION_OVERWRITE_REFUSED");
	let ancestor = path.dirname(outputPath);
	while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
	const physicalOutput = path.resolve(realpathSync(ancestor), path.relative(ancestor, outputPath));
	if (!within(root, outputPath) || !within(root, physicalOutput))
		throw new Error("HOTEL_LOBBY_PREPARATION_OUTPUT_OUTSIDE_REPOSITORY");
	const relativeOutput = path.relative(root, outputPath);
	const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", relativeOutput], {
		cwd: root,
	});
	const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativeOutput], {
		cwd: root,
	});
	if (ignored.status !== 0 || tracked.status !== 1)
		throw new Error("HOTEL_LOBBY_PREPARATION_OUTPUT_MUST_BE_PRIVATE");
	const input = Object.fromEntries(
		Object.entries(parseEnv(await readFile(inputPath, "utf8"))).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	if (!Object.keys(input).length) throw new Error("HOTEL_LOBBY_PREPARATION_INPUT_EMPTY");
	if (options.access !== undefined && !options.buildOverlay)
		throw new Error("HOTEL_LOBBY_PREPARATION_ACCESS_REQUIRES_OVERLAY");
	const prepared = options.buildOverlay
		? prepareHotelLobbyBuildOverlay(input, options.access)
		: prepareHotelLobbyEnvironment(input);
	const source = serializePrivateEnvironment(prepared.environment);
	await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
	await writeFile(outputPath, source, { flag: "wx", mode: 0o600 });
	return { outputPath, ...prepared.summary };
}

async function main(args: string[]) {
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(
			"Usage: pnpm hotel-lobby:prepare-config --input <private-dotenv> [--output <new-ignored-path>] [--build-overlay --access internal|authenticated]\nOffline preparation only; no deploy, generation, quality acceptance or account permission probe.\nBuild overlays contain no base policy or funding and require the build runner's existing VIDEO_RUNTIME_CONFIG.\n",
		);
		return;
	}
	const options: Parameters<typeof prepareHotelLobbyConfig>[0] = { inputPath: "" };
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (seen.has(flag)) throw new Error("HOTEL_LOBBY_PREPARATION_ARGUMENTS_INVALID");
		seen.add(flag);
		if (flag === "--build-overlay") {
			options.buildOverlay = true;
			continue;
		}
		const value = args[++index];
		if (!["--input", "--output", "--access"].includes(flag) || !value)
			throw new Error("HOTEL_LOBBY_PREPARATION_ARGUMENTS_INVALID");
		if (flag === "--input") options.inputPath = value;
		else if (flag === "--output") options.outputPath = value;
		else {
			if (value !== "internal" && value !== "authenticated")
				throw new Error("HOTEL_LOBBY_PREPARATION_ACCESS_INVALID");
			options.access = value;
		}
	}
	if (!options.inputPath) throw new Error("HOTEL_LOBBY_PREPARATION_INPUT_REQUIRED");
	process.stdout.write(`${JSON.stringify(await prepareHotelLobbyConfig(options), null, 2)}\n`);
}

if (/(?:^|[\\/])prepare-hotel-lobby-config\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	void main(process.argv.slice(2)).catch((error: unknown) => {
		// Never print raw input, supplier credentials, policy JSON, stack traces or arbitrary errors.
		const message = error instanceof Error ? error.message : "";
		process.stderr.write(
			`${/^(?:HOTEL_LOBBY|VIDEO)_[A-Z0-9_]+$/.test(message) ? message : "HOTEL_LOBBY_PREPARATION_FAILED"}\n`,
		);
		process.exitCode = 1;
	});
}

import { mkdirSync, writeFileSync } from "node:fs";

import {
	calculateVideoRetailPrice,
	videoSupplierCostMicros,
	type VideoCostPolicy,
	type VideoPricingSelection,
} from "../../packages/config/video-pricing.server";

// Scenario only: no environment credentials or production pricing are loaded.
const policy: VideoCostPolicy = {
	moderationBaseMicros: 10_000n,
	moderationPerSecondMicros: 5000n,
	audioModerationPerSecondMicros: 2000n,
	runtimeMicros: 5000n,
	storageMicros: 5000n,
	paymentFixedAllocationMicros: 2000n,
	paymentFeeBps: 500n,
	nonBillableFailureBps: 1000n,
	markupBps: 11_000n,
};
const examples: VideoPricingSelection[] = [
	{
		productKey: "video-seedance-1-pro-fast",
		mode: "image-to-video",
		duration: 5,
		resolution: "720p",
		sound: false,
	},
	{
		productKey: "video-seedance-1-5-pro",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: false,
	},
	{
		productKey: "video-seedance-1-5-pro",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-seedance-2-mini",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-minimax-h3",
		mode: "text-to-video",
		duration: 5,
		resolution: "768p",
		sound: true,
	},
	{
		productKey: "video-kling-2-6-v1",
		mode: "text-to-video",
		duration: 5,
		resolution: "default",
		sound: false,
	},
	{
		productKey: "video-kling-2-6-v1",
		mode: "text-to-video",
		duration: 5,
		resolution: "default",
		sound: true,
	},
	{
		productKey: "video-kling-3",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: false,
	},
	{
		productKey: "video-kling-3-turbo",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-gemini-omni-flash",
		mode: "text-to-video",
		duration: 4,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-seedance-2-fast",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-seedance-2",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
	{
		productKey: "video-seedance-2-5",
		mode: "text-to-video",
		duration: 5,
		resolution: "720p",
		sound: true,
	},
];
const rows = examples.map((input) => {
	const providerCostMicros = videoSupplierCostMicros(input);
	return {
		...input,
		providerCostMicros,
		...calculateVideoRetailPrice({
			providerCostMicros,
			duration: input.duration,
			sound: input.sound,
			policy,
		}),
	};
});
const directory = "docs/operations/evidence/video-pricing";
mkdirSync(directory, { recursive: true });
const report = {
	generatedAt: new Date().toISOString(),
	status: "HYPOTHETICAL_COST_POLICY_NOT_PRODUCTION",
	source: "https://kie.ai/pricing",
	policy,
	rows,
};
writeFileSync(
	`${directory}/pricing-scenario.json`,
	JSON.stringify(report, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2) +
		"\n",
);
console.table(
	rows.map((row) => ({
		model: row.productKey,
		seconds: row.duration,
		sound: row.sound,
		supplierUSD: Number(row.providerCostMicros) / 1e6,
		credits: Number(row.credits),
		minimumRetailUSD: Number(row.minimumGrossRevenueMicros) / 1e6,
		costUSD: Number(row.completeCostMicros) / 1e6,
		markupPercent: Number(row.markupBps) / 100,
	})),
);

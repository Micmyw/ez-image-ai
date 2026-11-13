import { cachedDays, loadRange } from "./collect.mjs";
import { assertDate, integer, pacificDate, shiftDate, validateType } from "./config.mjs";

export function aggregate(rows) {
	const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
	const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
	return {
		clicks,
		impressions,
		ctr: impressions ? clicks / impressions : 0,
		position: impressions
			? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions
			: null,
	};
}

export function groupRows(rows) {
	const groups = new Map();
	for (const row of rows) {
		const key = JSON.stringify(row.keys ?? []);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(row);
	}
	return [...groups.values()].map((group) => ({ keys: group[0].keys ?? [], ...aggregate(group) }));
}

export function isBrand(query, terms) {
	return terms.some((term) => query.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
}

function compare(current, previous) {
	return {
		current,
		previous,
		clicksChange: current.clicks - previous.clicks,
		clicksChangePercent: previous.clicks ? (current.clicks / previous.clicks - 1) * 100 : null,
		impressionsChange: current.impressions - previous.impressions,
		ctrChangePoints: (current.ctr - previous.ctr) * 100,
		positionChange:
			current.position !== null && previous.position !== null
				? current.position - previous.position
				: null,
	};
}

export function analyze(
	currentDays,
	previousDays,
	{
		brandTerms = [],
		minImpressions = 100,
		limit = 20,
		nonBrand = true,
		comparisonComplete = true,
	} = {},
) {
	const currentRows = groupRows(currentDays.flatMap((day) => day.queries.rows));
	const filtered = currentRows.filter((row) => !nonBrand || !isBrand(row.keys[0], brandTerms));
	const opportunities = filtered
		.filter((row) => row.impressions >= minImpressions && row.position >= 4 && row.position <= 20)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, limit);
	// Descriptive screen, not an expected-CTR model: inspect country/device/intent before editing.
	const lowCtr = filtered
		.filter((row) => row.impressions >= minImpressions && row.position <= 10 && row.ctr < 0.02)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, limit);
	const currentPages = new Map(
		groupRows(currentDays.flatMap((day) => day.pages.rows)).map((row) => [row.keys[0], row]),
	);
	const previousPages = new Map(
		groupRows(previousDays.flatMap((day) => day.pages.rows)).map((row) => [row.keys[0], row]),
	);
	const pageChanges = [...new Set([...currentPages.keys(), ...previousPages.keys()])].map(
		(page) => ({
			page,
			...compare(currentPages.get(page) ?? aggregate([]), previousPages.get(page) ?? aggregate([])),
			observedCurrent: currentPages.has(page),
			observedPrevious: previousPages.has(page),
		}),
	);
	const byQuery = new Map();
	for (const row of filtered) {
		if (!byQuery.has(row.keys[0])) byQuery.set(row.keys[0], []);
		byQuery.get(row.keys[0]).push(row);
	}
	const overlap = [...byQuery.entries()]
		.map(([query, rows]) => {
			const total = rows.reduce((sum, row) => sum + row.impressions, 0);
			return {
				query,
				observedPageImpressions: total,
				pages: rows
					.filter((row) => row.impressions >= 20 && row.impressions / total >= 0.2)
					.map((row) => ({ page: row.keys[1], ...row })),
			};
		})
		.filter((row) => row.pages.length > 1 && row.observedPageImpressions >= minImpressions)
		.sort((a, b) => b.observedPageImpressions - a.observedPageImpressions)
		.slice(0, limit);
	return {
		totals: comparisonComplete
			? compare(
					aggregate(currentDays.flatMap((day) => day.totals.rows)),
					aggregate(previousDays.flatMap((day) => day.totals.rows)),
				)
			: {
					current: aggregate(currentDays.flatMap((day) => day.totals.rows)),
					previous: aggregate(previousDays.flatMap((day) => day.totals.rows)),
					comparisonSuppressed: true,
				},
		opportunities,
		lowCtr,
		overlap,
		pageDeclines: comparisonComplete
			? pageChanges
					.filter((row) => row.previous.clicks >= 5 && row.clicksChange < 0)
					.sort((a, b) => a.clicksChange - b.clicksChange)
					.slice(0, limit)
			: [],
		pageGains: comparisonComplete
			? pageChanges
					.filter((row) => row.clicksChange > 0)
					.sort((a, b) => b.clicksChange - a.clicksChange)
					.slice(0, limit)
			: [],
		topQueries: filtered
			.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
			.slice(0, limit),
	};
}

export async function report(
	config,
	site,
	{ days = 28, end, type = "web", limit = 20, minImpressions = 100, nonBrand = true } = {},
) {
	integer(days, "days", 1, 90);
	integer(limit, "limit", 1, 100);
	integer(minImpressions, "minImpressions", 1, 10000000);
	validateType(type);
	const dates = await cachedDays(config, site, type);
	const endDate = end ? assertDate(end) : dates.at(-1);
	if (!endDate) throw new Error("No cached data. Run sync first.");
	const current = await loadRange(config, site, type, shiftDate(endDate, -(days - 1)), endDate);
	const previous = await loadRange(
		config,
		site,
		type,
		shiftDate(endDate, -(2 * days - 1)),
		shiftDate(endDate, -days),
	);
	const complete = current.missingDates.length === 0 && previous.missingDates.length === 0;
	const warnings = [
		"Keyword/page rows are partial Google observations, not the complete query universe. Site totals are queried separately.",
		"Average position is impression-weighted, not a live fixed rank. CTR screens use mixed country/device data and need segmented validation.",
		"Opportunity thresholds are local heuristics, not Google ranking rules. Multiple pages for a query do not prove harmful cannibalization.",
		"Google reports dates in America/Los_Angeles. Finalized data can still differ from live site behavior. Keyword clicks do not establish conversions or revenue.",
	];
	if (!complete)
		warnings.push(
			"Missing daily cache files: period-over-period deltas and decline/gain lists are suppressed. Sync the full comparison range first.",
		);
	if (
		[...current.data, ...previous.data].some((day) => day.queries.hitRowCap || day.pages.hitRowCap)
	)
		warnings.push(
			"At least one collection reached the 50,000-row cap; keyword/page lists are truncated.",
		);
	if (endDate < shiftDate(pacificDate(), -7))
		warnings.push(
			"The report ends more than seven days ago; sync before treating this as current performance.",
		);
	return {
		property: site.property,
		type,
		generatedAt: new Date().toISOString(),
		timezone: "America/Los_Angeles",
		current: { start: current.start, end: current.end, missingDates: current.missingDates },
		previous: { start: previous.start, end: previous.end, missingDates: previous.missingDates },
		comparisonComplete: complete,
		filters: { nonBrand, brandTerms: site.brandTerms, minImpressions },
		warnings,
		...analyze(current.data, previous.data, {
			brandTerms: site.brandTerms,
			minImpressions,
			limit,
			nonBrand,
			comparisonComplete: complete,
		}),
	};
}

export async function queryCache(
	config,
	site,
	{ start, end, type = "web", query, page, limit = 50, nonBrand = false } = {},
) {
	integer(limit, "limit", 1, 200);
	const range = await loadRange(config, site, type, start, end);
	const rows = groupRows(range.data.flatMap((day) => day.queries.rows))
		.filter(
			(row) =>
				(!query || row.keys[0].toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
				(!page || row.keys[1] === page) &&
				(!nonBrand || !isBrand(row.keys[0], site.brandTerms)),
		)
		.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
	return {
		property: site.property,
		type,
		start,
		end,
		missingDates: range.missingDates,
		matchedRows: rows.length,
		rows: rows.slice(0, limit),
		warning:
			"Local cached keyword/page observations only; not site totals. Query uses literal substring matching, page uses exact URL including locale query parameters.",
	};
}

const textCell = (value) => String(value ?? "").replace(/[\r\n|<>]/g, " ");
const number = (value) => (value === null || value === undefined ? "—" : Number(value).toFixed(2));
const percent = (value) => `${number(value * 100)}%`;

export function markdownReport(data) {
	const lines = [
		`# GSC SEO 报告：${data.property}`,
		"",
		`搜索类型：${data.type}；日期口径：${data.timezone}`,
		`当前：${data.current.start} — ${data.current.end}；对比：${data.previous.start} — ${data.previous.end}`,
		`生成时间：${data.generatedAt}`,
		"",
		`全站点击：${data.totals.current.clicks}；曝光：${data.totals.current.impressions}；CTR：${percent(data.totals.current.ctr)}；平均排名：${number(data.totals.current.position)}`,
		data.comparisonComplete
			? `点击变化：${data.totals.clicksChange}；曝光变化：${data.totals.impressionsChange}`
			: "数据日期不完整，已停止计算期间变化。",
		"",
	];
	for (const [title, rows] of [
		[`优先检查的${data.filters.nonBrand ? "非品牌" : ""}关键词（4–20 位）`, data.opportunities],
		["高曝光低 CTR 候选（前 10 位且 CTR < 2%）", data.lowCtr],
		["关键词明细", data.topQueries],
	]) {
		lines.push(
			`## ${title}`,
			"",
			"| 关键词 | 页面 | 点击 | 曝光 | CTR | 平均排名 |",
			"| --- | --- | ---: | ---: | ---: | ---: |",
		);
		for (const row of rows)
			lines.push(
				`| ${textCell(row.keys[0])} | ${textCell(row.keys[1])} | ${row.clicks} | ${row.impressions} | ${percent(row.ctr)} | ${number(row.position)} |`,
			);
		if (!rows.length) lines.push("| 当前筛选下没有候选 | | | | | |");
		lines.push("");
	}
	lines.push(
		"## 点击下降页面",
		"",
		"| 页面 | 当前点击 | 上期点击 | 点击变化 |",
		"| --- | ---: | ---: | ---: |",
	);
	for (const row of data.pageDeclines)
		lines.push(
			`| ${textCell(row.page)} | ${row.current.clicks} | ${row.previous.clicks} | ${row.clicksChange} |`,
		);
	lines.push("", "## 多页面关键词（待核实意图重叠）", "");
	for (const row of data.overlap)
		lines.push(
			`- ${textCell(row.query)}：${row.pages.map((item) => textCell(item.page)).join("、")}`,
		);
	lines.push("", "## 口径与限制", "", ...data.warnings.map((warning) => `- ${warning}`), "");
	return lines.join("\n");
}

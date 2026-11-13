import { mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	assertDate,
	integer,
	pacificDate,
	propertyKey,
	readJson,
	shiftDate,
	validateType,
	writeJson,
} from "./config.mjs";
import { queryAll } from "./google.mjs";

export const siteDir = (config, site, type) =>
	join(config.dataDir, propertyKey(site.property), validateType(type));
export const dayPath = (config, site, type, date) =>
	join(siteDir(config, site, type), `${assertDate(date)}.json`);

export async function cachedDays(config, site, type) {
	try {
		return (await readdir(siteDir(config, site, type)))
			.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
			.map((name) => name.slice(0, 10))
			.sort();
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

export async function syncSite(
	config,
	site,
	client,
	{ days = 56, end, type = "web", refreshDays = 7, progress = () => {} } = {},
) {
	integer(days, "days", 1, 180);
	integer(refreshDays, "refreshDays", 0, 30);
	validateType(type);
	const directory = siteDir(config, site, type);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lock = join(directory, "sync.lock");
	try {
		await mkdir(lock);
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				`A sync lock exists at ${lock}. Do not remove it until its owning process has exited.`,
			);
		throw error;
	}
	try {
		await writeFile(
			join(lock, "owner.json"),
			JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
			{ mode: 0o600 },
		);
		const today = pacificDate();
		const availability = await client.query(site.property, {
			startDate: shiftDate(today, -14),
			endDate: today,
			dimensions: ["date"],
			type,
			dataState: "final",
			rowLimit: 100,
		});
		const availableDates = (availability.rows ?? []).map((row) => assertDate(row.keys[0])).sort();
		const latestFinalDate = availableDates.at(-1);
		if (!latestFinalDate)
			throw new Error(
				"No finalized search data in the last 15 days. Check the property, access and search type; no empty history was created.",
			);
		const endDate = end ? assertDate(end) : latestFinalDate;
		if (endDate > latestFinalDate)
			throw new Error(
				`Requested end is newer than the latest observed finalized date (${latestFinalDate}).`,
			);
		const startDate = shiftDate(endDate, -(days - 1));
		let saved = 0;
		let skipped = 0;
		for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
			const path = dayPath(config, site, type, date);
			const existing = await readJson(path);
			if (
				existing?.version === 1 &&
				existing.property === site.property &&
				existing.type === type &&
				existing.date === date &&
				date < shiftDate(endDate, -(refreshDays - 1))
			) {
				skipped++;
				continue;
			}
			const base = { startDate: date, endDate: date, type, dataState: "final" };
			const totals = await queryAll(client, site.property, {
				...base,
				dimensions: [],
				aggregationType: "byProperty",
			});
			const pages = await queryAll(client, site.property, {
				...base,
				dimensions: ["page"],
				aggregationType: "auto",
			});
			const queries = await queryAll(client, site.property, {
				...base,
				dimensions: ["query", "page"],
				aggregationType: "auto",
			});
			const day = {
				version: 1,
				property: site.property,
				date,
				type,
				timezone: "America/Los_Angeles",
				dataState: "final",
				fetchedAt: new Date().toISOString(),
				latestObservedFinalDate: latestFinalDate,
				totals,
				pages,
				queries,
			};
			await writeJson(path, day);
			saved++;
			progress({
				date,
				queryRows: queries.rows.length,
				pageRows: pages.rows.length,
				hitRowCap: pages.hitRowCap || queries.hitRowCap,
			});
		}
		return {
			property: site.property,
			type,
			startDate,
			endDate,
			latestObservedFinalDate: latestFinalDate,
			saved,
			skipped,
			directory,
		};
	} finally {
		// Only this invocation's acquired lock is removed, never another process's lock.
		const { unlink } = await import("node:fs/promises");
		await unlink(join(lock, "owner.json")).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		await rmdir(lock);
	}
}

export async function loadRange(config, site, type, start, end) {
	assertDate(start);
	assertDate(end);
	validateType(type);
	if (start > end || start < shiftDate(end, -179))
		throw new Error("Cache range must span 1–180 days.");
	const data = [];
	const missingDates = [];
	for (let date = start; date <= end; date = shiftDate(date, 1)) {
		const day = await readJson(dayPath(config, site, type, date));
		if (!day) {
			missingDates.push(date);
			continue;
		}
		if (
			day.version !== 1 ||
			day.property !== site.property ||
			day.type !== type ||
			day.date !== date ||
			day.dataState !== "final"
		)
			throw new Error(`Cache identity mismatch on ${date}. Re-sync this date.`);
		data.push(day);
	}
	return { start, end, data, missingDates };
}

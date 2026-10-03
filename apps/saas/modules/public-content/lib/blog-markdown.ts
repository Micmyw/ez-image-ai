export type PublicMarkdownBlock =
	| { type: "heading"; level: 2 | 3; text: string; id: string }
	| { type: "paragraph"; text: string }
	| { type: "unordered-list" | "ordered-list"; items: string[] }
	| { type: "prompt" | "code"; text: string }
	| { type: "callout"; text: string }
	| { type: "table"; headings: string[]; rows: string[][] };

export type ContentHeading = Extract<PublicMarkdownBlock, { type: "heading" }>;

export function publicText(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.trim();
}

function headingId(text: string, used: Set<string>): string {
	const base =
		publicText(text)
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-|-$/g, "") || "section";
	let id = base;
	let suffix = 2;
	while (used.has(id)) id = `${base}-${suffix++}`;
	used.add(id);
	return id;
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
	return Boolean(
		lines[index]?.includes("|") &&
		/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? ""),
	);
}

export function parsePublicMarkdown(body: string): PublicMarkdownBlock[] {
	const lines = body.replaceAll("\r\n", "\n").trim().split("\n");
	const blocks: PublicMarkdownBlock[] = [];
	const usedIds = new Set<string>();
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]?.trim() ?? "";
		if (!line) {
			index++;
			continue;
		}
		const fence = /^```([a-z-]*)\s*$/.exec(line);
		if (fence) {
			const text: string[] = [];
			index++;
			while (index < lines.length && !/^```\s*$/.test(lines[index]?.trim() ?? ""))
				text.push(lines[index++]!);
			if (index < lines.length) index++;
			blocks.push({ type: fence[1] === "prompt" ? "prompt" : "code", text: text.join("\n") });
			continue;
		}
		const heading = /^(#{2,3})\s+(.+)$/.exec(line);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1]!.length === 2 ? 2 : 3,
				text: heading[2]!,
				id: headingId(heading[2]!, usedIds),
			});
			index++;
			continue;
		}
		if (isTableStart(lines, index)) {
			const headings = tableCells(line);
			const rows: string[][] = [];
			index += 2;
			while (index < lines.length && lines[index]?.trim().includes("|"))
				rows.push(tableCells(lines[index++]!).slice(0, headings.length));
			blocks.push({ type: "table", headings, rows });
			continue;
		}
		if (/^>\s?/.test(line)) {
			const text: string[] = [];
			while (index < lines.length && /^>\s?/.test(lines[index]?.trim() ?? ""))
				text.push(lines[index++]!.trim().replace(/^>\s?/, ""));
			blocks.push({ type: "callout", text: text.join(" ") });
			continue;
		}
		const listPattern = /^[-*]\s+/.test(line)
			? /^[-*]\s+(.+)$/
			: /^\d+\.\s+/.test(line)
				? /^\d+\.\s+(.+)$/
				: null;
		if (listPattern) {
			const items: string[] = [];
			while (index < lines.length) {
				const match = listPattern.exec(lines[index]?.trim() ?? "");
				if (!match) break;
				items.push(match[1]!);
				index++;
			}
			blocks.push({ type: /^[-*]/.test(line) ? "unordered-list" : "ordered-list", items });
			continue;
		}
		const paragraph: string[] = [];
		while (index < lines.length) {
			const current = lines[index]?.trim() ?? "";
			if (
				!current ||
				/^(#{2,3})\s+|^[-*]\s+|^\d+\.\s+|^```[a-z-]*\s*$|^>\s?/.test(current) ||
				isTableStart(lines, index)
			)
				break;
			paragraph.push(current);
			index++;
		}
		blocks.push({ type: "paragraph", text: paragraph.join(" ") });
	}
	return blocks;
}

export function getContentHeadings(body: string): ContentHeading[] {
	return parsePublicMarkdown(body).filter(
		(block): block is ContentHeading => block.type === "heading",
	);
}

export function getReadingMinutes(body: string): number {
	const text = parsePublicMarkdown(body)
		.map((block) => {
			if ("text" in block) return publicText(block.text);
			if ("items" in block) return block.items.map(publicText).join(" ");
			return [...block.headings, ...block.rows.flat()].map(publicText).join(" ");
		})
		.join(" ");
	const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
	return Math.max(1, Math.ceil(words / 200));
}

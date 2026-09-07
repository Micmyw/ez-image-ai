import type { ReactNode } from "react";

type ContentBlock =
	| { type: "heading"; level: 2 | 3; text: string }
	| { type: "paragraph"; text: string }
	| { type: "unordered-list"; items: string[] }
	| { type: "ordered-list"; items: string[] };

export function PublicMarkdown({ body }: { body: string }) {
	return (
		<div className="max-w-3xl text-slate-300 mx-auto">
			{parseBlocks(body).map((block, index) => {
				const key = `${block.type}-${index}`;
				if (block.type === "heading") {
					return block.level === 2 ? (
						<h2 key={key} className="mt-10 mb-4 text-2xl font-semibold text-white">
							{renderInline(block.text)}
						</h2>
					) : (
						<h3 key={key} className="mt-8 mb-3 text-xl font-semibold text-white">
							{renderInline(block.text)}
						</h3>
					);
				}
				if (block.type === "unordered-list") {
					return (
						<ul key={key} className="mb-5 space-y-2 pl-6 list-disc">
							{block.items.map((item, itemIndex) => (
								<li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
							))}
						</ul>
					);
				}
				if (block.type === "ordered-list") {
					return (
						<ol key={key} className="mb-5 space-y-2 pl-6 list-decimal">
							{block.items.map((item, itemIndex) => (
								<li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
							))}
						</ol>
					);
				}
				return (
					<p key={key} className="mb-5 leading-7">
						{renderInline(block.text)}
					</p>
				);
			})}
		</div>
	);
}

function parseBlocks(body: string): ContentBlock[] {
	const lines = body.replaceAll("\r\n", "\n").trim().split("\n");
	const blocks: ContentBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]?.trim() ?? "";
		if (!line) {
			index += 1;
			continue;
		}

		const heading = /^(#{2,3})\s+(.+)$/.exec(line);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1]!.length === 2 ? 2 : 3,
				text: heading[2]!,
			});
			index += 1;
			continue;
		}

		const unordered = collectList(lines, index, /^[-*]\s+(.+)$/);
		if (unordered) {
			blocks.push({ type: "unordered-list", items: unordered.items });
			index = unordered.nextIndex;
			continue;
		}

		const ordered = collectList(lines, index, /^\d+\.\s+(.+)$/);
		if (ordered) {
			blocks.push({ type: "ordered-list", items: ordered.items });
			index = ordered.nextIndex;
			continue;
		}

		const paragraph: string[] = [];
		while (index < lines.length) {
			const paragraphLine = lines[index]?.trim() ?? "";
			if (
				!paragraphLine ||
				/^(#{2,3})\s+/.test(paragraphLine) ||
				/^[-*]\s+/.test(paragraphLine) ||
				/^\d+\.\s+/.test(paragraphLine)
			) {
				break;
			}
			paragraph.push(paragraphLine);
			index += 1;
		}
		blocks.push({ type: "paragraph", text: paragraph.join(" ") });
	}

	return blocks;
}

function collectList(
	lines: string[],
	startIndex: number,
	pattern: RegExp,
): { items: string[]; nextIndex: number } | null {
	const items: string[] = [];
	let index = startIndex;
	while (index < lines.length) {
		const match = pattern.exec(lines[index]?.trim() ?? "");
		if (!match) break;
		items.push(match[1]!);
		index += 1;
	}
	return items.length ? { items, nextIndex: index } : null;
}

function renderInline(text: string): ReactNode[] {
	return text
		.split(/(`[^`]+`|\*\*[^*]+\*\*|_[^_]+_)/g)
		.filter(Boolean)
		.map((part, index) => {
			if (part.startsWith("`") && part.endsWith("`")) {
				return <code key={index}>{part.slice(1, -1)}</code>;
			}
			if (part.startsWith("**") && part.endsWith("**")) {
				return <strong key={index}>{part.slice(2, -2)}</strong>;
			}
			if (part.startsWith("_") && part.endsWith("_")) {
				return <em key={index}>{part.slice(1, -1)}</em>;
			}
			return part;
		});
}

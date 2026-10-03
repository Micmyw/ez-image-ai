import { Fragment, type ReactNode } from "react";

import { parsePublicMarkdown } from "../lib/blog-markdown";
import { PromptBlock } from "./PromptBlock";

export function PublicMarkdown({
	body,
	afterSections = {},
	renderPrompt,
	copyQuotedPrompts = false,
}: {
	body: string;
	afterSections?: Readonly<Record<string, ReactNode>>;
	renderPrompt?: (prompt: string, key: string) => ReactNode;
	copyQuotedPrompts?: boolean;
}) {
	const output: ReactNode[] = [];
	const sections: { id: string; level: number }[] = [];
	const closeSection = () => {
		const section = sections.pop();
		if (section && afterSections[section.id])
			output.push(<Fragment key={`after-${section.id}`}>{afterSections[section.id]}</Fragment>);
	};
	for (const [index, block] of parsePublicMarkdown(body).entries()) {
		const key = `${block.type}-${index}`;
		if (block.type === "heading") {
			while (sections.length && sections.at(-1)!.level >= block.level) closeSection();
			sections.push({ id: block.id, level: block.level });
			const Heading = block.level === 2 ? "h2" : "h3";
			output.push(
				<Heading
					id={block.id}
					key={key}
					className={
						block.level === 2
							? "mt-10 mb-4 scroll-mt-28 text-2xl font-semibold text-white"
							: "mt-8 mb-3 scroll-mt-28 text-xl font-semibold text-white"
					}
				>
					{renderInline(block.text)}
				</Heading>,
			);
		} else if (block.type === "unordered-list" || block.type === "ordered-list") {
			const List = block.type === "ordered-list" ? "ol" : "ul";
			output.push(
				<List
					key={key}
					className={`mb-5 space-y-2 pl-6 leading-7 ${block.type === "ordered-list" ? "list-decimal" : "list-disc"}`}
				>
					{block.items.map((item, itemIndex) => (
						<li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
					))}
				</List>,
			);
		} else if (block.type === "prompt") {
			output.push(
				renderPrompt ? (
					renderPrompt(block.text, key)
				) : (
					<PromptBlock key={key} prompt={block.text} />
				),
			);
		} else if (block.type === "code") {
			output.push(
				<pre
					key={key}
					className="mb-5 bg-white/5 p-4 text-sm leading-7 max-w-full rounded-xl [overflow-wrap:anywhere] break-words whitespace-pre-wrap"
				>
					<code>{block.text}</code>
				</pre>,
			);
		} else if (block.type === "callout") {
			output.push(
				<aside
					key={key}
					className="my-6 border-violet-300 bg-violet-300/5 p-5 leading-7 rounded-r-xl border-l-2"
				>
					{renderInline(block.text)}
				</aside>,
			);
		} else if (block.type === "table") {
			output.push(
				<div
					key={key}
					className="mb-6 border-white/10 max-w-full overflow-x-auto rounded-xl border"
				>
					<table className="text-sm leading-6 w-full table-fixed text-left">
						<thead>
							<tr>
								{block.headings.map((cell, cellIndex) => (
									<th
										key={cellIndex}
										scope="col"
										className="bg-white/5 p-3 font-semibold text-white [overflow-wrap:anywhere] break-words"
									>
										{renderInline(cell)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{block.headings.map((_, cellIndex) => (
										<td
											key={cellIndex}
											className="border-white/10 p-3 border-t align-top [overflow-wrap:anywhere] break-words"
										>
											{renderInline(row[cellIndex] ?? "")}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
		} else if (block.type === "paragraph") {
			const quotedPrompt = copyQuotedPrompts ? /^"([\s\S]+)"$/.exec(block.text) : null;
			if (quotedPrompt) {
				output.push(
					renderPrompt ? (
						renderPrompt(quotedPrompt[1]!, key)
					) : (
						<PromptBlock key={key} prompt={quotedPrompt[1]!} />
					),
				);
				continue;
			}
			output.push(
				<p key={key} className="mb-5 leading-7">
					{renderInline(block.text)}
				</p>,
			);
		}
	}
	while (sections.length) closeSection();
	return (
		<div className="min-w-0 max-w-3xl text-slate-300 mx-auto [overflow-wrap:anywhere]">
			{output}
		</div>
	);
}

function renderInline(text: string): ReactNode[] {
	return text
		.split(/(\[[^\]]+\]\([^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|_[^_]+_)/g)
		.filter(Boolean)
		.map((part, index) => {
			const link = /^\[([^\]]+)\]\((\/[^\s)]*)\)$/.exec(part);
			// Editorial Markdown retains its same-origin-only link contract; raw HTML is text.
			if (link && !link[2]!.startsWith("//") && !link[2]!.includes("\\"))
				return (
					<a
						key={index}
						href={link[2]}
						className="text-violet-200 hover:text-white underline underline-offset-4"
					>
						{link[1]}
					</a>
				);
			if (part.startsWith("`") && part.endsWith("`"))
				return <code key={index}>{part.slice(1, -1)}</code>;
			if (part.startsWith("**") && part.endsWith("**"))
				return <strong key={index}>{part.slice(2, -2)}</strong>;
			if (part.startsWith("_") && part.endsWith("_"))
				return <em key={index}>{part.slice(1, -1)}</em>;
			return part;
		});
}

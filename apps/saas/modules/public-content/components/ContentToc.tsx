import type { ContentHeading } from "../lib/blog-markdown";
import { publicText } from "../lib/blog-markdown";

export function ContentToc({
	headings,
	title,
	mobile = false,
}: {
	headings: readonly ContentHeading[];
	title: string;
	mobile?: boolean;
}) {
	if (!headings.length) return null;
	const links = (
		<ol>
			{headings.map((heading) => (
				<li key={heading.id} data-level={heading.level}>
					<a href={`#${heading.id}`}>{publicText(heading.text)}</a>
				</li>
			))}
		</ol>
	);
	if (mobile)
		return (
			<details className="blog-toc-mobile">
				<summary>{title}</summary>
				<nav aria-label={title}>{links}</nav>
			</details>
		);
	return (
		<nav className="blog-toc" aria-label={title}>
			<p>{title}</p>
			{links}
		</nav>
	);
}

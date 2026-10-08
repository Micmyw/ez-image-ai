import { StudioShell } from "@shared/components/studio/StudioShell";
import { getBaseUrl } from "@shared/lib/base-url";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import Link from "next/link";

import { BlogAnalytics } from "../../public-content/components/BlogAnalytics";
import { BlogPrompt } from "../../public-content/components/BlogPrompt";
import { PublicFooterLinks } from "../../public-content/components/PublicFooterLinks";
import { PublicMarkdown } from "../../public-content/components/PublicMarkdown";
import { getContentHeadings } from "../../public-content/lib/blog-markdown";
import {
	blogStructuredData,
	serializeBlogJsonLd,
} from "../../public-content/lib/blog-presentation";
import type { BlogPost } from "../../public-content/lib/blog-types";
import { RaindanceWorkbench } from "./RaindanceWorkbench";

import "../video-effects.css";
import "../raindance.css";

export type RaindanceSearch = {
	job?: string | string[];
	mode?: string | string[];
	lang?: string | string[];
};
export async function RaindanceArticle({
	post,
	searchParams,
}: {
	post: BlogPost;
	searchParams: Promise<RaindanceSearch>;
}) {
	const messages = await getMessages();
	const search = await searchParams;
	const jobId =
		typeof search.job === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(search.job) ? search.job : null;
	const analyticsPost = { id: post.id, slug: post.slug, published: true };
	const headings = getContentHeadings(post.body).filter((heading) => heading.level === 2);
	const copy = messages.videoEffects;
	const videoMessages = {
		...copy,
		twoPhotos: copy.raindance.twoPhotos,
		makeYourDuo: copy.raindance.makeYourDuo,
		history: copy.raindance.history,
		emptyHistory: copy.raindance.emptyHistory,
		stages: { ...copy.stages, CREATING_SCENE: copy.raindance.creatingScene },
	};
	return (
		<StudioShell>
			<main className="ve-page rd-page">
				<BlogAnalytics post={analyticsPost} />
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: serializeBlogJsonLd(
							blogStructuredData(post, getBaseUrl(), { home: "Home", blog: "Blog" }),
						),
					}}
				/>
				<header className="ve-intro rd-intro">
					<nav aria-label="Breadcrumb">
						<Link href="/">EzImageAI</Link>
						<span aria-hidden>/</span>
						<Link href="/blog">Blog</Link>
						<span aria-hidden>/</span>
						<span>Raindance AI trend</span>
					</nav>
					<span className="ve-eyebrow">THE SUNSET PIER EDIT</span>
					<h1>{post.title}</h1>
					<p>{post.description}</p>
					<p className="rd-facts">One photo or a duet · 5 or 10 seconds · 720p · Silent MP4</p>
					<p className="rd-byline">
						EzImageAI Editorial Team · <time dateTime={post.publishedAt}>October 7, 2026</time>
					</p>
				</header>
				<NextIntlClientProvider messages={{ videoEffects: videoMessages }}>
					<RaindanceWorkbench
						initialJobId={jobId}
						initialMode={typeof search.mode === "string" ? search.mode : undefined}
					/>
				</NextIntlClientProvider>
				<div className="rd-guide">
					<aside className="rd-toc">
						<h2>In this guide</h2>
						<nav aria-label="Article sections">
							{headings.map((heading) => (
								<a key={heading.id} href={`#${heading.id}`}>
									{heading.text}
								</a>
							))}
						</nav>
						<a className="rd-back" href="#raindance-generator">
							Make your video ↑
						</a>
					</aside>
					<article className="rd-prose">
						<PublicMarkdown
							body={post.body}
							copyQuotedPrompts
							renderPrompt={(prompt, key) => (
								<BlogPrompt key={key} post={analyticsPost} prompt={prompt} />
							)}
						/>
						<section className="rd-sources">
							<h2>Sources</h2>
							<ul>
								{post.sources?.map((source) => (
									<li key={source.url}>
										<a href={source.url} rel="noreferrer">
											{source.title}
										</a>
									</li>
								))}
							</ul>
						</section>
					</article>
				</div>
			</main>
			<PublicFooterLinks />
		</StudioShell>
	);
}

# Resources and interactive Photo Ideas

## Accepted product direction

The public navigation is AI Image, AI Tools, AI Models, Resources, and Pricing. Resources groups Blog, Editing Examples, and Docs. Blog owns editorial Photo Ideas and practical guides. A Photo Idea is useful content with optional same-page generation, rather than a separately marketed Effects tool.

The first Photo Idea is 1980s AI Photos. It combines the existing three tested presets, their complete prompts, source/output comparisons, limitations, and the shared image editor. Retire the public Effects directory and duplicate detail identity; preserve reusable generation presets and their publication/evidence checks.

## Architecture and migration

- Make `/blog/1980s-ai-photo` the single canonical published 1980s page. Keep existing unrelated Blog addresses unchanged.
- Permanently redirect the known legacy `/effects/1980s-ai-photo` address to its Blog equivalent, preserving validated preset/source context and the interface language. Redirect `/effects` to the Blog Photo Ideas view. Unknown or draft legacy slugs must not disclose unpublished content.
- Blog records own article titles, descriptions, publication, categories, and public discovery. Shared preset records keep stable IDs/versions, prompts, supported settings, rights records, paired assets, and tested-generation evidence.
- Ordinary guides need no generator. Photo Ideas can attach validated shared presets and mount the existing editor with a selected preset. No copied prompt source and no second generation or billing backend.
- Remove public AI Effects navigation, directory recommendations, and sitemap entries. Update canonical URLs, structured breadcrumbs, internal links, recommendations, and previews consistently.
- Use one navigation taxonomy across public/editor headers, mobile drawers, Docs, and grouped footers. Keep homepage SEO positioning and the existing homepage/image-to-image composer behavior and format.

## Scope and work allocation

1. Document the accepted plan and record the isolated checkout.
2. Reorganize navigation and grouped footer links.
3. Integrate 1980s content, shared presets, Blog discovery, and legacy redirects.
4. Update recommendations, customer docs, changelog, translations, and regression coverage.
5. Run focused content/routing/publication tests, app type checks, and desktop/mobile browser checks. Inspect screenshots for the Blog, 1980s article, navigation/footer, homepage, and image-to-image.

Existing generation evidence is preserved. This information-architecture migration does not require new paid generations and must not imply that new provider tests were performed.

## Acceptance criteria

- AI Image, AI Tools, AI Models, Resources, and Pricing have distinct visible responsibilities; 1980s is discovered through Resources/Blog, not as a generic tool.
- Blog lists and filters Photo Ideas and includes the published 1980s article. Published-only discovery, draft isolation, and evidence validation still fail closed.
- The 1980s article has one H1, article metadata, three matching prompt/example pairs, originals, truthful limitations, and a working same-page preset selection/editor entry.
- The same preset supplies displayed/copied prompts and editor input. Selecting a preset does not generate or spend credits.
- Legacy links redirect permanently without loops; unknown/draft slugs remain inaccessible. Canonical and sitemap include only the new published article identity.
- Existing Blog links continue to resolve. Public headers/footers agree across desktop/mobile surfaces.
- Homepage and image-to-image retain their editor content, format, upload, and generation behavior.
- Final evidence distinguishes local engineering/browser validation from paid generation, remote publication, and deployment.

## Checkout and release boundary

- Repository: `D:\AIProject\Gefei\SaaSTool\ez-image-ai`.
- Task checkout: `C:\Users\梅一伟\.codex\worktrees\resources-photo-ideas\ez-image-ai` (Codex app managed).
- Branch: `codex/resources-photo-ideas`.
- Starting commit: `1b3c9dc2c2b5ee3e9dd0b05e3fea02141908d04b`.
- Intended eventual merge target: `main`.
- Preserve the shared checkout's existing uncommitted changes and unrelated worktrees. This turn implements and verifies locally; a remote publication is a separate release step.

## Progress

- [x] Scope and checkout recorded.
- [x] Navigation and footer integration.
- [x] Blog/Photo Ideas integration and legacy compatibility.
- [x] Documentation, recommendation, and translation integration.
- [x] Focused engineering checks.
- [x] Browser checks and screenshots.

Results and release boundaries are recorded in [local acceptance](../product/resources-photo-ideas-validation.md).

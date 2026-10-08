import { TOOL_NAME_GENERATE_IMAGE } from '../tool'

export const IMAGE_ASSET_GUIDELINES_PROMPT = (codeDir: string) => `### Image assets

Every \`<img>\` must resolve to a real, stable image from the sources below. Never solid color blocks, gray fills, placeholder.com / via.placeholder, hand-drawn SVG people or scenery, or guessed URLs. (This rule covers \`<img>\` only — labelled grey blocks as wireframe content stubs remain fine per the design philosophy.)

#### Which source

1. **Key visuals** — hero, banner, product shot, scene / empty-state illustration, anything that carries the visual direction → \`${TOOL_NAME_GENERATE_IMAGE}\` when the tool is available; otherwise LoremFlickr for concrete subjects, frosted SVG for abstract ones.
2. **Secondary content images** — list thumbnails, gallery fillers, many-of-a-kind → LoremFlickr, or reuse an already generated asset. Never spend generation budget here.
3. **Avatars** — one style per prototype, stable per person. Default DiceBear; CSS initials or assets shipped with the chosen skill are fine. Never generated.
4. **Icons** — one icon set per prototype as inline SVG (Tabler, Heroicons, Lucide, or the set shipped with the chosen skill). Never emoji, never generated.
5. **Abstract decoration** — section backdrops, dividers → frosted SVG.

A skill or DESIGN.md that ships its own imagery or icon set takes precedence over these defaults.

#### Generated images (\`${TOOL_NAME_GENERATE_IMAGE}\`)

- **Save into the prototype.** Pass \`output_path\` as \`${codeDir}assets/<role>.png\` (\`hero.png\`, \`product-1.png\`, \`empty-inbox.png\`) and reference it relatively from HTML (\`assets/hero.png\`). The tool may return a different path (actual format / existing file) — always write the **returned** path into \`src\`.
- **Budget.** At most 4–6 generated images for a first build, fewer on iteration. Spend them on the hero and the visuals that define the direction; everything else uses sources 2–5.
- **Reuse first.** Check the \`assets/\` listing in the project state before generating. Regenerate only when the user asks for a different image.
- **Consistency.** For a series (the same product from several angles, the same character in several scenes, a variant of an existing asset), pass the first generated asset's path as \`reference_images\` and describe the change relative to it.
- **Timing.** \`code=no\`: generate the whole batch before writing HTML so \`src\` is final on first write, and issue all calls of the batch in one response (they run concurrently). \`code=yes\`: generate on demand and patch only the affected \`<img>\`. During a wireframe pass, do not generate at all.
- **Prompt recipe.** One fixed style prefix per prototype derived from DESIGN.md tone + palette, naming the hex values (e.g. "flat vector illustration, muted teal #2A6F6B and sand #E8DCC4, soft grain"); then subject, composition, lighting; then the aspect ratio ("wide 16:9 hero", "square product shot"). Always end with: no text, no letters, no logos, no UI elements — text belongs in HTML.
- **One image per role.** Do not composite several components into one image to crop later.

#### DiceBear

\`https://api.dicebear.com/9.x/{style}/svg?seed={seed}\`

Pick ONE style per prototype. Common picks: \`notionists\` / \`lorelei\` (SaaS), \`avataaars\` / \`micah\` (consumer), \`bottts\` (AI), \`initials\` (initials only). \`seed\` is any stable string.

#### LoremFlickr

\`https://loremflickr.com/{width}/{height}/{keywords}?lock={n}\`

Keywords are comma-separated English. **\`lock={n}\` is mandatory** — unique integer per image; without it the image rotates and breaks reviews.

#### Frosted SVG

Inline directly — no external request, colors come from the design system:

\`\`\`html
<svg width="100%" height="240" viewBox="0 0 800 240" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="n{ID}">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="{1-99}"/>
      <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.18 0"/>
    </filter>
    <linearGradient id="g{ID}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{lighter brand shade}"/>
      <stop offset="100%" stop-color="{darker brand shade}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g{ID})"/>
  <rect width="100%" height="100%" filter="url(#n{ID})"/>
</svg>
\`\`\`

Both gradient stops MUST be adjacent shades from the primary color ramp. Noise opacity (4th value in last \`feColorMatrix\` row) stays \`0.15-0.25\`. Use unique IDs (\`n1\`/\`g1\`, \`n2\`/\`g2\`…) when multiple SVGs share a page.

#### General rules

- Every \`<img>\` MUST include semantic \`alt\` text (not "placeholder").
- Add \`loading="lazy"\` to content thumbnails.
- Use the SAME source for the same image role within one page.
`

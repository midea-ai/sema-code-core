export const PLACEHOLDER_IMAGE_GUIDELINES_PROMPT = `### Image placeholders

Every \`<img>\` must use one of the sources below. Never solid color blocks, gray fills, placeholder.com, or via.placeholder. (This rule covers \`<img>\` only — labelled grey blocks as wireframe content stubs remain fine per the design philosophy.)

#### Decision tree

1. Person / avatar → DiceBear
2. Concrete scene or object (product, food, landscape, thumbnail) → LoremFlickr
3. Banner / hero / abstract decoration → self-generated frosted SVG (default when uncertain)
4. Icons → Tabler Icons or Heroicons

#### 1. DiceBear

\`https://api.dicebear.com/9.x/{style}/svg?seed={seed}\`

Pick ONE style per prototype. Common picks: \`notionists\` / \`lorelei\` (SaaS), \`avataaars\` / \`micah\` (consumer), \`bottts\` (AI), \`initials\` (initials only). \`seed\` is any stable string.

#### 2. LoremFlickr

\`https://loremflickr.com/{width}/{height}/{keywords}?lock={n}\`

Keywords are comma-separated English. **\`lock={n}\` is mandatory** — unique integer per image; without it the image rotates and breaks reviews.

#### 3. Frosted SVG (default for banners / hero / abstract)

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

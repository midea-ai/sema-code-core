export const DESIGN_MD_SPEC_PROMPT = `#### DESIGN.md format (follow exactly)

Two parts: optional YAML frontmatter (machine-readable tokens) + markdown body (human rationale). Be specific — concrete hex codes, real font stacks, real numbers.

YAML frontmatter is a fenced block between two \`---\` lines. Each token group is optional but must be well-formed:

\`\`\`yaml
---
name: <string>                          # short brand/style name
description: <string>                   # optional one-liner
colors:
  <token>: "#RRGGBB"                    # roles: primary, secondary, tertiary, neutral, surface, on-surface, error...
typography:
  <token>:                              # roles: headline-display, headline-lg/md, body-lg/md/sm, label-lg/md/sm...
    fontFamily: <string>
    fontSize: <px|em|rem>
    fontWeight: <number>
    lineHeight: <px|em|rem|number>      # unitless number = multiplier of fontSize
    letterSpacing: <px|em|rem>
rounded:
  <scale>: <px|em|rem>                  # scale: none, sm, md, lg, xl, full
spacing:
  <scale>: <px|em|rem|number>           # scale: xs, sm, md, lg, xl, gutter, margin
components:
  <component>:                          # e.g. button-primary, chip, list-item, input
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: <Dimension>
---
\`\`\`

Token rules: reason about color in \`oklch()\` (per the design philosophy), then serialize the final token as hex \`#RRGGBB\` (sRGB) here; dimensions use \`px\` / \`em\` / \`rem\`; cross-references use \`{path.to.token}\` and must point at primitive values (composite refs like \`{typography.label-md}\` are allowed only inside \`components\`).

Markdown body — sections in THIS order; omit any that don't apply, never reorder:

\`## Overview\` → \`## Colors\` → \`## Typography\` → \`## Layout\` → \`## Elevation & Depth\` → \`## Shapes\` → \`## Components\` → \`## Do's and Don'ts\`.

At most one \`<h1>\` (doc title). Every section uses \`<h2>\`. Prose references tokens by descriptive name; frontmatter values are normative.`

export const TOOL_DESCRIPTION = `Fetches a URL, converts HTML to markdown, and uses a fast model to extract information based on your prompt. Responses may be summarized for large pages. Results are cached for 15 minutes.

Routing rules (check BEFORE calling):
- Authenticated services cannot authenticate
- If an MCP web fetch tool exists, prefer it over this tool

Behavior notes:
- HTTP auto-upgrades to HTTPS
- Cross-host redirects return the redirect URL instead of content — re-fetch with the new URL
`

export function buildSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
): string {
  return `Answer the question using ONLY the web page content below. If the content does not contain the answer, say so.

<webpage>
${markdownContent}
</webpage>

Question: ${prompt}

Be concise. Preserve code snippets and exact values when relevant.
`
}

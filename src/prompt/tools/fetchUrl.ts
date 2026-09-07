export const TOOL_DESCRIPTION = `Fetches a URL, converts HTML to markdown, and uses a fast model to extract information based on your prompt. Responses may be summarized for large pages. Results are cached for 15 minutes.

Routing rules (check BEFORE calling):
- Authenticated services cannot authenticate
- If an MCP web fetch tool exists, prefer it over this tool

Behavior notes:
- HTTP auto-upgrades to HTTPS
- Cross-host redirects return the redirect URL instead of content — re-fetch with the new URL
- Non-2xx responses start with an "HTTP <status>" line followed by the raw page body, so a 403/429/503 means the site blocked the request, not that the page is empty
- If the page returns a bot check or verification page (e.g. "unusual traffic", "complete verification to continue", "enable JavaScript and cookies") instead of the real content, tell the user this site blocks non-browser clients and that enabling the browser identity for fetch_url in settings (fetchUrlBrowserUserAgent) may get past it, unless that setting is already on
- Never suggest that setting for login or paywall pages: it cannot log in, so report the content as unavailable and ask the user to paste the text instead
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

export const COMPRESSION_PROMPT = `Create a lossless state snapshot of this session so any later instance can seamlessly resume work.

Cover the following (merge sections freely, but omit nothing):

A. **Intent evolution** — User requests in time order, how they changed, final shape. Include key user messages verbatim.
B. **Technical context** — Frameworks, toolchains, architecture, runtime environment.
C. **Artifacts & changes** — Files examined/modified/created. Embed full source for key changes.
D. **Errors & fixes** — All anomalies, fix paths, and user corrections.
E. **Open items** — Closed vs in-progress vs remaining work, with blockers.
F. **Interruption point** — Exact files, functions, edit actions at the moment of interruption.
G. **Continuation path** (only if applicable) — Quote user's follow-up intent, task name, suggested handoff.

## Rules
- Archive only from conversation content — no speculation or fabrication.
- Label gaps as "not confirmed in context".
- No tool calls — pure text reasoning and archival.
- Prefer full source over vague description.
`


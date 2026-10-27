---
name: deep-research
description: "Research a question across many web pages in the user's own Chrome and deliver a cited narrative report. Use when the user asks to research or investigate a topic, compare options, survey a market, industry or literature, or analyze a trend, and the answer needs more than a single lookup. Requires browser control."
---

# Deep research

## Preconditions

- This skill searches and reads only through the user's browser, under the chrome-use skill's rules. Before any tool call, look for chrome-use in the available skills list you already have; this is a read, not a call.
- If it is not listed, browser control is off. Reply with one sentence in the user's language and end the turn: turn on Browser control in Settings, then send the question again. Do not research from memory or fall back to a URL fetch tool.
- If it is listed, load it and follow its workflow; it handles the extension and tab checks. If it reports that the browser cannot be used, relay its message and end the turn; do not create folders or spawn researchers.

## Your role

You coordinate and write. Decompose the question, spawn researchers in parallel, then write the report yourself from their notes. Never search or read pages yourself, and do not read references/researcher.md: both fill your context with text you do not need.

If you have todo or task list tools, track progress with them: one item per step from decomposition on, updated as each finishes. Word the items for the user, such as "Research pricing models", and never mention subagents in them.

## 1. Clarify only if needed

Ask first only when the answer changes how the research is done: an ambiguous term or entity, a missing region or time range. Otherwise start.

## 2. Title and folders

- Title: short enough for a file name, letters, digits and single spaces only. It names the report file and the notes folder.
- It must differ from every report delivered earlier in this conversation and every file already in research/. Returning to an earlier topic: a title that says what this request adds, and read the earlier report and notes as background before writing. An independent redo: a new title, nothing carried over.
- Layout under the working directory, with research/<title>.md as the report and research/notes/<title>/<subtopic>.md as each researcher's notes. Create research/notes/<title>/ before spawning. Give researchers absolute paths and quote paths in shell commands.

## 3. Decompose and spawn

- Split into subtopics that are mutually exclusive and together cover the question; one researcher per subtopic. A single factual question needs one researcher, most questions three, an enumerable set up to six. Never more than six: every page is a browser round trip.
- Split along whichever axis fits the question:
  - angles on one focused topic: "why solid-state batteries are not in mass production" into material bottlenecks, production cost, automaker timelines
  - evaluation criteria: "choose a vector database" into retrieval performance, cost, deployment options, ecosystem
  - entities or regions: "cross-border data transfer rules" into China, EU, US
- When extending earlier research, decompose only what this request adds or needs rechecking; the earlier notes cover the rest.
- Spawn all researchers in one turn with your subagent tool so they run in parallel. Each researcher gets a short title and instructions containing:
  - the subtopic, its objective and key questions
  - suggested source types
  - the question's constraints (time, region, language)
  - a search engine if the user named one
  - a budget only when the scope needs more or less than the default
  - the absolute notes path research/notes/<title>/<subtopic>.md
  - as the first steps, load the chrome-use skill, then read the researcher guide at the absolute path <skill base path>/references/researcher.md

## 4. One extra round at most

If the returned summaries show a gap that would make the report wrong or incomplete, spawn researchers for that gap once. Then write the report with whatever comes back; never spawn a third round.

## 5. Write the report

Read every file in the notes folder, plus the earlier report and notes when extending earlier research; where they disagree, the new notes win. Write the report following the Report section below and save it to research/<title>.md.

## 6. Deliver

Reply with a 3 to 5 sentence summary of the key findings and the report's absolute path.

## Report

- Write in the user's language for a reader who knows the field but not this question. Explain a term or entity the first time it appears.
- Structure: a short title with an active verb; one opening paragraph that answers the question directly, then why it matters; 3 to 5 sections by theme, not by researcher, with headers that state the section's finding; a short conclusion with implications only, no repetition.
- Conclusion first: the opening and each section's first paragraph give the finding and the trade-off in plain words; numbers, conditions and evidence come after. In a comparison, start each option with a bold one-line verdict.
- Layout: short paragraphs with one point each; parallel items go in a bulleted list with a bold lead word; a comparison of options against criteria goes in a table with a concrete value in every cell.
- Concrete over vague: replace words like "powerful" or "efficient" with a number, a condition or an example; give every quantity its unit; bold the critical figures.
- Cite inline as ([Source](URL)). Take the position the evidence supports, say what is uncertain or unknown, and interpret what the data means rather than listing it. Keep the report as short as the question allows.

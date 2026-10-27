---
name: deep-research
description: "Research a question across many web pages in the user's own Chrome and deliver a cited narrative report. Use when the user asks to research or investigate a topic, compare options, survey a market, industry or literature, or analyze a trend, and the answer needs more than a single lookup. Requires browser control."
---

# Deep research

## Preconditions

- This skill searches and reads only through the user's browser, under the chrome-use skill's rules. Before any tool call, look for chrome-use in the available skills list you already have; this is a read, not a call.
- If it is not listed, browser control is off. Reply with one sentence in the user's language and end the turn: turn on Browser control in Settings, then send the question again. Do not research from memory or fall back to a URL fetch tool.
- If it is listed, load it and follow its workflow; it handles the extension and tab checks. If it reports that the browser cannot be used, relay its message and end the turn.

## Flow

### 1. Clarify only if needed

Ask first only when the answer changes how the research is done: an ambiguous term or entity, a missing region or time range. Otherwise start.

### 2. Draft the report's skeleton from what you know

- Before any search, sketch the whole report as you expect it to come out: 3 to 5 sections, each with the finding you expect and the facts that would confirm or overturn it. Searching then fills in and checks the sketch; it does not decide the structure. Split along whichever axis fits the question:
  - angles on one focused topic: "why solid-state batteries are not in mass production" into material bottlenecks, production cost, automaker timelines
  - evaluation criteria: "choose a vector database" into retrieval performance, cost, deployment options, ecosystem
  - entities or regions: "cross-border data transfer rules" into China, EU, US
- Show the skeleton to the user in a few lines, then start searching.
- Extending earlier research: read the earlier report in research/ first and sketch only what this request adds or needs rechecking.

### 3. Search and read, one section at a time

- For each section: one or two searches, then read the two or three most authoritative results. Move on when the section's facts are in hand. When a page overturns what you expected, rewrite that part of the skeleton rather than forcing the evidence into it.
- After each page, write one line in your reply with what it settled and its URL. These lines are your working notes and the user's progress view; the report cites from them.
- A section still empty after its share of the budget becomes a stated gap in the report, not more searching.

### 4. Write the report

- Title: short enough for a file name, letters, digits and single spaces only, different from every file already in research/.
- Write it following the Report rules below and save it to research/<title>.md in the working directory. Quote the path in shell commands.

### 5. Deliver

Reply with a 3 to 5 sentence summary of the key findings and the report's absolute path.

## Research rules

- Use the browser for every search and page, never a URL fetch tool. Open one tab and reuse it for every navigation; close it when done.
- Search by navigating to a search URL and reading the results page as text. Use the engine the user named if there is one; otherwise start with Google and fall through the list in order:
  - Google: https://www.google.com/search?q=<query>
  - Bing: https://www.bing.com/search?q=<query>
  - Baidu: https://www.baidu.com/s?wd=<query> (also worth a search for Chinese sources even when Google works)
  - DuckDuckGo: https://html.duckduckgo.com/html/?q=<query>
- Switch to the next engine when a results page does not load, shows a captcha or returns nothing; do not retry the failed one. Switching is routine and needs no mention. Queries under five words work best; broaden when results are thin.
- Pick pages by relevance and authority, not order. Prefer primary sources: official sites, filings, papers, documentation. For recent topics trust the page over your training data.
- A login page, captcha or payment page is not a reason to stop: skip that source and move on.
- Budget: 8 searches and 16 pages for a typical question; a single fact needs 2 and 4, an enumerable survey may go to 12 and 24, never beyond. Pages that fail to load, demand a login or show a captcha do not count. Stop early when the skeleton is filled.
- Every fact in the report comes from a page you read, cited by its URL; never invent a number, quote or source. Record conflicting claims with both sources; never silently pick one. State clearly when nothing reliable was found.

## Report rules

- Write in the user's language for a reader who knows the field but not this question. Explain a term or entity the first time it appears.
- Structure: a short title with an active verb; one opening paragraph that answers the question directly, then why it matters; the skeleton's sections with headers that state each section's finding; a short conclusion with implications only, no repetition.
- Conclusion first: the opening and each section's first paragraph give the finding and the trade-off in plain words; numbers, conditions and evidence come after. In a comparison, start each option with a bold one-line verdict.
- Layout: short paragraphs with one point each; parallel items go in a bulleted list with a bold lead word; a comparison of options against criteria goes in a table with a concrete value in every cell.
- Concrete over vague: replace words like "powerful" or "efficient" with a number, a condition or an example; give every quantity its unit; bold the critical figures.
- Cite inline as ([Source](URL)). Take the position the evidence supports, say what is uncertain or unknown, and interpret what the data means rather than listing it. Keep the report as short as the question allows.

## Check before delivering

- Every section either confirms or revises what the skeleton expected, or states the gap.
- Every number has a unit and a source you actually read.
- Nothing from memory is presented as a finding.
- The opening paragraph answers the question on its own.

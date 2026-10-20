---
name: deep-research
description: "Research a question across many web pages in the user's own Chrome and deliver a cited narrative report. Use when the user asks to research or investigate a topic, compare options, survey a market, industry or literature, or analyze a trend, and the answer needs more than a single lookup. Requires browser control."
---

# Deep research

## Prerequisites

- This skill searches and reads only through the browser control tools (mcp__chrome__ prefix). Check the tool list, or the tool index in tool search mode, before anything else.
- If no such tool exists, browser control is off. Tell the user: open Settings > Integrations and turn on Browser control, install the "Sema Browser Control" extension from https://chromewebstore.google.com/detail/pjofgjgagohldpbcnkgnfjeehealejie, keep Chrome open, then ask again. Then end the turn. Do not research from memory and do not use fetch_url instead.

## Your role

You coordinate. Decompose the question, spawn researchers in parallel, spawn one writer, deliver the report. Never search, read pages or write notes yourself: it fills your context with raw page text. Researchers and the writer cannot read this skill, so paste the section they need into their instructions verbatim.

## 1. Clarify only if needed

Ask first only when the answer changes how the research is done: an ambiguous term or entity, a missing region or time range. Otherwise start.

## 2. Title and folders

- Title: the user's language, sentence case, 3 to 6 words, under 50 characters, letters, digits and single spaces only. It names the notes folder and the report file.
- It must differ from every report delivered earlier in this conversation and every folder already in research_notes/. Returning to an earlier topic: a title that says what this request adds; pass the earlier report and notes to the writer as background. An independent redo: a new title, nothing passed on.
- Create research_notes/<title>/ and reports/ in the working directory. Give subagents absolute paths and quote paths in shell commands.

## 3. Decompose

- Split into subtopics that are mutually exclusive and together cover the question; one researcher per subtopic. A single factual question needs one researcher, most questions three, an enumerable set up to six. Never more than six: every page is a browser round trip.
- Propagate the question's constraints (time, region, language) into every researcher's instructions.

## 4. Spawn researchers

All in one turn so they run in parallel. Each sub_agent call gets a short title and instructions containing: the subtopic, the objective, the key questions, suggested source types, constraints, a search engine if the user named one, a page budget when the scope needs more or less than the default, the absolute notes path research_notes/<title>/<subtopic>.md, and the full Researcher section below.

## 5. One extra round at most

If the returned summaries show a gap that would make the report wrong or incomplete, spawn researchers for that gap once, then move to the writer whatever comes back. Say "After these researchers finish, I will move directly to the writer" when you do this.

## 6. Spawn the writer

One sub_agent call. Instructions contain: the full question (the earlier question as amended, when extending earlier research), the notes folder, the earlier report and notes paths or "none", the report path reports/<title>.md, the user's language, and the full Writer section below.

## 7. Deliver

Read the finished report and reply with a 3 to 5 sentence summary of its key findings and the report's absolute path.

## Researcher

Paste this whole section into every researcher's instructions.

- You research one assigned scope; others cover adjacent scopes in parallel. Stay inside yours.
- Work only through the browser tools. Load tabs_open, tabs_close, navigate, read_page and get_text in one load_tools call. Open one tab with tabs_open and reuse it with navigate for every search and page; close it with tabs_close when done.
- Search by navigating to https://www.bing.com/search?q=<query>; use https://www.baidu.com/s?wd=<query> for Chinese sources or when Bing does not load. Use the engine named in your instructions if there is one. Never rely on Google: it is unreachable for many users. Queries under five words work best; broaden when results are thin. Read results with get_text.
- Read a page with get_text; use read_page with interactive_only false when you need a table or list. Pick pages by relevance and authority, not order.
- Budget: up to 6 searches and 12 pages unless your instructions set a different budget. Stop early when the key questions are answered; do not spend the budget for its own sake.
- A login page, captcha or payment page: skip that source and move on. Never log in, never look for credentials, never type into forms.
- Prefer primary sources: official sites, filings, papers, documentation. For recent topics trust the page over your training data. Record conflicting claims with both sources; never silently pick one. State clearly when nothing reliable was found.
- Every fact needs an inline [Source](URL); a fact without one goes to Gaps. Never invent a number, quote or source.
- Save the notes with Write to the assigned path, structured per key question as: Takeaway, Cited Findings, Inferences, Gaps. Finish by returning a two sentence summary and the notes path.

## Writer

Paste this whole section into the writer's instructions.

- Read every file in the notes folder, plus the earlier report and notes if given; where they disagree, the new notes win. Do no research and open no browser tab.
- Write in the user's language for a reader who knows the field but not this question. Explain a term or entity the first time it appears.
- Structure: a short title with an active verb; one opening paragraph that answers the question directly, then why it matters; 3 to 5 sections, each a theme rather than a researcher, with headers that state the section's finding; a one or two paragraph conclusion with implications only, no repetition.
- Progressive disclosure: the opening and each section's first paragraph give the conclusion and the trade-off in plain words; numbers, conditions and evidence come after. In a comparison or survey, start each subsection with a bold one-line verdict a layperson can follow.
- Layout for readability: a paragraph holds one point and at most 4 sentences; never stack more than two prose paragraphs in a row. Parallel items (options, causes, steps, risks) go in a bulleted list with a bold lead word, at most 5 bullets; group or merge beyond that. Items with several attributes go in a table; a table needs at least 3 columns or 4 rows, a two-column list stays bullets. One sentence bridges a list or table to the next paragraph.
- A comparison of products or options gets a table of options against criteria, with concrete values in every cell and "none" only when the option truly lacks it.
- Concrete over vague: replace words like "powerful" or "efficient" with a number, a condition or an example; give every quantity its unit; bold the critical facts and figures.
- Cite inline as ([Source](URL)). Take the position the evidence supports, say what is uncertain or unknown, and interpret what data means rather than listing it. Keep the report as short as the question allows.
- Save the report with Write to the assigned path and return one sentence confirming it.

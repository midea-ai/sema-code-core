---
name: chrome-use
description: Rules for Sema to operate the user's own Chrome through the Sema Browser Control extension and its chrome MCP tools (mcp__chrome__*). Read before any browser action: opening or reading a web page, a logged-in site, filling a form, checking a page in the browser, debugging a front-end page.
---

# Browser operation rules

You are working inside the user's own Chrome: their tabs, their logged-in sessions. They see everything you do and can take over at any time.

## When to use the browser

- Only when the user names the browser, needs a rendered page, a logged-in site, or interaction.
- For a plain URL, try fetch_url first; switch to the browser only if it fails or the page needs login.
- Using the browser once does not mean later reads must use it.

## Tools

When tool search mode is on, load all of these in one load_tools call before the first browser step:

- Tabs: mcp__chrome__tabs_list, mcp__chrome__tabs_open, mcp__chrome__tabs_close
- Reading: mcp__chrome__navigate, mcp__chrome__read_page, mcp__chrome__get_text
- Acting: mcp__chrome__click, mcp__chrome__fill, mcp__chrome__press, mcp__chrome__scroll, mcp__chrome__file_upload
- Debugging: mcp__chrome__console, mcp__chrome__network, mcp__chrome__screenshot, mcp__chrome__eval_js

When the chrome server was installed as a marketplace plugin, the prefix is mcp__plugin_<plugin-name>_chrome__ instead of mcp__chrome__; go by the actual tool list.

Each tool's description states its own parameters, limits and error texts; this file only covers what spans tools. Error messages say what to do next: follow them, and never retry an error that says not to.

## Workflow

1. Before the first browser call after loading this skill, call tabs_list once. It shows what the user has open, which helps with references like "this page" or "that system", and tabs marked [agent] that an earlier session left behind: if one is already on the target site, keep using it. Afterwards call tabs_list again only when the user names a tab of theirs or a call reports the tab no longer exists.
2. Work only in tabs you opened (tabs_open puts them in the "Sema" tab group) unless the user names one of theirs. Every call needs a tab_id; there is no default tab, so keep the id tabs_open returned.
3. Reading: get_text for articles and documentation, read_page for structure and refs. Pass interactive_only: false when you need tables, lists or text to pick a row or field. On long pages read a subtree with ref instead of the whole page again.
4. Locate elements only by ref from read_page; never guess. Refs expire after navigation or the next full read_page; on ref_invalid, read again.
5. Read the receipt (title, url, navigated, dialog) after every action. navigated: true means refs are gone; read_page before acting again. A dialog was dismissed by default, so the guarded action did not happen: do not repeat the same call unchanged; see Dialogs below.
6. No blind chains. Verify each change with the receipt or read_page. For a multi-field form: read_page, fill each field, read_page again before submitting.
7. When done, decide per tab (see Finishing).

## Dialogs

- Retry with dialog: "accept" (plus dialog_input for prompt) right away if the dialog only re-asks the action the user just ordered, or if they asked beforehand to auto-confirm dialogs.
- If it mentions consequences, scope, other records, a choice, or asks for text, report it and ask first.
- Always report the dialog text and the answer given.

## Sensitive actions

Two tiers:

- Irreversible: paying, deleting, sending to other people, publishing. Always stop before the final click and ask, even if the request already said to do it.
- Reversible submits (saving a form, marking items, changing a setting): act only if the request explicitly ordered it, touch only the items named, and report exactly what changed. Otherwise prepare everything, stop before the final click, and say what will happen:

> The weekly report is filled in: week "2026 W37", done "...", plan "...", risk "none". Not submitted. Say "submit" and I will click "Submit report".

After confirmation, click and report the receipt and what the page shows.

## Finishing

- Close a tab you opened only for reading (documentation, an article, a lookup): its content is already in your answer.
- Keep a tab that holds state: a filled form, changed records, a pending confirmation, or an error the user should see. For a comparison across several tabs keep only the final one.
- Never close a tab the user named, and never close while waiting for confirmation.
- In your reply refer to tabs by page title, plus the site or path if two share a title, and say it is in the Sema tab group in Chrome. tab_id and the [agent] marker are internal; never show them to the user:

> The "Algorithm Management" page is kept open in the Sema tab group in Chrome; the three records are now marked done, open it to check.

## Authorization, login, stop

- The first visit to a site makes the extension ask the user to allow it. If the call waits or returns "not authorized", tell the user to answer the prompt in the Sema extension, then retry once. "blocked" means the user blacklisted the site: do not retry, tell them.
- Login pages, captchas, payment pages: say where you are, ask the user to log in themselves, and end your turn. Do nothing else, never ask for a password, and never look for or guess credentials.
- user_stopped means the user pressed Stop in the extension. End your turn immediately with no more browser calls. Say which step was in progress and whether the last action was applied (a click or navigation already sent to the page cannot be undone). Do not retry in a loop after being asked to continue; the error text says what the user must click.

## Troubleshooting

- Synthetic events may not work on drag-and-drop or automation-blocking sites. If a click has no effect twice, or the page or extension stops responding, stop and tell the user.
- File upload: never click "Choose file" buttons; use file_upload with the ref of the file input itself. Upload only files the user named or files you just created for this task. Uploading does not submit.
- eval_js only reads page state read_page cannot show. Actions go through click, fill, press and navigate so receipts and dialog handling work.
- screenshot only to check visual results; it activates the tab, so the user sees it switch. Prefer read_page for structure and text.
- To find out why an action does nothing: console with clear: true, network with clear: true, do the action, then read both with only_errors and pattern/url_pattern. A missing request means the code never sent one; look for a JS error or a handler that is not attached.
- Front-end fix loop: read the error, fix the source file, navigate "reload", then verify with console (only_errors) and the page or a screenshot.

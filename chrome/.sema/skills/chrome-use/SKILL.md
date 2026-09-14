---
name: chrome-use
description: Rules for Sema to operate the user's own Chrome through the Sema Browser Control extension and its chrome MCP tools (mcp__chrome__*). Read before any browser action.
---

# Browser operation rules

You are working inside the user's own Chrome: their tabs, their logged-in sessions. They see everything you do and can take over at any time.

## When to use the browser

- Only when the user names the browser, needs a rendered page, a logged-in site, or interaction.
- For a plain URL, try fetch_url first; switch to the browser only if it fails or the page needs login.
- Using the browser once does not mean later reads must use it.

## Tools

When tool search mode is on, load all of these in one load_tools call before the first browser step; loading a few and calling the rest later fails with "tool not found":

- Tabs: mcp__chrome__tabs_list, mcp__chrome__tabs_open, mcp__chrome__tabs_close
- Reading: mcp__chrome__navigate, mcp__chrome__read_page, mcp__chrome__get_text
- Acting: mcp__chrome__click, mcp__chrome__fill, mcp__chrome__press, mcp__chrome__scroll, mcp__chrome__file_upload
- Debugging: mcp__chrome__console, mcp__chrome__network, mcp__chrome__screenshot, mcp__chrome__eval_js

When the chrome server was installed as a marketplace plugin, the prefix is mcp__plugin_<plugin-name>_chrome__ instead of mcp__chrome__; go by the actual tool list.

## Workflow

1. Call tabs_list only when the user refers to a tab of theirs. Work only in tabs you opened unless the user names one of theirs.
2. get_text for articles, read_page for structure and refs. For tables, lists and forms where you need the data to pick a row or field, pass interactive_only: false on the first read.
3. Locate elements only by ref from read_page; never guess. Refs expire after navigation or the next full read_page; on ref_invalid, read again.
4. Read the receipt (title, url, navigated, dialog) after every action:
   - navigated: true means refs are gone; read_page before acting again.
   - dialog means the page raised alert, confirm or prompt. By default it was dismissed (confirm false, prompt null), so the guarded action did not happen. Do not repeat the same call unchanged.
   - Retry with dialog: "accept" (plus dialog_input for prompt) right away if the dialog only re-asks the action the user just ordered, or if they asked beforehand to auto-confirm dialogs. If it mentions consequences, scope, other records, a choice, or asks for text, report it and ask first. Always report the dialog text and the answer given.
5. No blind chains. Verify each change with the receipt or read_page. For a multi-field form: read_page, fill each field, read_page again before submitting.
6. When done, leave your tab open and say which one, so the user can check. Close it only if there is nothing to look at. Never close while waiting for confirmation.

## Action notes

- click fails when the element is hidden, disabled or covered; on "covered", close the overlay first.
- press acts on the focused element, so click or fill it first. Browser shortcuts (new tab, copy, paste) do nothing.
- Synthetic events may not work on drag-and-drop or automation-blocking sites. If a click has no effect twice, stop and tell the user.

## File upload

- Never click "Choose file" buttons: the native picker cannot be driven. Use file_upload with the ref of the `<input type="file">` itself; it may be hidden, read_page still lists it.
- Upload only files the user named or files you just created for this task; never go looking for other files.
- After uploading, read_page: most pages show the file name next to the input or enable a submit button. Uploading does not submit; submitting is a sensitive action.

## Being stopped

- user_stopped means the user pressed Stop in the extension. End your turn immediately: no more browser calls. Say which step was in progress and whether the last action was applied (a click or navigation already sent to the page cannot be undone).
- If you get user_stopped again after the user asked you to continue, tell them to click "继续" (Resume) in the extension popup; do not retry in a loop.

## Debugging

- To find out why an action does nothing: console with clear: true, network with clear: true, do the action, then read both. Use only_errors and pattern/url_pattern to keep output short. A missing request means the code never sent one; look for a JS error or a handler that is not attached.
- Front-end fix loop: read the error, fix the source file, navigate "reload", then verify with console (only_errors) and the page or a screenshot.

## Sensitive actions

Submitting, sending, ordering, paying, deleting or anything hard to undo needs the user's confirmation in the conversation. Prepare everything, stop before the final click, and say what will happen:

> The weekly report is filled in: week "2026 W37", done "...", plan "...", risk "none". Not submitted. Say "submit" and I will click "Submit report".

After confirmation, click and report the receipt and what the page shows. If the instruction was already in the request ("mark them done"), act, but only on the items named, and report exactly what changed.

## When to stop and ask

- Error messages from the tools say what to do next; follow them and do not retry an error that says not to.
- Login pages, captchas, payment pages: say where you are, ask the user to log in themselves, and end your turn. Do nothing else, and never ask for a password.
- Never look for credentials anywhere, and never guess them.
- If the same action fails two or three times, or the page or extension stops responding, stop and explain.

import { CRON_TASKS_FILE } from '../../manager/CronManager'

export const TOOL_DESCRIPTION = `Enqueue a prompt to fire on a cron schedule. Returns a job ID for del_cron.

Schedule: 5-field cron (min hour dom month dow), local timezone.

# repeat
- false (prefer this for reminders): fires once, auto-deletes. Lock all 4 of min/hour/dom/month.
- true: repeats until cancelled or 10-day auto-expiry. Use only when the user asks for a repeating schedule.

# Relative time ("in N minutes/hours")
The system context only gives today's date, NOT the time of day. Before computing any relative offset, call shell once to read the current local time (e.g. run "date '+%M %H %d %m'"). Do not guess the hour/minute — guesses produce a cron expression matching only next year, which fails validation.

Then target = now + offset, emit a one-shot at that exact minute. Never use "*/N" for relative offsets — it matches clock boundaries and fires almost immediately.
  now=14:07, "in 3 min"  => "10 14 <dom> <mon> *"   repeat:false
  now=23:55, "in 10 min" => "5 0 <next_dom> <next_mon> *"   repeat:false (past midnight)

# Absolute / recurring examples
  "at 2:30pm today"   => "30 14 <dom> <mon> *"   repeat:false
  "every 5 min"       => "*/5 * * * *"           repeat:true
  "weekdays 9am"      => "0 9 * * 1-5"           repeat:true

# persist
- false (default): in-memory only, lost on exit. Use when the fire time is on the same calendar day as now.
- true: written to ${CRON_TASKS_FILE}, survives restart. Use when the schedule crosses a day boundary ("tomorrow", "next Monday", a specific date) or recurs.
`

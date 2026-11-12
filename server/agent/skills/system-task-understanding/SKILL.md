---
name: system-task-understanding
description: Read, identify, and summarize macOS launchd and crontab scheduled tasks for 我的macOS.
category: system
---

# System Task Understanding

Use this skill when an agent needs to inspect macOS scheduled tasks and create concise human-facing metadata.

## Inputs To Trust

- `type`: `launchd` or `cron`.
- `name` / `label`: launchd label or generated cron line label.
- `schedule`: human-readable launch calendar, interval, or raw cron fields.
- `command`: command line that will run.
- `scope`: `User LaunchAgents`, `System LaunchAgents`, `System LaunchDaemons`, or user crontab.
- `source`: plist path or `crontab`.
- logs: recent stdout/stderr snippets when present.

## Identification Heuristics

1. Prefer explicit labels and script names over guessing from directory names.
2. Treat `~/Library/LaunchAgents` and user crontab as user-owned automation; system locations are usually vendor or OS tasks.
3. Look for product names in labels, script paths, package names, bundle ids, and commands.
4. Recognize Android automation from `adb`, device serials, `input keyevent`, `am start`, `monkey`, and package names.
5. Recognize Feishu/Lark automation from `feishu`, `lark`, `com.ss.android.lark`, `飞书`, or project scripts named `open_feishu`.
6. Recognize maintenance jobs from words such as backup, sync, cleanup, rotate, update, cache, log, monitor, healthcheck.
7. If purpose is uncertain, write “疑似” or “可能” in the note.

## Metadata Output

Return only:

```json
{
  "alias": "短别名，不超过14个汉字",
  "note": "一句中文说明用途、触发时间和关键风险",
  "tags": ["2到5个短标签"]
}
```

## Style

- Alias should be useful in a sidebar, not decorative.
- Notes should mention schedule when it is important.
- Tags should be stable categories such as `飞书`, `Android`, `ADB`, `LaunchAgent`, `Cron`, `系统`, `用户任务`, `自动化`, `维护`.
- Do not invent external facts. Use “疑似” when evidence is incomplete.

# Switchboard web dashboard

A live local dashboard for the agents running in [cmux](https://cmux.com). It shows which sessions need you, which are working, which are waiting for your next step and which went stale, and lets you act on them without hunting through tabs.

It is the web side of the [Switchboard panel](https://github.com/mbonete/cmux-switchboard-panel) for cmux's sidebar: the panel's **Full dashboard ↗** opens it on `localhost:4747`. Each works without the other.

## Run it

Start it from a cmux terminal, because cmux only accepts socket connections from its own terminals:

```bash
git clone https://github.com/mbonete/cmux-switchboard-web.git
cd cmux-switchboard-web
npm start                                 # http://localhost:4747
cmux browser open http://localhost:4747   # optional: open it as a cmux split
```

It needs Node 20 or later and has no dependencies. Use `PORT=5000 npm start` for another port, for example to run it next to [Prompt Beach](https://github.com/mbonete/cmux-prompt-beach), the 3D version, which also starts on 4747.

## What it shows

| Lane | Meaning |
| --- | --- |
| Needs you | A permission, question or plan prompt is open; or the agent finished with a question; or there is an unread cmux notification. Longest wait first. |
| Working | The agent is mid-turn. Shows what it is doing now, how long the turn has run, and a tool-call sparkline. |
| Your move | Finished and idle. Shows Claude's recap (the `※ recap` line) or the start of its last reply. |
| Stale | No activity for longer than the "Stale after" setting (2 days by default). |
| No agent | Terminals without an agent. |

Each card also shows the project folder, git branch, model, context size, permission mode and any dev-server ports (as links).

## What you can do from it

- **Open in cmux:** focuses that workspace and terminal and brings cmux to the front.
- **Allow once / Always allow / Deny**, **answer a question**, **approve a plan:** sent through cmux's Feed (`feed.permission.reply`, `feed.question.reply`, `feed.exit_plan.reply`). cmux holds these for about 120 seconds; after that the agent falls back to its terminal prompt and the card says to answer there.
- **Reply:** types your text into the agent's prompt and presses Enter (`cmux paste --submit`). The server re-checks first and refuses unless the agent is idle and its prompt box is empty, so it never mixes into a draft or interrupts a turn.
- **Mark read:** clears that workspace's cmux notifications.

## Where the data comes from

- `cmux current --json`: terminals, agents, session ids, working/idle state.
- `cmux rpc workspace.list`: titles, sidebar order, listening ports, last prompt.
- `cmux rpc feed.list`: open decisions and tool-call activity.
- `cmux rpc notification.list`: unread state.
- `cmux list-status`: the sidebar status per workspace (Running, Waiting, Needs permission).
- `cmux events --reconnect`: live hook events, used to refresh within a second and to flash cards on each tool call.
- `~/.claude/projects/*/<session>.jsonl` (read-only, last 2 MB): last reply, recap, last prompt, model, context tokens, branch, the tool currently running, and pending questions or plans.

## Safety

- Listens on `127.0.0.1` only and rejects requests whose `Host` is not `localhost` or `127.0.0.1` (blocks DNS rebinding).
- Every action needs a random token that is generated at startup and only embedded in the page itself, plus a JSON body and a same-origin `Origin`. Other websites can't trigger actions, and no other page may frame this one (blocks clickjacking).
- A permission card shows the transcript's copy of the command only when it can't be another call (exactly one open call of that tool within 30 seconds of the request); otherwise it shows cmux's own copy, which is exactly what Allow approves.
- Permission replies offer only Once, Always and Deny. The Feed's "All tools" and "Bypass" modes are left out on purpose.
- Nothing is sent anywhere except to the local cmux socket.

## Tested

Checked against cmux 0.65.2 and Claude Code 2.1.322 with a throwaway Haiku session: allowing a Bash permission, replying, and answering an AskUserQuestion prompt all worked from the dashboard. Approving a plan uses the same Feed mechanism but has not been tried.

## License

MIT. See [LICENSE](LICENSE).

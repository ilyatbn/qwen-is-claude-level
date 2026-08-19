# Prompt

Paste this at the start of each session.

---

You are implementing this project from a finished spec. Work **one task at a time**.

1. Read `CLAUDE.md` — the rules.
2. Read the last few entries of `tasks/JOURNAL.md` — what the previous session left you.
3. Open `tasks/TASKS.md`, take the **first unticked box**, and open that task file.
4. Do it: read only the docs it lists under **Read first**, edit only the files under
   **Touch only**, write the tests it names, run its **Done when** command.
5. Tick the box, append a short entry to `tasks/JOURNAL.md`, report, and **stop**.
   Do not start the next task.

Never edit `docs/` — it's the spec. If it's wrong or a constant is missing, stop and
say so rather than guessing. Never report done with failing tests; paste the real
output. Everything you need is in this folder — never read anything outside it.

**If you're running low on context, or the task turns out bigger than scoped:** stop,
make sure what's on disk compiles, write an `IN PROGRESS` entry to `tasks/JOURNAL.md`
saying exactly what's done and what isn't, and tell me to start a fresh session. That
costs one message; pushing through while full costs a milestone.

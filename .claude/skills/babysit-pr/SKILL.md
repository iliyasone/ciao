---
name: babysit-pr
description: Drive a PR to a clean review. Each round a fresh sub-agent hunts bugs and problems in the whole diff, you judge and fix what it finds, push, and send it to a new reviewer, until a round brings nothing you accept. Use when asked to babysit a PR, "review and fix until clean", or run a review-fix loop on the current branch.
---

# Babysit PR

You are the author and the judge; a sub-agent is the reviewer. Each round a **new**
reviewer reads the whole PR cold and hunts for problems. You check each finding,
fix the real ones, push, and start the next round. Stop when a round brings
nothing you accept.

The reviewer runs in its own clean context so it isn't defending the code it
wrote. The judging stays with you because you know what the PR is for.

## 0. Pin the target

- Target = the PR number the user gave, or the PR of the current branch
  (`gh pr view --json number,title,body,baseRefName,headRefName,url,mergeable`);
  its `baseRefName` is the base. With no PR, review the current branch against
  the base branch the repo's AGENTS.md / CLAUDE.md names.
- Check out the head branch; the working tree must be clean and up to date with
  the remote (`git pull --ff-only`).
- The branch must merge cleanly into the base. If it conflicts, rebase or merge
  the base in first and resolve; reviewing code that won't merge wastes a round.
- Find how the repo checks itself (lint, types, tests) in AGENTS.md / CLAUDE.md /
  CI config. Run these after every round of fixes.

## 1. Review round

Spawn a fresh reviewer every round; never reuse the previous one or tell it what
earlier reviewers said beyond the dismissal list below.

- Claude Code: the Agent tool (`general-purpose`).
- No sub-agent tool (e.g. Codex): a separate process, `codex exec -s read-only "<prompt>"`
  or `claude -p "<prompt>"`.
- This reviewer is the only one: don't also request `@codex`, CodeRabbit or other
  review bots on the PR unless the user asks.

The reviewer prompt must be self-contained:

- **The diff, whole:** `git diff origin/<base>...HEAD` and `git log origin/<base>..HEAD --oneline`.
  Every round reviews the whole PR, not just the latest fixes: a fix can break
  something it touches.
- **What the PR is for:** its title and body, plus any issue they link (fetch it
  with `gh`).
- **The repo's rules:** the paths of AGENTS.md / CLAUDE.md files that apply to
  the changed files.
- **The brief:** hunt for problems that would bite someone after merge, in this
  order:
  1. Business bugs: money paid twice or lost, wrong amounts, wrong state or
     status transitions, an operator or customer told something untrue, docs or
     UI promising behaviour the code doesn't have.
  2. Technical bugs: races and double processing, retries that aren't
     idempotent, failure points with no handling (external API down, timeout,
     partial send), data, migration and cache mistakes, security and leaked
     secrets.
  3. The PR body or docs not matching what the code does; a rule from the
     repo's AGENTS.md broken.
  4. Tests that don't test what they claim, or a fixed bug with no test.
  5. Obvious cheap improvements worth doing in this PR. Mark these `nit`.
- **For every finding:** `file:line`, severity (`bug` / `problem` / `nit`), what
  goes wrong, a concrete scenario (inputs/state → wrong outcome), and a suggested
  fix. Skip what the linter enforces and taste the repo doesn't settle.
- "No findings" is a valid answer; say so to the reviewer, so it doesn't invent
  problems to fill the list.
- **From round 2 on:** the findings you dismissed earlier, each with your reason.
  The reviewer re-raises one only with a new argument against that reason.
- **Read-only:** the reviewer does not edit files, commit, comment on the PR,
  invoke skills or spawn agents of its own.

## 2. Judge

Check every finding against the code yourself before acting; reviewers are wrong
often enough. Put each into exactly one bucket:

- **Fix**: real and inside the PR's scope.
- **Dismiss**: wrong, already handled, already true before this PR and not made
  worse by it, or taste. Write a one-line reason; it goes into the next round's
  prompt and into the final report.
- **Ask the user**: real, but fixing it changes what the product does, widens the
  PR's scope, or touches code outside the diff. Collect these and ask once, at
  the end of the round, with the AskUserQuestion tool when available (as plain
  text in the final report if the loop has ended). Don't hold the other fixes
  for the answer.

An edge case that needs an unlikely chain of events is not grounds for a new
mechanism: dismiss it with that reason, or ask if it could lose money. If the
fixes are growing the PR well past what its problem needs, stop and propose
shipping the minimal fix on its own.

## 3. Fix

- Fix the accepted findings; add or adjust tests that would have caught the bugs.
- Run the repo's checks; a check your changes turned red is fixed before pushing.
  A check that is red on the base branch too is not yours; mention it in the
  report.
- Commit (one commit per round is fine, the message says which findings it
  fixes), following the repo's commit conventions, and push.
- Wait for CI on the pushed commit in the foreground:
  `gh pr checks <n> --watch --fail-fast`. Don't write your own polling loop or
  leave a background watcher; it dies with the session. A failure your commit
  caused is part of this round's fixes.
- Do not touch the PR title. Update the PR description when the fixes change what
  it claims.

## 4. Loop or stop

- The round had a `bug` or `problem` you accepted → back to step 1 with a new
  reviewer.
- The round had nothing you accepted (empty list, everything dismissed, only
  nits, or only items waiting on the user) → fix the nits you agree with and
  stop. A re-raised dismissal with no new argument stays dismissed.
- After 5 rounds, stop anyway: a loop that long means you and the reviewer
  disagree on something only the user can settle. Say plainly which fixes from
  the last round no reviewer has seen.
- During a live incident, if the user asks to deploy the fix first, deploy, then
  review; never hold an outage fix behind review rounds.
- Commits pushed after the loop ended are unreviewed: run a round before calling
  the PR clean.

## 5. Report

Tell the user, per round: what the reviewer found, what you fixed (with commit
SHAs), what you dismissed and why, and what waits on their decision. End with
the state of CI and the PR URL.

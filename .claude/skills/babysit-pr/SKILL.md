---
name: babysit-pr
description: Drive a PR to a clean review. Each round a fresh T3 Code reviewer (GPT-6.1 Sol, Opus as fallback) hunts bugs in the whole diff against the PR's pinned scope; you defend your code, fix the real findings minimally, push, and repeat until a round needs no fix. Use when asked to babysit a PR, "review and fix until clean", or run a review-fix loop on the current branch.
---

# Babysit PR

You are the author and the judge; a separate model is the reviewer. Each round
a **new** reviewer reads the whole PR cold and hunts for problems inside the
PR's scope. You check each finding, fix the real ones with the smallest change
that works, argue back against the wrong ones, push, and start the next round.
Stop when a round leaves nothing for you to fix.

The biggest risk of this loop is scope creep: every fix adds diff, the next
reviewer finds something in that diff, and the PR grows into something nobody
asked for. Two rules prevent it: the scope is written down once, before the
first round, and every reviewer judges against it; and you defend your code
instead of conceding to whatever a reviewer says.

## 0. Pin the target and the scope

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
- **Write the scope**, from the PR title, body, linked issue and the diff
  itself, and keep it unchanged for the whole loop:
  - the problem the PR solves, in one to three sentences;
  - the behaviour it changes, and the files or modules it is meant to touch;
  - non-goals: nearby things the PR deliberately leaves alone.

  The scope is the problem, not a file list: a fix for an in-scope bug may
  touch a file the scope doesn't name.
- Record the starting point: the head SHA and `git diff --shortstat origin/<base>...HEAD`.
  The final report compares the diff size against it.

## 1. Review round

Start a fresh reviewer every round; never reuse the previous one or tell it
what earlier reviewers said beyond the pushback list below.

Reviewers run as T3 Code delegated tasks (`delegate_task` from the `t3-code`
MCP server), never as the agent's own native sub-agents: only T3 applies the
model and reasoning options.

**Reviewer: GPT-6.1 Sol on high reasoning.** Each round is a new call:

```json
{
  "title": "babysit-pr #<PR> round <N>",
  "role": "review",
  "mode": "wait",
  "timeoutMs": 1800000,
  "clientRequestId": "babysit-pr-<repo>-<PR>-round-<N>",
  "target": {
    "providerInstanceId": "codex",
    "model": "gpt-6.1-sol",
    "options": { "reasoningEffort": "high" }
  },
  "task": "<the reviewer prompt below>"
}
```

- The review is the result's `summary`.
- The result's `providerInstanceId`, `model` and `options` are the proof of
  which model and effort actually ran; the stamp in step 5 relies on them. If
  they differ from the request, say so in the report.
- `timeoutMs` is only how long this call waits; it doesn't stop the review.
  `waitTimedOut: true` means the review is still running: end the turn; its
  completion wakes the thread. Read it with `task_status` and the `taskId`.
- Start the next round with a new `delegate_task` call and a new
  `clientRequestId`, never by messaging the previous reviewer's thread.
- A large diff is fine: the model has a context window of about a million
  tokens.

A failure is a rejected call or a task that ends with a provider error instead
of a review. Retry once with `-retry` appended to the `clientRequestId`.

**Fallback: Claude Opus 5.5 on high**, when the retry fails too or the Codex
provider or the model is missing from `orchestrator_capabilities`: the same
call with a Claude provider instance that lists `claude-opus-5-5` (prefer the
one this thread runs on), `"model": "claude-opus-5-5"`,
`"options": { "effort": "high" }`. Say in the report which rounds used the
fallback and why. Every round tries GPT-6.1 Sol first.

This reviewer is the only one: don't also request `@codex`, CodeRabbit or other
review bots on the PR unless the user asks.

The reviewer prompt must be self-contained:

- **The scope** from step 0, verbatim, marked as the yardstick for the review.
- **The diff, whole, pasted into the prompt:** `git diff origin/<base>...HEAD`
  and `git log origin/<base>..HEAD --oneline`. The reviewer may read other
  files in the repo for context.
  Every round reviews the whole PR, not just the latest fixes: a fix can break
  something it touches.
- **What the PR is for:** its title and body, plus any issue they link (fetch it
  with `gh`).
- **The repo's rules:** the paths of AGENTS.md / CLAUDE.md files that apply to
  the changed files.
- **The brief:** hunt for problems inside the scope that would bite someone
  after merge, in this order:
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
- **Severity for every finding:**
  - `blocker`: merging this causes the harm above.
  - `should`: a real defect in the PR's own lines, but not harmful on its own.
  - `nit`: small and optional.
- **For every finding:** `file:line`, severity, what goes wrong, a concrete
  scenario (inputs/state → wrong outcome), and the smallest fix. Skip what the
  linter enforces and taste the repo doesn't settle.
- **Out of scope goes to its own list.** A problem that exists outside the
  scope (code the PR doesn't touch, a bug that was there before and the PR
  doesn't make worse, a refactor or feature idea) goes under "Out of scope",
  one line each. It never blocks approval.
- **Verdict at the end:** `APPROVE` when no `blocker` or `should` remains, else
  `REQUEST_CHANGES`. Approving with zero findings is a valid answer; say so to
  the reviewer, so it doesn't invent problems to fill the list.
- **From round 2 on:** every finding you pushed back on in any earlier round,
  each with your argument. The reviewer accepts the argument or answers it with a new one;
  repeating the finding without a new argument doesn't count.
- **Read-only:** the reviewer does not edit files, commit, comment on the PR,
  invoke skills or spawn agents of its own.

## 2. Judge and defend

You wrote this PR and know why it is the way it is. Check every finding against
the code yourself; reviewers are wrong often enough. Conceding to a wrong
finding to keep the peace is the main way PRs bloat, so argue firmly whenever
the code is right: cite the line, the test, or the constraint that makes the
finding wrong. Put each finding into exactly one bucket:

- **Fix**: real and inside the scope. Make the smallest change that removes the
  problem; no surrounding cleanup, no new abstraction, no unrelated test churn.
- **Push back**: wrong, already handled, taste, or an edge case that needs an
  unlikely chain of events and would need a new mechanism to cover. Write the
  argument; it goes into the next round's prompt and the final report.
- **Out of scope**: real, but outside the scope from step 0. Don't fix it; list
  it as a follow-up in the report.
- **Ask the user**: rare. Only when fixing would change what the product does. Collect these and
  ask once, at the end of the round, with the AskUserQuestion tool when
  available (as plain text in the final report if the loop has ended). Show
  both sides in two or three lines each. Don't hold the other fixes for the
  answer.

A reviewer that answers your pushback with a new argument you can't refute has
shown the finding is real: move it to Fix (or Ask the user, if fixing changes
what the product does).

Nits: fix the ones that sit on lines the PR already changes and take a minute;
drop the rest without listing them in the report.

If the fixes are pushing the PR past its scope or the diff is growing much
faster than the problem needs, stop and tell the user rather than continuing.

## 3. Fix and push

- Fix the accepted findings; add or adjust a test only where it would have
  caught a bug you fixed.
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

Your buckets drive the loop, not the reviewer's verdict alone:

- You fixed a `blocker` or `should` this round → back to step 1 with a new
  reviewer.
- Nothing to fix → done. That covers `APPROVE`, and also `REQUEST_CHANGES`
  where every open item is pushed back, out of scope, or waiting on the user.
- After 5 rounds, stop anyway. Running out of rounds is not approval: report
  which findings stay open and which fixes from the last round no reviewer has
  seen.
- During a live incident, if the user asks to deploy the fix first, deploy, then
  review; never hold an outage fix behind review rounds.
- Nit fixes from the last round need no extra round; list them in the report.
  Any other commit pushed after the loop ended is unreviewed: run a round
  before calling the PR clean.

## 5. Stamp the PR and report

When the loop ends on a PR, add one line to its description (with no PR, skip
the stamp and `gh pr checks`), directly above the agent's generated-by line (such as `🤖 Generated with Claude Code`) if there
is one, else at the end:

```
Reviewed with babysit-pr: <N> rounds with <model> on <effort>. Verdict: approved
```

- Verdict: `approved` when the last reviewer said `APPROVE`; `pushed back`
  when it said `REQUEST_CHANGES` and you closed the loop over its findings
  or every open item is out of scope or waiting on the user; `not approved
  after <N> rounds` when the last allowed round still had a fix. For the last
  two, add `, open: <short list of the unfixed blocker/should items>`.
- `<model>` is the reviewer of the last round (e.g. `GPT-6.1 Sol`,
  `Claude Opus 5.5`); name both when rounds used different models.
- Write `on <effort>` only when the task result's `options` confirmed it;
  otherwise drop it.
- Replace an earlier stamp instead of adding a second one.

Then tell the user: rounds and the model of each, what each reviewer found,
what you fixed (with commit SHAs), what you pushed back on and why, the
out-of-scope follow-ups, what waits on their decision, the diff size before and
after, the state of CI and the PR URL.

# Desktop · Page 09 — Plan Review & Diff Gate

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The plan-mode checkpoint and the code-review gate: the operator reads the agent's plan (or the build's diff + reviewer findings) and decides Approve / Edit / Reject / Respond before anything irreversible happens.

## Layout — two designed modes of one page

### Mode A: Plan gate
Centered reading column (720px) on the canvas: a "Plan" document card — numbered steps rendered as elegant checklist rows (step title Headline, detail Body secondary), estimated cost/time footer in mono, effort chip "Planned at DEEP". Pinned bottom action bar (frosted, full width): four buttons — **Approve & build** (blue pill, prominent), **Edit plan** (opens inline editing of step text), **Respond** (opens a reply field that feeds back to the agent), **Reject** (red text button, confirm).

### Mode B: Build review gate (diff)
3-pane:
- Left (240px): changed-files tree with +/− counts in green/red mono.
- Center: the diff viewer — side-by-side or unified (segmented toggle), SF Mono 13, additions on `#E8F8EE`, deletions on `#FDEBEC`, hairline line numbers, sticky file headers with language chip.
- Right (320px): **Reviewer findings** — cards from the GPT reviewer: severity dot (red/amber/grey), terse finding text, "Jump to line" link, and a per-finding state chip (Open / Fixed in loop ✓). Header shows "Review · GPT reviewer · pass 2" and net verdict pill ("2 issues remaining").
Bottom action bar: **Approve & merge to PR** (blue), **Request fixes** (sends findings back to the loop), **Reject**, plus a quiet "Judge panel: 3/3 approve" chip when auto-merge panels ran.

## States
Gate-resolved-elsewhere: grey overlay "Already approved from your phone · 2 min ago". Stale gate after restart: identical, durable — add subtle footnote "Gate survived restart". Loading diff skeleton.

## Micro-interactions
Approve triggers a satisfying check-pop then the bar slides away and the job status flips to Building/Merging. Finding cards strike through with a soft green sweep when the fix loop resolves them.

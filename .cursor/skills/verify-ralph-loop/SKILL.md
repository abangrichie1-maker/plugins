---
name: verify-ralph-loop
description: "Check the Ralph loop's decision to send the task around again. Use when a change touches ralph-loop/hooks/stop-hook.sh, ralph-loop/hooks/capture-response.sh, or ralph-loop/hooks/hooks.json, or when you need to know whether that loop stops too early or keeps going."
---

# Verify the Ralph loop

The Ralph loop is two hooks. `capture-response.sh` runs after the agent replies and may write `.cursor/ralph/done`. `stop-hook.sh` then either deletes the scratchpad or sends the same task back as a followup. `hooks.json` sets that stop hook's `loop_limit` to null, so Cursor will not cap the loop. The default `max_iterations` is 0, which these hooks treat as unlimited.

## The property

Ralph sends the stored task back for another round if and only if the opening round count is a number, the task text is not empty, the reply has not put the user's exact completion phrase inside a promise tag, and a positive round limit is not yet reached; when it does, the followup carries the same task lines and the stored round count increases by one.

If this is wrong, the agent keeps editing the user's project after the work is finished or past the limit they set, or it deletes the loop while the task is unfinished, and Cursor will not stop it because the hook's loop limit is turned off.

## When a change touches this

Read the diff. The check describes only these files:

- `ralph-loop/hooks/capture-response.sh` — the whole script. The steps are: leave if there is no scratchpad (lines 19–21), read the phrase (lines 24–25), ignore a null phrase (lines 28–29), ignore an empty reply (lines 35–37), take the first promise tag or else the whole reply (line 40), and set the done flag on a literal match (lines 42–43).
- `ralph-loop/hooks/stop-hook.sh` — the whole script. The steps are: leave if there is no scratchpad (lines 20–22), read every `---` block (lines 25–28), stop if the round count or the limit is not a single number (lines 31–41), stop if the done flag is set (lines 44–47), stop if a positive limit has been reached (lines 51–54), copy the task while skipping lines that are only `---` (line 58), stop if the task is empty (lines 60–63), add one to the stored round (lines 67–70), and send the followup (lines 73–84).
- `ralph-loop/hooks/hooks.json` — the `afterAgentResponse` hook, the `stop` hook, and `loop_limit` null.

The scripts have no functions. A change that does not touch these three files does not change what this check describes. A change that does, including a rename or a move of one of these steps, needs the check run again and, if the steps are no longer the ones named above, a model update.

## How to run it

From the repo root:

```sh
node .cursor/skills/verify-ralph-loop/check.mjs
```

The model checker is TLC, the checker inside TLA+ tools **1.7.4** (sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`). The command downloads that jar on first use, or uses `TLA2TOOLS` when it points at a jar with that checksum. It needs Java 11 or newer (this was run on OpenJDK 21.0.13), plus `bash`, `jq`, and `perl`, which the hooks themselves call. One run is the hook cases plus four TLC runs and finishes in well under a minute.

TLA+ is the tool because the question is the order of the two hooks across rounds: reply, then the capture hook, then the stop hook, and whether that order can continue after the phrase or the limit, or stop while the task is unfinished. Bash has no verifier that runs on the scripts. The same command therefore runs the real `capture-response.sh` and `stop-hook.sh` on every case in the bound. That half is what notices an edit to the scripts. The TLA+ model alone would not.

Read every TLC result with `/statechart`. The view module is `.cursor/skills/verify-ralph-loop/view.mjs`, next to `RalphLoop.tla`.

## What the run means

The command exits **1** when the only breaks are the four recorded below and TLC fails the same three clauses the hooks fail. That is the current code, not a pass. It exits **0** only when `KNOWN_KINDS` in `check.mjs` is empty and the hooks and TLC both hold every clause. It exits **2** when a new break appears, a recorded break disappears, or TLC and the hooks disagree about a clause. Exit 2 on a hook edit you did not reflect in `RalphLoop.tla` is a stale model. Exit 2 where TLC and the hooks agree is a new break in the hooks: report the counterexample, and do not weaken a clause or the model to hide it. Do not change the hook scripts from this skill.

A modeling error is a TLC step that the scripts cannot take. The capture step is `capture-response.sh` and it runs to the end before `stop-hook.sh` starts. Each stop action is one branch of `stop-hook.sh`, in the order the script tests them: unreadable count, done flag, limit, empty task, then the followup. If a trace needs a branch the script does not have, the model is wrong. Fix the model from the script, then run the command again.

## Recorded breaks

These four are in the hooks at the sync commit. The hook sweep and TLC agree. TLC's shortest path for each broken clause is two steps. In the chart, three states are marked:

- "Sent the task again after the phrase was said" breaks `NoFollowupAfterPhrase`.
- "Sent the task again with the task text changed" breaks `FollowupKeepsTaskText`.
- "Stopped even though the task was not finished" breaks `HaltOnlyForARealReason`.

The chart draws only those bug paths. It hides a normal followup, a stop at the limit, a stop on an empty task, a stop on a non-numeric opening count, and the bare-word stop below. The bare-word stop ends in the same chart state as the example-scratchpad stop; TLC's shortest path for that clause is the example, so the chart shows the example.

1. A quoted phrase never matches, so an unlimited loop does not stop. The scratchpad has `completion_promise: "say \"hi\""`, `max_iterations: 0`, `iteration: 1`, and the task `Build the API.` The reply is `<promise>say "hi"</promise>`. The sed that strips quotes (`capture-response.sh` line 25, the same sed in `stop-hook.sh` line 28) keeps the backslashes, so the tag does not match, the done flag stays unset, and the stop hook sends the task again as iteration 2. With the default unlimited limit this continues.

2. A line that is only `---` is dropped from the task the agent sees. `max_iterations` is 0, there is no completion phrase, the task contains a line `---`, and the reply is `still working`. The stop hook sends another round, and that line is gone from the followup. `stop-hook.sh` line 58 skips every such line. The scratchpad file still has it.

3. An example scratchpad inside the task deletes the loop. The task contains a second `---` block whose `iteration` line is `9`. The opening iteration is still 1, `max_iterations` is 0, and the reply is `still working`, with no promise tag. The sed on `stop-hook.sh` line 25 reads both blocks, the count is no longer a single number, and lines 31–34 delete the scratchpad.

4. The bare word `COMPLETE` ends the loop. The phrase is `COMPLETE` and the reply is that word with no promise tag. The perl on `capture-response.sh` line 40 leaves the whole reply when there is no tag, the comparison on line 42 succeeds, and the stop hook deletes the loop. The plugin's help says completion is the promise tag. This is the same clause as break 3. The hook sweep finds it; TLC's shortest path for the clause is break 3.

Clauses that hold inside the bound: `NoFollowupPastLimit` (the check on `stop-hook.sh` lines 51–54), `FollowupCountsTheRound` (lines 67–70), `FollowupOnlyIfRoundCountReads`, `FollowupOnlyIfTaskPresent`, and `TypeOK`. An exact `<promise>COMPLETE</promise>` still stops the loop. Reaching a positive limit still stops it. Removing the limit check is a new break: the command then reports a followup at `max_iterations` 1 and exits 2, and TLC still says `NoFollowupPastLimit` holds until the model is updated.

## Bounds and assumptions

The model starts from the scratchpad shape in `ralph-loop/skills/ralph-loop/SKILL.md`: `iteration` is 1. It then takes every combination of:

- `max_iterations` 0, 1, or 2 (0 means unlimited, as in `stop-hook.sh` line 51)
- phrase: none (`null`), `COMPLETE`, or `say "hi"` written as `"say \"hi\""`
- task: plain text, a line that is only `---`, a second `---` block containing `iteration: 9`, an opening iteration that is not a number, or an empty task
- reply: other text, `<promise>COMPLETE</promise>`, the bare word `COMPLETE`, `<promise>say "hi"</promise>`, or empty

That is 45 starting states. `Bound` allows at most 3 visits to the stop hook, so an unlimited loop cannot run without end. With the three broken clauses removed, TLC explored **745** distinct states and the remaining clauses held. The hook sweep runs the same 225 one-turn cases (45 starts, 5 replies) by executing the scripts.

Assumptions, which are not checked:

- Cursor finishes `afterAgentResponse` before `stop` on the same turn. The README states that order, and `stop-hook.sh` line 43 depends on it. The opposite order is not in the model. If the stop hook ran first, a reply that did contain the tag would still send one more round, and the done flag would end the loop on the round after that.
- The line the hook adds in front of the task (`[Ralph loop iteration N...]`) is not the task text.
- Bash removes the final newline when the stop hook captures the task. The check compares task lines and does not call that a change.
- `hooks.json` `loop_limit` null means the platform adds no further cap. The model does not contain a platform cap.

Outside this bound, and not checked: any other phrase or task text, a reply with two promise tags (the perl keeps the first tag only), a `max_iterations` above 2, a fourth round, the hook's `status` field (the script never reads it, so an aborted turn is not a separate case here), and `cancel-ralph`, which stops the loop by deleting `.cursor/ralph`.

## Keeping the check in step with the code

Sync commit: `fb1b65fe959fda3753dae64519c03082b2961804`

That commit is the one at which this model was confirmed to describe the three hook files. Move it forward only after you have run the command on the new commit and confirmed that every action in `RalphLoop.tla` still matches the script it names. If the covered files are unchanged since this commit, the model still describes them. If you only correct this hash, leave the sync commit pointing at the commit you actually checked.

When you do update the model, change it from the scripts before you re-run, and do not shape it so that a recorded break disappears. A break that the hooks still show is a finding. After a real fix to the hooks, a recorded kind that no longer appears makes the command exit 2 until you remove that kind from `KNOWN_KINDS` in `check.mjs` and from the list above, and you say in the change that the hook now matches the property.

For drift that landed without this check, use `/maintain-formal-verification-skill`.

A close second, not checked here, is the Advisor stop hook (`advisor/hooks/stop-hook.sh` and the hooks that set its pending flag). It is the same kind of two-hook decision, and its `loop_limit` is 3, so a miss nags or skips a consult instead of running without a cap.

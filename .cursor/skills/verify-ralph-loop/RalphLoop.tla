---- MODULE RalphLoop ----
\* Ralph loop: capture-response.sh then stop-hook.sh, one turn at a time.
\*
\* Platform assumption, stated in ralph-loop/README.md ("An afterAgentResponse
\* hook watches each response... A stop hook fires when Cursor finishes a
\* turn") and in stop-hook.sh:43: Cursor finishes capture-response.sh before
\* it starts stop-hook.sh for the same turn. This spec does not include the
\* opposite order.
\*
\* The opening of the scratchpad is what ralph-loop/skills/ralph-loop/SKILL.md
\* writes: iteration starts at 1. max_iterations 0 means unlimited
\* (stop-hook.sh:51). hooks.json sets the stop hook's loop_limit to null, so
\* this spec is the only cap.

EXTENDS Integers

VARIABLES
  phase,            \* "active" while .cursor/ralph/scratchpad.md exists
  pc,               \* "capture", "stop", or "done"
  iteration,        \* first frontmatter iteration, stop-hook.sh:26
  maxIter,          \* max_iterations, stop-hook.sh:27
  promise,          \* "null", "word" (COMPLETE), or "quoted" (say "hi")
  prompt,           \* task shape: plain, rule, example, corrupt, blank
  doneFlag,         \* .cursor/ralph/done, capture-response.sh:43
  response,         \* reply class for this turn
  rounds,           \* how many times the stop hook has run
  decision,         \* "none", "followup", or "halt"
  stopTagMatched,   \* snapshot: the reply had the user's phrase in a tag
  stopIter,         \* snapshot: iteration the stop hook read
  stopPromptSame    \* snapshot: followup task text equals the stored task text

vars == <<phase, pc, iteration, maxIter, promise, prompt, doneFlag, response,
          rounds, decision, stopTagMatched, stopIter, stopPromptSame>>

Responses == {"other", "exactTag", "bareWord", "quotedTag", "empty"}
Promises == {"null", "word", "quoted"}
Prompts == {"plain", "rule", "example", "corrupt", "blank"}

\* sed '/^---$/,/^---$/' keeps every fence block, then grep '^iteration:'
\* must be one number. A second block in the task (prompt = "example") or a
\* non-numeric opening (prompt = "corrupt") fails stop-hook.sh:31-34.
\* A plain number in the opening block is readable.
ReadsCount == prompt \in {"plain", "rule", "blank"}

\* The phrase the user asked for, inside <promise>...</promise>.
\* "word" is completion_promise: "COMPLETE".
\* "quoted" is completion_promise: "say \"hi\"" as the skill tells the agent
\* to quote a phrase that contains a special character. The sed in
\* capture-response.sh:25 and stop-hook.sh:28 leaves the backslashes in, so
\* the parsed phrase is not the phrase inside the tag.
PhraseInTag ==
  \/ /\ promise = "word"
     /\ response = "exactTag"
  \/ /\ promise = "quoted"
     /\ response = "quotedTag"

AtStop ==
  /\ phase = "active"
  /\ pc = "stop"

UnderLimit ==
  \/ maxIter = 0
  \/ iteration < maxIter

Init ==
  /\ phase = "active"
  /\ pc = "capture"
  /\ iteration = 1
  /\ maxIter \in 0..2
  /\ promise \in Promises
  /\ prompt \in Prompts
  /\ doneFlag = FALSE
  /\ response = "empty"
  /\ rounds = 0
  /\ decision = "none"
  /\ stopTagMatched = FALSE
  /\ stopIter = 0
  /\ stopPromptSame = TRUE

\* capture-response.sh. No scratchpad: lines 19-21, not taken while active.
\* promise null or empty: lines 28-29, the done flag is left untouched.
\* empty reply: lines 35-37, same.
\* Otherwise perl (line 40) takes the first <promise> tag, or, when there is
\* no tag, leaves the whole reply. The quoted comparison on line 42 is
\* literal. For promise "word" that sets the done flag on exactTag and on
\* bareWord, because the whole reply "COMPLETE" survives the failed
\* substitution. For promise "quoted" none of these replies equal the
\* backslash-kept phrase, so the flag stays down.
CaptureResponse ==
  /\ phase = "active"
  /\ pc = "capture"
  /\ \E r \in Responses:
       /\ response' = r
       /\ doneFlag' =
            IF promise = "word" /\ (r = "exactTag" \/ r = "bareWord")
            THEN TRUE
            ELSE doneFlag
       /\ pc' = "stop"
       /\ UNCHANGED <<phase, iteration, maxIter, promise, prompt, rounds,
                      decision, stopTagMatched, stopIter, stopPromptSame>>

Halt ==
  /\ rounds' = rounds + 1
  /\ stopIter' = iteration
  /\ stopTagMatched' = PhraseInTag
  /\ stopPromptSame' = TRUE
  /\ decision' = "halt"
  /\ phase' = "stopped"
  /\ pc' = "done"
  /\ doneFlag' = FALSE
  /\ UNCHANGED <<iteration, maxIter, promise, prompt, response>>

\* stop-hook.sh:31-34. Checked before the done flag and the limit.
StopBecauseUnreadable ==
  /\ AtStop
  /\ ~ReadsCount
  /\ Halt

\* stop-hook.sh:44-47.
StopBecauseDone ==
  /\ AtStop
  /\ ReadsCount
  /\ doneFlag
  /\ Halt

\* stop-hook.sh:51-54. A positive max stops when iteration has reached it.
\* The count is the one already stored, before the increment below.
StopBecauseLimit ==
  /\ AtStop
  /\ ReadsCount
  /\ ~doneFlag
  /\ maxIter > 0
  /\ iteration >= maxIter
  /\ Halt

\* stop-hook.sh:58-63. awk yields nothing, so the hook deletes the scratchpad.
StopBecauseBlank ==
  /\ AtStop
  /\ ReadsCount
  /\ ~doneFlag
  /\ UnderLimit
  /\ prompt = "blank"
  /\ Halt

\* stop-hook.sh:67-84. sed writes iteration + 1, then jq prints the followup.
\* awk on line 58 skips every line that is exactly ---, so a task of shape
\* "rule" is not copied unchanged. The header the hook adds is not the task.
\* Bash command substitution also strips a final newline from every task.
\* That newline is not a line of the task, and stopPromptSame ignores it.
ContinueLoop ==
  /\ AtStop
  /\ ReadsCount
  /\ ~doneFlag
  /\ UnderLimit
  /\ prompt # "blank"
  /\ rounds' = rounds + 1
  /\ stopIter' = iteration
  /\ iteration' = iteration + 1
  /\ stopTagMatched' = PhraseInTag
  /\ stopPromptSame' = (prompt # "rule")
  /\ decision' = "followup"
  /\ pc' = "capture"
  /\ UNCHANGED <<phase, maxIter, promise, prompt, doneFlag, response>>

\* End state. The scratchpad is gone; nothing else happens.
Done ==
  /\ phase = "stopped"
  /\ UNCHANGED vars

Next ==
  \/ CaptureResponse
  \/ StopBecauseUnreadable
  \/ StopBecauseDone
  \/ StopBecauseLimit
  \/ StopBecauseBlank
  \/ ContinueLoop
  \/ Done

Spec == Init /\ [][Next]_vars

\* One stop per turn, three turns. Enough to reach maxIter 2 and to keep
\* maxIter 0 from running without end.
Bound == rounds <= 3

TypeOK ==
  /\ phase \in {"active", "stopped"}
  /\ pc \in {"capture", "stop", "done"}
  /\ iteration \in 1..5
  /\ maxIter \in 0..2
  /\ promise \in Promises
  /\ prompt \in Prompts
  /\ doneFlag \in BOOLEAN
  /\ response \in Responses
  /\ rounds \in 0..4
  /\ decision \in {"none", "followup", "halt"}
  /\ stopTagMatched \in BOOLEAN
  /\ stopIter \in 0..4
  /\ stopPromptSame \in BOOLEAN

\* The property, in clauses TLC can report separately. Together they say:
\* a followup happens if and only if the opening round count is a number,
\* the task text is not empty, the reply did not put the user's phrase in a
\* promise tag, and a positive limit is not reached; and the followup copies
\* the task text and adds one to the stored round count.
\* A halt while all of those continue-conditions hold breaks the last clause.

NoFollowupAfterPhrase ==
  decision # "followup" \/ ~stopTagMatched

NoFollowupPastLimit ==
  decision # "followup" \/ maxIter = 0 \/ stopIter < maxIter

FollowupKeepsTaskText ==
  decision # "followup" \/ stopPromptSame

FollowupCountsTheRound ==
  decision # "followup" \/ iteration = stopIter + 1

FollowupOnlyIfRoundCountReads ==
  decision # "followup" \/ ReadsCount

FollowupOnlyIfTaskPresent ==
  decision # "followup" \/ prompt # "blank"

\* prompt = "example" still has a numeric opening iteration. The code halts
\* anyway, and that is not one of these reasons.
HaltOnlyForARealReason ==
  \/ decision # "halt"
  \/ stopTagMatched
  \/ (maxIter > 0 /\ stopIter >= maxIter)
  \/ prompt = "corrupt"
  \/ prompt = "blank"

====

function haltJustified(v) {
  return (
    v.stopTagMatched === true ||
    (v.maxIter > 0 && v.stopIter >= v.maxIter) ||
    v.prompt === "corrupt" ||
    v.prompt === "blank"
  );
}

export const title = "When the Ralph loop sends the task around again";

export const state = (v) => {
  if (v.decision === "followup" && v.stopTagMatched === true && v.stopPromptSame === false)
    return "Sent a changed task after the phrase was said";
  if (v.decision === "followup" && v.stopTagMatched === true)
    return "Sent the task again after the phrase was said";
  if (v.decision === "followup" && v.stopPromptSame === false)
    return "Sent the task again with the task text changed";
  if (v.decision === "followup" && v.maxIter > 0 && v.stopIter >= v.maxIter)
    return "Sent the task again after the limit";
  if (v.decision === "followup") return "Sent the task again";
  if (v.decision === "halt" && !haltJustified(v))
    return "Stopped even though the task was not finished";
  if (v.decision === "halt") return "Stopped";
  if (v.pc === "stop") return "Reading the reply";
  return "Waiting for the agent's reply";
};

export const step = (action, _from, to) => {
  if (action === "CaptureResponse") return "the agent replies";
  if (action === "StopBecauseUnreadable") return "the round count cannot be read";
  if (action === "StopBecauseDone") return "the completion flag is set";
  if (action === "StopBecauseLimit") return "the round limit is reached";
  if (action === "StopBecauseBlank") return "the task text is empty";
  if (action === "ContinueLoop" && to.stopTagMatched === true && to.stopPromptSame === false)
    return "the task is sent again, changed, after the phrase";
  if (action === "ContinueLoop" && to.stopTagMatched === true)
    return "the task is sent again after the phrase";
  if (action === "ContinueLoop" && to.stopPromptSame === false)
    return "the task is sent again without a line of dashes";
  if (action === "ContinueLoop") return "the task is sent again";
  return null;
};

export const group = (v) => {
  const label = state(v);
  if (
    label === "Sent a changed task after the phrase was said" ||
    label === "Sent the task again after the phrase was said" ||
    label === "Sent the task again with the task text changed" ||
    label === "Sent the task again after the limit" ||
    label === "Stopped even though the task was not finished"
  )
    return "Breaks the rule";
  if (label === "Stopped") return "Ended";
  return "Still working";
};

export const colors = {
  "Still working": "blue",
  Ended: "purple",
  "Breaks the rule": "orange",
};

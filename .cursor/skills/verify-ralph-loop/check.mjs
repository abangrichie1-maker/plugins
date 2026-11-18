#!/usr/bin/env node
// Re-run the Ralph loop check. From the repo root:
//   node .cursor/skills/verify-ralph-loop/check.mjs
//
// TLC 1.7.4 explores the hook order. The same command then runs
// ralph-loop/hooks/capture-response.sh and stop-hook.sh on every case in
// that bound. Exit 1 means the only failures are the known ones listed in
// SKILL.md. Exit 2 means a new failure, a known failure disappeared, or the
// model and the hooks disagree.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CAPTURE = join(ROOT, "ralph-loop/hooks/capture-response.sh");
const STOP = join(ROOT, "ralph-loop/hooks/stop-hook.sh");
const SPEC = join(HERE, "RalphLoop.tla");
const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const JAR = join(process.env.HOME ?? "/tmp", ".cache/tlaplus", `tla2tools-${TLC_VERSION}.jar`);
const BOUND_ROUNDS = 3;

const RESPONSES = ["other", "exactTag", "bareWord", "quotedTag", "empty"];
const PROMISES = ["null", "word", "quoted"];
const PROMPTS = ["plain", "rule", "example", "corrupt", "blank"];
const MAXES = [0, 1, 2];

const KNOWN_KINDS = [
  "unrecognized-quoted-phrase",
  "task-text-changed",
  "bare-phrase-stops",
  "example-block-stops",
];

const FAILING_INVARIANTS = [
  "NoFollowupAfterPhrase",
  "FollowupKeepsTaskText",
  "HaltOnlyForARealReason",
];
const HOLDING_INVARIANTS = [
  "TypeOK",
  "NoFollowupPastLimit",
  "FollowupCountsTheRound",
  "FollowupOnlyIfRoundCountReads",
  "FollowupOnlyIfTaskPresent",
];

const responseText = {
  other: "still working",
  exactTag: "<promise>COMPLETE</promise>",
  bareWord: "COMPLETE",
  quotedTag: '<promise>say "hi"</promise>',
  empty: "",
};

const taskBody = {
  plain: "Build the API.\n",
  rule: "Build the API.\n\n---\n\nDo not stop early.\n",
  example: 'Build the API.\n\n---\niteration: 9\nmax_iterations: 1\ncompletion_promise: "NOPE"\n---\n',
  corrupt: "Build the API.\n",
  blank: "",
};

function scratchpad({ iteration, max, promise, prompt }) {
  const promiseField = {
    null: "null",
    word: '"COMPLETE"',
    quoted: '"say \\"hi\\""',
  }[promise];
  const iterField = prompt === "corrupt" ? "abc" : String(iteration);
  const body = taskBody[prompt];
  const closing = body === "" ? "---\n" : `---\n\n${body}`;
  return `---\niteration: ${iterField}\nmax_iterations: ${max}\ncompletion_promise: ${promiseField}\n${closing}`;
}

function storedTask(prompt) {
  return prompt === "blank" ? "" : `\n${taskBody[prompt]}`;
}

function runHook(script, input, dir) {
  return spawnSync("bash", [script], {
    input,
    encoding: "utf8",
    env: { ...process.env, CURSOR_PROJECT_DIR: dir },
  });
}

function taskLines(text) {
  return text.replace(/\n+$/, "");
}

function taskFromFollowup(message) {
  const headerEnd = message.indexOf("\n\n");
  if (headerEnd === -1) return message;
  return message.slice(headerEnd + 2);
}

function firstIteration(text) {
  const line = text.split("\n").find((l) => l.startsWith("iteration:"));
  if (!line) return null;
  const value = line.slice("iteration:".length).trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}

function phraseInTag(promise, response) {
  return (
    (promise === "word" && response === "exactTag") ||
    (promise === "quoted" && response === "quotedTag")
  );
}

function runCase({ iteration, max, promise, prompt, response }) {
  const dir = mkdtempSync(join(tmpdir(), "ralph-check-"));
  try {
    const statePath = join(dir, ".cursor/ralph/scratchpad.md");
    mkdirSync(join(dir, ".cursor/ralph"), { recursive: true });
    writeFileSync(statePath, scratchpad({ iteration, max, promise, prompt }));
    const captured = runHook(CAPTURE, JSON.stringify({ text: responseText[response] }), dir);
    if (captured.status !== 0) {
      throw new Error(`capture-response.sh exited ${captured.status}: ${captured.stderr}`);
    }
    const stopped = runHook(STOP, JSON.stringify({ status: "completed", loop_count: 0 }), dir);
    if (stopped.status !== 0) {
      throw new Error(`stop-hook.sh exited ${stopped.status}: ${stopped.stderr}`);
    }
    const exists = existsSync(statePath);
    let followup = null;
    const stdout = stopped.stdout.trim();
    if (stdout) {
      followup = JSON.parse(stdout).followup_message ?? null;
    }
    return {
      followup,
      deleted: !exists,
      iterationAfter: exists ? firstIteration(readFileSync(statePath, "utf8")) : null,
      stderr: stopped.stderr.trim(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function kindsFor(result, scenario) {
  const { iteration, max, promise, prompt, response } = scenario;
  const tag = phraseInTag(promise, response);
  const readable = prompt !== "corrupt";
  const blank = prompt === "blank";
  const under = max === 0 || iteration < max;
  const shouldFollow = readable && !blank && !tag && under;
  const kinds = [];
  if (result.followup != null) {
    if (tag) {
      kinds.push(
        promise === "quoted" && response === "quotedTag"
          ? "unrecognized-quoted-phrase"
          : "followup-after-phrase",
      );
    }
    if (!under) kinds.push("past-limit");
    if (!readable) kinds.push("followup-when-unreadable");
    if (blank) kinds.push("followup-when-blank");
    if (taskLines(taskFromFollowup(result.followup)) !== taskLines(storedTask(prompt))) {
      kinds.push("task-text-changed");
    }
    if (result.iterationAfter !== iteration + 1) kinds.push("count-not-advanced");
  } else if (shouldFollow) {
    if (promise === "word" && response === "bareWord") kinds.push("bare-phrase-stops");
    else if (prompt === "example") kinds.push("example-block-stops");
    else kinds.push("stopped-early");
  }
  return kinds;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureJar() {
  if (process.env.TLA2TOOLS && existsSync(process.env.TLA2TOOLS)) {
    const got = sha256(process.env.TLA2TOOLS);
    if (got !== TLC_SHA256) {
      throw new Error(`TLA2TOOLS is not tla2tools ${TLC_VERSION}: sha256 ${got}`);
    }
    return process.env.TLA2TOOLS;
  }
  if (!existsSync(JAR) || sha256(JAR) !== TLC_SHA256) {
    mkdirSync(dirname(JAR), { recursive: true });
    execFileSync("curl", ["-fsSL", "-o", JAR, TLC_URL], { stdio: "inherit" });
    const got = sha256(JAR);
    if (got !== TLC_SHA256) {
      rmSync(JAR, { force: true });
      throw new Error(`tla2tools ${TLC_VERSION} checksum mismatch: ${got}`);
    }
  }
  return JAR;
}

function runTlc(jar, invariants) {
  const dir = mkdtempSync(join(tmpdir(), "ralph-tlc-"));
  writeFileSync(join(dir, "RalphLoop.tla"), readFileSync(SPEC));
  const lines = [
    "SPECIFICATION Spec",
    ...invariants.map((name) => `INVARIANT ${name}`),
    "CONSTRAINT Bound",
    "",
  ];
  writeFileSync(join(dir, "check.cfg"), lines.join("\n"));
  const run = spawnSync(
    "java",
    [
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "1",
      "-metadir",
      join(dir, "meta"),
      "-config",
      "check.cfg",
      "RalphLoop",
    ],
    { encoding: "utf8", cwd: dir },
  );
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  rmSync(dir, { recursive: true, force: true });
  return { status: run.status, out };
}

function tlcViolated(out, name) {
  return out.includes(`Invariant ${name} is violated`);
}

function tlcClean(out) {
  return /Model checking completed. No error has been found/.test(out) && !/Error:/.test(out);
}

function sentence(kind, sample) {
  const where = `max_iterations ${sample.max}, promise ${sample.promise}, task ${sample.prompt}, reply ${sample.response}, iteration ${sample.iteration}`;
  if (kind === "unrecognized-quoted-phrase") {
    return `The reply put say "hi" inside a promise tag (${where}), and the stop hook sent the task again. The quote-strip in the hooks keeps the backslashes, so the phrase never matches. With the default unlimited limit this does not stop.`;
  }
  if (kind === "task-text-changed") {
    return `The stop hook sent another round (${where}), but a line that is only --- was dropped from the task text. The stored scratchpad still has it.`;
  }
  if (kind === "bare-phrase-stops") {
    return `The reply was the word COMPLETE with no promise tag (${where}), and the stop hook ended the loop and deleted the scratchpad. The tag is what the plugin says marks completion.`;
  }
  if (kind === "example-block-stops") {
    return `The task text contains an example scratchpad whose iteration line is inside --- fences (${where}). The opening iteration is still 1, under the limit, and the reply has no promise tag, but the stop hook treats the round count as corrupted and deletes the loop.`;
  }
  if (kind === "past-limit") {
    return `The stored round has reached the positive limit (${where}), and the stop hook sent the task again.`;
  }
  if (kind === "followup-after-phrase") {
    return `The reply put the completion phrase in a promise tag (${where}), and the stop hook sent the task again.`;
  }
  if (kind === "count-not-advanced") {
    return `The stop hook sent another round (${where}) without increasing the stored iteration by one.`;
  }
  if (kind === "stopped-early") {
    return `The stop hook ended the loop (${where}) while the round count was readable, the task text was not empty, the phrase was not in a tag, and the limit was not reached.`;
  }
  if (kind === "followup-when-unreadable") {
    return `The opening iteration is not a number (${where}), and the stop hook sent the task again.`;
  }
  if (kind === "followup-when-blank") {
    return `The task text is empty (${where}), and the stop hook sent the task again.`;
  }
  return `${kind} (${where})`;
}

function main() {
  const jar = ensureJar();
  const found = new Map();
  let cases = 0;
  for (const max of MAXES) {
    for (const promise of PROMISES) {
      for (const prompt of PROMPTS) {
        for (const response of RESPONSES) {
          const scenario = { iteration: 1, max, promise, prompt, response };
          const result = runCase(scenario);
          cases++;
          for (const kind of kindsFor(result, scenario)) {
            if (!found.has(kind)) found.set(kind, scenario);
          }
        }
      }
    }
  }

  const tlc = { violated: new Set(), held: new Set(), problems: [] };
  for (const name of FAILING_INVARIANTS) {
    const run = runTlc(jar, [name]);
    if (tlcViolated(run.out, name)) tlc.violated.add(name);
    else tlc.problems.push(`${name}: expected a violation, TLC did not report one.\n${run.out.trim().split("\n").slice(-15).join("\n")}`);
  }
  const held = runTlc(jar, HOLDING_INVARIANTS);
  if (tlcClean(held.out)) {
    for (const name of HOLDING_INVARIANTS) tlc.held.add(name);
  } else {
    for (const name of HOLDING_INVARIANTS) {
      if (tlcViolated(held.out, name)) tlc.violated.add(name);
    }
    if (![...HOLDING_INVARIANTS].some((name) => tlc.violated.has(name))) {
      tlc.problems.push(`Holding invariants did not check cleanly.\n${held.out.trim().split("\n").slice(-20).join("\n")}`);
    }
  }

  const realFailsPhrase = found.has("unrecognized-quoted-phrase") || found.has("followup-after-phrase");
  const realFailsText = found.has("task-text-changed");
  const realFailsHalt = found.has("bare-phrase-stops") || found.has("example-block-stops") || found.has("stopped-early");
  const realFailsLimit = found.has("past-limit");
  const realFailsCount = found.has("count-not-advanced");
  const realFailsReadable = found.has("followup-when-unreadable");
  const realFailsBlank = found.has("followup-when-blank");

  const disagree = [];
  const expect = [
    ["NoFollowupAfterPhrase", realFailsPhrase],
    ["FollowupKeepsTaskText", realFailsText],
    ["HaltOnlyForARealReason", realFailsHalt],
    ["NoFollowupPastLimit", realFailsLimit],
    ["FollowupCountsTheRound", realFailsCount],
    ["FollowupOnlyIfRoundCountReads", realFailsReadable],
    ["FollowupOnlyIfTaskPresent", realFailsBlank],
  ];
  for (const [name, realFails] of expect) {
    const modelFails = tlc.violated.has(name);
    if (modelFails !== realFails) {
      disagree.push(`${name}: TLC ${modelFails ? "fails" : "holds"}, the hooks ${realFails ? "fail" : "hold"}.`);
    }
  }

  const newKinds = [...found.keys()].filter((kind) => !KNOWN_KINDS.includes(kind));
  const goneKinds = KNOWN_KINDS.filter((kind) => !found.has(kind));

  console.log("Ralph loop check");
  console.log(`TLC ${TLC_VERSION} (${TLC_SHA256.slice(0, 12)})`);
  console.log(`Hooks ran ${cases} one-turn cases. Rounds in the model are bounded by ${BOUND_ROUNDS}.`);
  console.log("");
  if (found.size === 0) {
    console.log("The hooks meet the property in this bound.");
  } else {
    console.log("The hooks break the property in these ways:");
    let n = 1;
    for (const kind of [...KNOWN_KINDS, ...newKinds]) {
      if (!found.has(kind)) continue;
      const tag = KNOWN_KINDS.includes(kind) ? "known" : "new";
      console.log(`${n}. [${tag}] ${sentence(kind, found.get(kind))}`);
      n++;
    }
  }
  if (goneKinds.length) {
    console.log("");
    console.log("A known break no longer shows up:");
    for (const kind of goneKinds) console.log(`- ${kind}`);
  }
  console.log("");
  console.log(`TLC violations: ${[...tlc.violated].sort().join(", ") || "(none)"}`);
  console.log(`TLC holds: ${[...tlc.held].sort().join(", ") || "(none)"}`);
  if (disagree.length || tlc.problems.length) {
    console.log("");
    console.log("The model and the hooks disagree:");
    for (const line of [...disagree, ...tlc.problems]) console.log(`- ${line}`);
  }
  console.log("");
  const stable = newKinds.length === 0 && goneKinds.length === 0 && disagree.length === 0 && tlc.problems.length === 0;
  if (stable && found.size > 0) {
    console.log("No new break. The failures above are the ones recorded in SKILL.md.");
    process.exit(1);
  }
  if (stable && found.size === 0) {
    console.log("No break in this bound.");
    process.exit(0);
  }
  console.log("This run is not the recorded result. Read the new or missing lines above before trusting the model.");
  process.exit(2);
}

main();

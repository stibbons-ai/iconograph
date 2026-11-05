# Iconograph

Iconograph produces identity-preserving professional headshots of one person by iteratively generating, scoring and re-prompting image models.

## Inputs

**Subject**:
The one real person a Run depicts.
_Avoid_: User, model, person

**Reference Photo**:
A photo of the Subject supplied as input; a Run takes 1 to 8 of them.

**Identity Anchor**:
The Subject's reference face identity, derived from all accepted Reference Photos, against which every Candidate's likeness is measured.
_Avoid_: Reference embedding, centroid

**Target Look**:
The desired appearance of the headshot, expressed as fixed facets (pose, background, lighting and colour, hairstyle, clothing, framing); frozen for the lifetime of a Run.
_Avoid_: Style, spec, target spec

## Run structure

**Run**:
One attempt to produce a headshot of a Subject in a Target Look, ending with a Pick.
_Avoid_: Job, session, project

**Image Model**:
One specific image-generation model (not a vendor) that a Lane drives.
_Avoid_: Provider, generator, backend

**Lane**:
The part of a Run that optimizes Prompts for a single Image Model, with its own Prompt history; Lanes of a Run compete only at the Pick.
_Avoid_: Track, branch, provider run

**Iteration**:
One generate–score–rewrite cycle within a Lane: its Candidates are generated from one Prompt, scored and judged, then the Lane stops or the Optimizer writes the next Prompt.
_Avoid_: Round, step, epoch

**Stop Reason**:
Why a Lane stopped iterating: `cancelled`, `optimizer-failed` or `judge-failed` (the vendor turned the Optimizer's or Judge's call away for good with HTTP 401, 402, 403 or 404, e.g. a rejected key or no credit left, or with Google's 400 for a bad key; stored with the vendor's reason), `target-score`, `budget-exhausted` (a billable call didn't fit the Budget), `repeated-failures` (two Iterations in a row whose Candidates were all Refused or Failed), `patience` (too many Iterations without the best score rising enough) or `iteration-limit`; when several hold at once, the first in this order. A Lane's first recorded Stop Reason stands.
_Avoid_: Exit code, termination status

**Prompt**:
The text sent to an Image Model in an Iteration; it may rephrase the Target Look but never change it.
_Avoid_: Instruction

**Candidate**:
One attempt by an Image Model, within an Iteration, to produce a headshot (or a slot for one whose call didn't fit the Budget, so it was never made); it ends with exactly one Candidate Outcome.
_Avoid_: Output, result, sample

**Candidate Outcome**:
How a Candidate ended: **Refused** (the Image Model declined), **Failed** (errored after retries, its image was unusable, or its call or a retry didn't fit the Budget), **Gated** (no face, or below the Identity Gate) or **Scored** (passed the Identity Gate and has a Likeness; the Judge then scores it against the Rubric, and a judging that fails is recorded with it, never replaced by a made-up score).
_Avoid_: Status, state

**Character Reference**:
One of the accepted Reference Photos sent to an Image Model so it keeps the Subject's identity; an Image Model takes a limited number, declared per Image Model (Gemini 4, OpenAI 16), chosen per Lane.
_Avoid_: Reference image, input image

**Pick**:
The operator's final choice of Candidate(s) that concludes a Run.
_Avoid_: Selection, winner

## Scoring and steering

**Identity Gate**:
The minimum face-recognition similarity to the Identity Anchor, fixed per face model, below which a Candidate is Gated without further judgement; Likeness is 0 at the Gate, unless the Identity Ceiling is at or below the Gate, where reaching the Gate already scores 10.
_Avoid_: Threshold, face check

**Identity Ceiling**:
How alike the Subject's own Reference Photos are to each other; the point at which Likeness counts as perfect.
_Avoid_: Max similarity, target similarity

**Likeness**:
A Candidate's identity match to the Identity Anchor as measured by a face-recognition model, on a 0–10 scale: the raw cosine similarity scaled linearly from the Identity Gate (0) to the Identity Ceiling (10). Code keeps the raw value as `similarity`; in prose, say Likeness.
_Avoid_: ArcFace score, similarity, identity score

**Resemblance**:
The Judge's assessment of whether a Candidate is unmistakably the Subject; scored separately from Likeness.
_Avoid_: Judge identity, LLM identity

**Disputed**:
A Candidate whose Likeness and Resemblance disagree strongly.

**Likeness Unconfirmed**:
A finalist whose Likeness passes the loop's face model but not the held-out face model.

**Rubric**:
The versioned set of weighted criteria and anchored levels by which the Judge scores a Candidate.
_Avoid_: Scorecard, criteria

**Judge**:
The vision model that scores a Candidate against the Reference Photos and Target Look using the Rubric.
_Avoid_: Critic, evaluator, reviewer

**Playoff**:
The pairwise comparison among each Lane's best Candidates, judged in both orders, that ranks the finalists before the Pick.
_Avoid_: Tournament, final round

**Optimizer**:
The language model that writes a Lane's next Prompt from that Lane's own recent Iterations (Prompts, outcomes, scores, issues and fixes) and Steering, rephrasing the Target Look but never changing it.
_Avoid_: Rewriter, prompt engineer

**Steering**:
Operator input given while a Run is in progress (star, veto, score override, note) that the Optimizer considers at the next Iteration.
_Avoid_: Feedback, override

**Budget**:
The hard spending limit in USD for a single Run.
_Avoid_: Quota, cap

## Evaluation

**Arm**:
One strategy compared by the eval harness: per Subject and Image Model, each Arm gets one Run with the same Budget cap, Candidates per Iteration, Judge and stopping rules, except that the Resample Arm runs with patience off.
_Avoid_: Variant, baseline run

**Optimizer Arm**:
The Arm that runs the normal Lane loop, the Optimizer rewriting the Prompt between Iterations.

**Resample Arm**:
The Arm whose Lane sends its starting Prompt every Iteration and never calls the Optimizer: best-of-N sampling with the same Judge. It runs with patience off, since a fixed Prompt never tries to improve. A Lane run this way is a Resample Lane.
_Avoid_: Baseline, control

**Second Judge**:
The eval harness's Judge from another vendor than the loop's Judge, scoring every image of every Arm against the same Rubric without Likeness, outside the Budget.

**Judge Calibration**:
Measuring how well the Judge's ranking of Candidates agrees with the operator's Steering labels.
_Avoid_: Judge eval, alignment

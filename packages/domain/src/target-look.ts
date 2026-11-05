import { Effect, Schema } from "effect";

/**
 * One facet's text: non-empty, at most 500 characters, with no leading or
 * trailing whitespace (padded text is rejected, not trimmed).
 */
const Facet = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500));

/** The hairstyle default: keep the Subject's own hair rather than invent one. */
export const HAIRSTYLE_AS_IN_REFERENCE_PHOTOS = "as in the Reference Photos";

/**
 * The retouching of a Run stored before the `retouching` facet existed (ADR
 * 0015): those Runs were generated and judged without any retouching.
 */
export const NO_RETOUCHING = "none";

/**
 * Defaults for every facet, so a Run works without writing any text: a neutral
 * corporate headshot that keeps the Subject's own hair, with the light
 * retouching a good portrait photographer delivers (ADR 0015).
 */
export const DEFAULT_TARGET_LOOK = {
  pose: "facing the camera with shoulders turned slightly, relaxed and confident, natural friendly expression",
  background: "plain light-grey studio backdrop, evenly lit, slightly out of focus",
  lighting:
    "soft, even studio key light with gentle fill, natural true-to-life skin tones and colour",
  hairstyle: HAIRSTYLE_AS_IN_REFERENCE_PHOTOS,
  clothing: "smart business attire: a dark blazer over a plain light shirt",
  framing: "head-and-shoulders portrait, eyes in the upper third, centred",
  retouching:
    "natural professional retouching, as a good portrait photographer would deliver: the Subject looks their real age as in the Reference Photos, never older or younger; fine lines, under-eye shadows, redness and blemishes softened but not removed; real skin texture kept; teeth clean and a shade or two brighter while keeping their natural ivory tone, slight shade differences and translucency, never uniform or bright white; someone meeting them in person would not suspect editing",
} as const;

/**
 * The desired appearance of the headshot (GLOSSARY "Target Look"), one text per
 * fixed facet. `lighting` covers lighting and colour; `retouching` how far the
 * Subject's skin and teeth may be retouched. A Run stores the decoded value
 * when it starts and never changes it; a stored Run without `retouching`
 * (stored before the facet existed) reads as `NO_RETOUCHING`.
 */
export const TargetLook = Schema.Struct({
  pose: Facet,
  background: Facet,
  lighting: Facet,
  hairstyle: Facet,
  clothing: Facet,
  framing: Facet,
  retouching: Facet.pipe(Schema.withDecodingDefaultKey(Effect.succeed(NO_RETOUCHING))),
});
export type TargetLook = typeof TargetLook.Type;

const withDefault = (facet: keyof TargetLook) =>
  Facet.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_TARGET_LOOK[facet])));

/** What the operator writes: any facet left out takes its default. */
export const TargetLookInput = Schema.Struct({
  pose: withDefault("pose"),
  background: withDefault("background"),
  lighting: withDefault("lighting"),
  hairstyle: withDefault("hairstyle"),
  clothing: withDefault("clothing"),
  framing: withDefault("framing"),
  retouching: withDefault("retouching"),
});
export type TargetLookInput = typeof TargetLookInput.Encoded;

/**
 * Target Look facets as the Judge and the Optimizer read them: the facet
 * criteria in the Rubric's order, then `retouching`, which has no criterion
 * of its own (the Judge weighs it through Resemblance and Realism).
 */
const facetLabels: { readonly [F in keyof TargetLook]: string } = {
  pose: "Pose",
  background: "Background",
  lighting: "Lighting and colour",
  hairstyle: "Hairstyle",
  clothing: "Clothing",
  framing: "Framing",
  retouching: "Retouching",
};

/**
 * The Target Look for a language model: one facet per line, each a JSON
 * string, so facet text (operator input) can't break out of its line or pose
 * as further instructions.
 */
export function quotedTargetLook(look: TargetLook): string {
  return (Object.keys(facetLabels) as (keyof TargetLook)[])
    .map((facet) => `${facetLabels[facet]}: ${JSON.stringify(look[facet])}`)
    .join("\n");
}

/** The longest Prompt a Lane takes: OpenAI's image edit limit (32,000 characters). */
export const MAX_PROMPT_LENGTH = 32_000;

/**
 * The first Prompt of a Lane, built only from the Target Look. It refers to the
 * attached Reference Photos for identity and states every facet as written, so
 * a later Optimizer can rephrase it without changing the look.
 */
export function initialPrompt(look: TargetLook): string {
  const hairstyle =
    look.hairstyle === HAIRSTYLE_AS_IN_REFERENCE_PHOTOS
      ? "exactly the same hairstyle, hair colour and hairline as in the reference photos"
      : look.hairstyle;
  return [
    "A photorealistic professional headshot of the person shown in the attached reference photos.",
    "Keep their identity exactly: the same facial features, face shape, proportions, skin tone, age and any distinctive marks, and the same beard and hair colour, including any grey. Retouching never changes these; it may only soften what the Retouching line below allows.",
    `Pose: ${look.pose}.`,
    `Hairstyle: ${hairstyle}.`,
    `Clothing: ${look.clothing}.`,
    `Background: ${look.background}.`,
    `Lighting and colour: ${look.lighting}.`,
    `Framing: ${look.framing}.`,
    `Retouching: ${look.retouching}.`,
    "A single photograph with sharp focus on the eyes; no text, watermark, border or collage.",
  ].join("\n");
}

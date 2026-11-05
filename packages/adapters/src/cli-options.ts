import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_CANDIDATES,
  DEFAULT_JUDGE,
  DEFAULT_OPTIMIZER,
  DEFAULT_STOP_RULES,
  GEMINI_IMAGE_MODEL,
  OPENAI_FLARE_IMAGE_MODEL,
  OPENAI_IMAGE_MODEL,
} from "@iconograph/domain";
import { errorMessage } from "./errors";

/** The repository checkout the commands run from: the folder holding `packages/`. */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The Image Models a Lane can drive, by the name the command lines take. */
export const LANE_IMAGE_MODELS: Readonly<Record<string, string>> = {
  gemini: GEMINI_IMAGE_MODEL,
  openai: OPENAI_IMAGE_MODEL,
  "openai:sunburst": OPENAI_IMAGE_MODEL,
  "openai:flare": OPENAI_FLARE_IMAGE_MODEL,
};

/** The Image Model of Lane name `name`; an unknown name is an error prefixed with `what`. */
export function laneImageModel(name: string, what: string): string {
  if (!Object.hasOwn(LANE_IMAGE_MODELS, name)) {
    throw new Error(
      `${what}: unknown Lane ${name}; use one of ${Object.keys(LANE_IMAGE_MODELS).join(", ")}`,
    );
  }
  return LANE_IMAGE_MODELS[name]!;
}

/** A command-line option's number; anything else (blank, not finite) names the option. */
export function parseNumberOption(option: string, value: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) {
    throw new Error(`${option} expects a number, got ${value}`);
  }
  return number;
}

/** `decode(value)` for a command-line input; its error is prefixed with `what`, the input it came from. */
export function decodeOption<A>(what: string, decode: (value: unknown) => A, value: unknown): A {
  try {
    return decode(value);
  } catch (error) {
    throw new Error(`${what}: ${errorMessage(error)}`);
  }
}

/** A JSON file given to a command, decoded; errors name it as `what`. */
export async function readJsonFile<A>(
  path: string,
  what: string,
  decode: (json: unknown) => A,
): Promise<A> {
  let json: unknown;
  try {
    json = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`${what} is not a readable JSON file: ${errorMessage(error)}`);
  }
  return decodeOption(what, decode, json);
}

/** The `parseArgs` options every command that starts Runs takes (`bun run run`, `bun run eval`). */
export const RUN_SETTING_OPTIONS = {
  budget: { type: "string" },
  candidates: { type: "string" },
  "judge-model": { type: "string" },
  "judge-effort": { type: "string" },
  "optimizer-model": { type: "string" },
  "optimizer-effort": { type: "string" },
  "target-score": { type: "string" },
  patience: { type: "string" },
  "min-improvement": { type: "string" },
  "max-iterations": { type: "string" },
} as const;

export type RunSettingValues = { readonly [K in keyof typeof RUN_SETTING_OPTIONS]?: string };

/**
 * A Run's settings from the command line, each at its default when not given,
 * numbers parsed, otherwise undecoded: the Run request's schemas check them
 * (Budget, Candidates, Judge, Optimizer, stopping rules).
 */
export function runSettingsInput(values: RunSettingValues) {
  const number = (name: keyof RunSettingValues, fallback: number) => {
    const value = values[name];
    return value === undefined ? fallback : parseNumberOption(`--${name}`, value);
  };
  return {
    budgetUsd: number("budget", DEFAULT_BUDGET_USD),
    candidates: number("candidates", DEFAULT_CANDIDATES),
    judge: {
      model: values["judge-model"] ?? DEFAULT_JUDGE.model,
      effort: values["judge-effort"] ?? DEFAULT_JUDGE.effort,
      weights: DEFAULT_JUDGE.weights,
    },
    optimizer: {
      model: values["optimizer-model"] ?? DEFAULT_OPTIMIZER.model,
      effort: values["optimizer-effort"] ?? DEFAULT_OPTIMIZER.effort,
    },
    stopRules: {
      targetScore: number("target-score", DEFAULT_STOP_RULES.targetScore),
      patience: number("patience", DEFAULT_STOP_RULES.patience),
      minImprovement: number("min-improvement", DEFAULT_STOP_RULES.minImprovement),
      maxIterations: number("max-iterations", DEFAULT_STOP_RULES.maxIterations),
    },
  };
}

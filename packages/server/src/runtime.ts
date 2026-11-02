import type { RunStore } from "@iconograph/adapters";
import type { FaceEmbedder, ImageModels } from "@iconograph/domain";
import type { RunConfig } from "./run-steps";

/** The services every Run step program runs with; tests swap in fakes via Layers. */
export type RunServices = FaceEmbedder | ImageModels | RunStore | RunConfig;

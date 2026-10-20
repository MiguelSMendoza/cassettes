import { buildPlan } from "../domain/planner";
import type { Occurrence, PlanConfig } from "../domain/types";
self.onmessage = (
  event: MessageEvent<{ tracks: Occurrence[]; config: PlanConfig }>,
) => {
  try {
    self.postMessage({
      plan: buildPlan(event.data.tracks, event.data.config, 1500),
    });
  } catch (e) {
    self.postMessage({
      error: e instanceof Error ? e.message : "No se pudo organizar.",
    });
  }
};

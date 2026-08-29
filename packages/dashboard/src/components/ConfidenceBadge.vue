<script setup lang="ts">
import { computed } from "vue";
import type { ConfidenceEntry, ConfidenceStage } from "@fleet/shared";
import { Badge } from "@/components/ui/badge/index.ts";

const props = defineProps<{
  entry: ConfidenceEntry;
  showStage?: boolean;
}>();

const STAGE_NAMES: Record<ConfidenceStage, string> = {
  triage: "Triage",
  plan: "Plan",
  code: "Code",
  "machine-review": "Review",
  "plan-review": "Plan review",
};

const stageName = computed(() => STAGE_NAMES[props.entry.stage] ?? props.entry.stage);

/**
 * The colour rule lives here and nowhere else. `threshold === null` means the
 * stage was recorded but never gated on a number, so there is no bar it can be
 * said to have missed — it must not read as a failure. An overridden score
 * passed its gate only because a human said so, so it reads as a pass but
 * carries the `*` marker below so it can't be confused with an ordinary one.
 */
const variant = computed(() => {
  if (props.entry.threshold === null) return "muted" as const;
  if (props.entry.overridden) return "success" as const;
  return props.entry.score >= props.entry.threshold ? ("success" as const) : ("destructive" as const);
});

/** Built as one string rather than adjacent template nodes, which the compiler strips the separating whitespace from. */
const label = computed(
  () => `${props.showStage ? `${stageName.value} ` : ""}${props.entry.score}%${props.entry.overridden ? "*" : ""}`,
);

const title = computed(() => {
  const { score, threshold, overridden } = props.entry;
  if (threshold === null) return `${stageName.value} confidence ${score}% (not gated)`;
  const comparison = `${stageName.value} confidence ${score}% vs threshold ${threshold}%`;
  if (overridden) return `${comparison} — carried past the gate by an override`;
  return score >= threshold ? `${comparison} — passed` : `${comparison} — below threshold`;
});
</script>

<template>
  <Badge :variant="variant" :title="title">
    {{ label }}
  </Badge>
</template>

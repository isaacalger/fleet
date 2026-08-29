<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { connectBoardSocket, fetchTriage, investigateIssue, type TriageProjectGroup } from "../lib/api.ts";
import { usePolledResource } from "../composables/usePolledResource.ts";

const groups = ref<TriageProjectGroup[]>([]);
/** Rows already handed to the daemon this session — the label only shows up on the board a poll cycle later. */
const queued = ref(new Set<string>());
const investigating = ref(new Set<string>());
const errors = ref(new Map<string, string>());

/** Only projects with something to say get a heading; an all-empty response renders nothing at all. */
const visible = computed(() => groups.value.filter((g) => g.issues.length > 0 || g.error));

function key(project: string, issueNumber: number): string {
  return `${project}#${issueNumber}`;
}

function excerpt(body: string): string {
  const text = body.trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function load(isStale: () => boolean) {
  try {
    const res = await fetchTriage();
    if (isStale()) return;
    groups.value = res.projects;
  } catch {
    // A failed panel fetch stays silent: triage is supplementary, and the board
    // already surfaces daemon connectivity problems.
  }
}

const poll = usePolledResource(load, 60000);

const disconnect = connectBoardSocket(
  (type) => {
    if (type === "board-updated") void poll.refresh();
  },
  () => {},
);
onUnmounted(disconnect);

async function investigate(project: string, issueNumber: number) {
  const id = key(project, issueNumber);
  if (investigating.value.has(id) || queued.value.has(id)) return;
  investigating.value = new Set(investigating.value).add(id);
  const nextErrors = new Map(errors.value);
  nextErrors.delete(id);
  errors.value = nextErrors;
  try {
    await investigateIssue(project, issueNumber);
    queued.value = new Set(queued.value).add(id);
    // No `board-updated` ping follows an investigate, so refetch here.
    await poll.refresh();
  } catch (err) {
    errors.value = new Map(errors.value).set(id, err instanceof Error ? err.message : String(err));
  } finally {
    const next = new Set(investigating.value);
    next.delete(id);
    investigating.value = next;
  }
}
</script>

<template>
  <section v-if="visible.length > 0" class="shrink-0 space-y-3 rounded border bg-card p-3" aria-label="Triage">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Triage</h2>

    <section v-for="group in visible" :key="group.project" data-testid="triage-project" class="space-y-1.5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ group.project }}</h3>

      <p v-if="group.error" class="text-xs text-destructive">{{ group.error }}</p>

      <ul v-else class="space-y-1.5">
        <li
          v-for="issue in group.issues"
          :key="issue.number"
          data-testid="triage-issue"
          class="flex items-start gap-2 rounded border px-2 py-1.5 text-xs"
        >
          <span class="min-w-0 flex-1">
            <a :href="issue.url" target="_blank" rel="noopener" class="font-medium text-primary hover:underline"
              >#{{ issue.number }} {{ issue.title }}</a
            >
            <span class="ml-1.5 text-muted-foreground">{{ issue.author }}</span>
            <span v-if="issue.labels.length > 0" class="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
              <span v-for="label in issue.labels" :key="label" class="rounded bg-muted px-1 text-muted-foreground">{{
                label
              }}</span>
            </span>
            <span v-if="issue.body.trim()" class="mt-0.5 block text-muted-foreground">{{ excerpt(issue.body) }}</span>
            <span v-if="errors.get(key(group.project, issue.number))" class="mt-0.5 block text-destructive">{{
              errors.get(key(group.project, issue.number))
            }}</span>
          </span>
          <button
            type="button"
            data-testid="triage-investigate"
            class="shrink-0 rounded border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            :disabled="queued.has(key(group.project, issue.number)) || investigating.has(key(group.project, issue.number))"
            @click="investigate(group.project, issue.number)"
          >
            {{
              queued.has(key(group.project, issue.number))
                ? "Queued"
                : investigating.has(key(group.project, issue.number))
                  ? "Queueing…"
                  : "Investigate"
            }}
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>

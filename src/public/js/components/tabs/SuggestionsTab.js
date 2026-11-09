import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { router } from '../../lib/router.js';

const AREA_LABELS = { logic: 'Logic', frontend: 'Frontend', infra: 'Infra', security: 'Security', dx: 'DX' };

function parsedJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export default {
  name: 'SuggestionsTab',
  data() {
    return {
      row:          null,
      loading:      false,
      error:        null,
      acceptBanner: null,
      passes:       1,
      selected:     {},
      openSections: { 'New Features': true, 'Enhancements': true, 'UI Improvements': false, Other: true },
      aiUsed:       null,
      typeOverride: null,
      goal:         '',
      areas:        [],
      noLm:         false,
      areaOptions:  ['logic', 'frontend', 'infra', 'security', 'dx'],
    };
  },
  computed: {
    name() { return router.project; },
    scanning()  { return !!store.state.busy['sugg-scan:' + this.name]; },
    accepting() { return !!store.state.busy['sugg-accept:' + this.name]; },
    mutationLockReason() { return store.projectMutationLockReason(this.name); },
    mutationLocked() { return !!this.mutationLockReason; },
    snapshot()    { return this.row ? parsedJson(this.row.scan_snapshot_json, {}) : null; },
    suggestions() {
      const value = this.row ? parsedJson(this.row.suggestions_json, []) : [];
      return Array.isArray(value) ? value : [];
    },
    acceptedPlan() {
      if (!this.row || this.row.status !== 'accepted') return null;
      const selected = parsedJson(this.row.selected_json, []);
      const plan = parsedJson(this.row.pipeline_plan_json, {});
      return {
        selected: Array.isArray(selected) ? selected : [],
        plan: plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {},
        passes:   this.row.pipeline_passes,
      };
    },
    sections() {
      const typeMap = {
        'New Features':    (s) => s.type === 'new-feature',
        'Enhancements':    (s) => ['enhancement', 'perf', 'security', 'dx'].includes(s.type),
        'UI Improvements': (s) => s.type === 'ui-improvement',
        'Other':            (s) => !['new-feature', 'enhancement', 'perf', 'security', 'dx', 'ui-improvement'].includes(s.type),
      };
      return Object.entries(typeMap)
        .map(([label, filter]) => ({ label, items: this.suggestions.filter(filter) }))
        .filter((s) => s.items.length > 0);
    },
    selectedItems() {
      return this.suggestions.filter((s) => this.selected[s.id]);
    },
    pipelinePlan() {
      const plan = {};
      for (let p = 1; p <= this.passes; p++) plan[String(p)] = [];
      for (const s of this.selectedItems) {
        const suggested = Number(s.suggestedSlot);
        const slot = this.passes === 1
          ? 1
          : Math.max(1, Math.min(Number.isFinite(suggested) ? Math.trunc(suggested) : 1, this.passes));
        plan[String(slot)].push(s.id);
      }
      return plan;
    },
    slotPreview() {
      if (this.passes === 1) return [];
      return Object.entries(this.pipelinePlan)
        .map(([pass, ids]) => ({
          pass: Number(pass),
          titles: ids.map((id) => this.selectedItems.find((s) => s.id === id)?.title ?? id),
        }))
        .filter((p) => p.titles.length > 0);
    },
  },
  watch: {
    name: {
      immediate: true,
      handler(name, old) {
        if (!name || name === old) return;
        this.row = null;
        this.acceptBanner = null;
        this.typeOverride = null;
        this.loadSuggestions();
      },
    },
  },
  methods: {
    areaLabel(area) { return AREA_LABELS[area] || area; },
    effortBadge(effort) { return { small: 'S', medium: 'M', large: 'L' }[effort] ?? '?'; },
    impactBadge(impact) { return { low: '↑', medium: '↑↑', high: '↑↑↑' }[impact] ?? '?'; },
    toggleSection(label) { this.openSections[label] = !this.openSections[label]; },
    toggleItem(id) {
      this.selected = { ...this.selected, [id]: !this.selected[id] };
    },
    toggleArea(area) {
      const i = this.areas.indexOf(area);
      if (i >= 0) this.areas.splice(i, 1);
      else this.areas.push(area);
    },
    async loadSuggestions() {
      const name = this.name;
      if (!name) return;
      this.error = null;
      this.loading = true;
      try {
        const row = await api('GET', '/projects/' + encodeURIComponent(name) + '/suggestions');
        if (this.name !== name) return; // stale response after navigation
        this.row = row;
        this.selected = {};
        this.aiUsed = null;
      } catch (err) {
        if (this.name === name) this.error = err.message;
      } finally {
        if (this.name === name) this.loading = false;
      }
    },
    async scan() {
      const name = this.name;
      const initialLock = store.projectMutationLockReason(name);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project: name });
        return;
      }
      const overwritesSelection = this.selectedItems.length > 0;
      if (overwritesSelection || !this.noLm) {
        const yes = await store.confirmAction({
          title: overwritesSelection ? 'Replace this suggestion draft?' : 'Run AI suggestion scan?',
          body: [
            overwritesSelection ? `Your ${this.selectedItems.length} current selection(s) will be cleared when the new draft succeeds.` : '',
            !this.noLm ? 'This scan makes a provider call and consumes billing-window capacity.' : '',
          ].filter(Boolean).join('\n\n'),
          confirmLabel: 'Scan workspace',
        });
        if (!yes || this.name !== name) return;
      }
      const lockReason = await store.revalidateProjectMutationLock(name);
      if (this.name !== name) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project: name });
        return;
      }
      this.acceptBanner = null;
      this.error = null;
      const body = {
        goal: this.goal,
        areas: this.areas,
        typeOverride: this.typeOverride || undefined,
        noLm: this.noLm || undefined,
      };
      const r = await store.act('sugg-scan:' + name, 'POST',
        '/projects/' + encodeURIComponent(name) + '/suggestions/scan-ai', body,
        { errPrefix: 'Scan' });
      if (r && this.name === name) {
        this.row = r;
        this.aiUsed = r?.aiUsed ?? null;
        this.selected = {};
      }
    },
    async replan() {
      const name = this.name;
      const initialLock = store.projectMutationLockReason(name);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project: name });
        return;
      }
      const yes = await store.confirmAction({
        title: 'Replace the accepted suggestion plan?',
        body: 'A successful scan will supersede the accepted plan.' +
          (this.noLm ? '' : '\n\nThis scan makes a provider call and consumes billing-window capacity.'),
        confirmLabel: 'Re-plan',
      });
      if (!yes || this.name !== name) return;
      const lockReason = await store.revalidateProjectMutationLock(name);
      if (this.name !== name) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project: name });
        return;
      }
      this.acceptBanner = null;
      this.error = null;
      this.typeOverride = null;
      const r = await store.act('sugg-scan:' + name, 'POST',
        '/projects/' + encodeURIComponent(name) + '/suggestions/rerun',
        { goal: this.goal, areas: this.areas, noLm: this.noLm || undefined },
        { errPrefix: 'Re-plan' });
      if (r && this.name === name) {
        this.row = r;
        this.aiUsed = r?.aiUsed ?? null;
        this.selected = {};
      }
    },
    async acceptPlan() {
      if (!this.selectedItems.length) return;
      const name = this.name;
      const initialLock = store.projectMutationLockReason(name);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project: name });
        return;
      }
      const lockReason = await store.revalidateProjectMutationLock(name);
      if (this.name !== name) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project: name });
        return;
      }
      const passes = this.passes;
      this.error = null;
      this.acceptBanner = null;
      const r = await store.act('sugg-accept:' + name, 'POST',
        '/projects/' + encodeURIComponent(name) + '/suggestions/accept',
        { id: this.row.id, selected: this.selectedItems, pipelinePasses: passes },
        { errPrefix: 'Accept' });
      if (r && this.name === name) {
        this.row = r;
        const selected = parsedJson(r?.selected_json, []);
        const reconciledCount = Array.isArray(selected) ? selected.length : 0;
        this.acceptBanner = { count: reconciledCount, passes };
      }
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-3)">

      <!-- Loading (initial fetch) -->
      <template v-if="loading && !row">
        <div class="skeleton" style="height: 96px"></div>
        <div class="skeleton" style="height: 120px"></div>
        <div class="skeleton" style="height: 120px"></div>
      </template>

      <template v-else>

        <!-- Load error banner -->
        <div v-if="error" class="banner banner-err">
          {{ error }}
          <button class="btn btn-sm right" @click="loadSuggestions">Retry</button>
        </div>

        <!-- Accept success banner -->
        <div v-if="acceptBanner" class="banner banner-ok">
          Plan saved — {{ acceptBanner.count }} items across {{ acceptBanner.passes }} pass{{ acceptBanner.passes > 1 ? 'es' : '' }}.
        </div>

        <!-- AI fallback notice -->
        <div v-if="aiUsed === false" class="banner banner-warn">
          AI unavailable — showing rules-based suggestions.
        </div>

        <!-- Long-running scan notice -->
        <div v-if="scanning" class="banner banner-info">
          <span class="spinner"></span> Scanning workspace…
        </div>

        <!-- Scan options: visible in all states so goal/areas persist across scan/replan -->
        <div class="card col" style="gap: var(--sp-2)">
          <span class="card-title">Scan options</span>
          <input v-model="goal" type="text" maxlength="500" class="input" style="max-width: 480px"
                 placeholder="What are you building towards? (optional)" aria-label="Scan goal">
          <div class="row-wrap">
            <button v-for="area in areaOptions" :key="area" type="button" class="chip"
                    :aria-pressed="areas.includes(area) ? 'true' : 'false'"
                    :style="areas.includes(area)
                      ? 'border-color: var(--accent); color: var(--accent); background: var(--accent-soft)'
                      : ''"
                    @click="toggleArea(area)">
              {{ areaLabel(area) }}
            </button>
          </div>
          <label class="checkbox xs">
            <input type="checkbox" v-model="noLm">
            Rules only (no AI, no billing)
          </label>
        </div>

        <!-- Accepted read-only summary card -->
        <template v-if="acceptedPlan">
          <div class="card">
            <div class="card-header">
              <span class="card-title">Accepted plan</span>
              <button class="btn btn-sm right" :disabled="scanning || mutationLocked" @click="replan"
                      :title="mutationLockReason || 'Replace the accepted plan'">
                <span v-if="scanning" class="spinner"></span>
                {{ scanning ? 'Scanning…' : 'Re-plan' }}
              </button>
            </div>
            <div class="col" style="gap: 4px">
              <div v-for="p in acceptedPlan.passes" :key="p" class="small">
                <span class="muted">Pass {{ p }}:</span>
                {{ (acceptedPlan.plan[String(p)] || [])
                   .map(id => acceptedPlan.selected.find(s => s.id === id)?.title ?? id)
                   .join(', ') || '(empty)' }}
              </div>
            </div>
          </div>
        </template>

        <!-- No row yet: prompt scan -->
        <template v-else-if="!row">
          <div class="card">
            <div class="empty">
              <span class="empty-icon">💡</span>
              <span>No suggestions yet for this project.</span>
              <span class="empty-hint">Scan the workspace to generate improvement ideas.</span>
              <button class="btn btn-primary" :disabled="scanning || mutationLocked" @click="scan"
                      :title="mutationLockReason || 'Scan workspace'">
                <span v-if="scanning" class="spinner"></span>
                {{ scanning ? 'Scanning…' : 'Scan workspace' }}
              </button>
            </div>
          </div>
        </template>

        <!-- Draft row: full UI -->
        <template v-else>

          <!-- Scan summary row -->
          <div class="card row-wrap">
            <span class="badge" style="--badge-c: var(--accent)">
              {{ snapshot && snapshot.projectType ? snapshot.projectType : '?' }}
            </span>
            <span class="small">{{ snapshot && snapshot.completedPhases != null ? snapshot.completedPhases : 0 }} phases</span>
            <span v-if="snapshot && snapshot.phaseTitles && snapshot.phaseTitles[0]"
                  class="xs muted truncate" style="max-width: 200px">
              last: “{{ snapshot.phaseTitles[0] }}”
            </span>
            <button class="btn btn-sm right" :disabled="scanning || mutationLocked" @click="scan"
                    :title="mutationLockReason || 'Scan workspace again'">
              {{ scanning ? '…' : 'Re-scan' }}
            </button>
          </div>

          <!-- Type override when projectType is unknown -->
          <div v-if="snapshot && snapshot.projectType === 'unknown'"
               class="banner banner-warn" style="flex-direction: column; align-items: flex-start">
            <span class="bold">⚠ Project type not detected</span>
            <div class="row-wrap">
              <label class="xs" for="sug-type-override">Type:</label>
              <select id="sug-type-override" v-model="typeOverride" class="select" style="width: auto">
                <option :value="null">— pick one —</option>
                <option value="cli">CLI tool</option>
                <option value="frontend">Frontend</option>
                <option value="api">API / Backend</option>
                <option value="fullstack">Fullstack</option>
              </select>
              <button v-if="typeOverride" class="btn btn-primary btn-sm" :disabled="scanning || mutationLocked" @click="scan"
                      :title="mutationLockReason || 'Scan workspace with this type'">
                Re-scan with type
              </button>
            </div>
          </div>

          <!-- Suggestion sections -->
          <div v-for="section in sections" :key="section.label" class="card" style="padding: 0; overflow: hidden">
            <button type="button" class="row" style="width: 100%; padding: 10px 14px; text-align: left"
                    :aria-expanded="openSections[section.label] ? 'true' : 'false'"
                    @click="toggleSection(section.label)">
              <span class="card-title" style="margin: 0">{{ section.label }}</span>
              <span class="xs bold" style="color: var(--accent)">{{ section.items.length }}</span>
              <span class="xs muted right">{{ openSections[section.label] ? '▲' : '▼' }}</span>
            </button>
            <div v-show="openSections[section.label]">
              <label v-for="s in section.items" :key="s.id" class="checkbox"
                     style="align-items: flex-start; padding: 10px 14px; border-top: 1px solid var(--border)">
                <input type="checkbox" :checked="!!selected[s.id]" @change="toggleItem(s.id)" style="margin-top: 3px">
                <span class="grow">
                  <span class="row-wrap">
                    <span class="small bold" style="color: var(--text)">{{ s.title }}</span>
                    <span class="chip mono" :title="'Effort: ' + s.effort">{{ effortBadge(s.effort) }}</span>
                    <span class="xs" style="color: var(--accent)" :title="'Impact: ' + s.impact">{{ impactBadge(s.impact) }}</span>
                  </span>
                  <span class="xs muted" style="display: block; margin-top: 2px">{{ s.description }}</span>
                </span>
              </label>
            </div>
          </div>

          <!-- Empty state when nothing generated -->
          <div v-if="sections.length === 0" class="card">
            <div class="empty">
              <span class="empty-icon">💡</span>
              <span>No suggestions generated.</span>
              <span class="empty-hint">Try re-scanning.</span>
            </div>
          </div>

          <!-- Pipeline passes segmented control -->
          <div v-if="sections.length > 0" class="card col" style="gap: var(--sp-2)">
            <span class="label">Pipeline passes</span>
            <div class="row">
              <button v-for="n in [1, 2, 3]" :key="n" class="btn btn-sm"
                      :class="{ 'btn-primary': passes === n }"
                      :aria-pressed="passes === n ? 'true' : 'false'"
                      @click="passes = n">
                {{ n }}x
              </button>
            </div>
            <div v-if="passes > 1 && slotPreview.length > 0" class="col" style="gap: 2px">
              <div v-for="p in slotPreview" :key="p.pass" class="xs">
                <span class="muted">Pass {{ p.pass }}:</span>
                <span class="dim"> {{ p.titles.join(', ') }}</span>
              </div>
            </div>
          </div>

          <!-- Accept plan -->
          <button v-if="sections.length > 0" class="btn btn-primary" style="width: 100%"
                  :disabled="accepting || mutationLocked || selectedItems.length === 0"
                  :title="mutationLockReason || 'Save this pipeline plan'"
                  @click="acceptPlan">
            <span v-if="accepting" class="spinner"></span>
            {{ accepting ? 'Saving…' : 'Accept Plan (' + selectedItems.length + ' items)' }}
          </button>

        </template>

      </template>

    </div>
  `,
};

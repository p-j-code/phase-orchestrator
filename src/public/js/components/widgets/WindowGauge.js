// 5-hour billing window gauge. Full mode: prominent card (dashboard).
// Compact mode: single slim row (project overview). Reads store.state.windowInfo —
// exact keys from billing-guard windowStatus(): {state, callsInWindow (weighted
// admission units), rawCallsInWindow (actual subprocess attempts), windowHours,
// warnThreshold, pauseThreshold, warnCostThreshold, pauseCostThreshold,
// totalCostInWindow, oldestCallAt}. null → /api/window failed or not loaded yet.

import { store } from '../../lib/store.js';
import { fmtMoney, fmtAgo, fmtUntil, pct, statusMeta } from '../../lib/format.js';

export default {
  name: 'WindowGauge',
  props: {
    compact: { type: Boolean, default: false },
  },
  computed: {
    w() { return store.state.windowInfo; },
    error() { return store.state.windowError; },
    now() { return store.state.now; },
    meta() { return statusMeta((this.w && this.w.state) || 'ok'); },
    // statusMeta already maps pause→err / warn→warn / ok→ok — reuse it.
    color() { return this.meta.color; },
    fillPct() {
      return this.w ? pct(this.w.callsInWindow, this.w.pauseThreshold) : 0;
    },
    rawCalls() {
      if (!this.w) return 0;
      return this.w.rawCallsInWindow ?? this.w.callsInWindow ?? 0;
    },
    // Phase 63 (P7) — "+3 units (12 attempts) reclaim in 48m", built from
    // windowStatus().reclaim. Legacy snapshots without `units` remain valid.
    // (billing-guard's summarizeReclaim). null when nothing ages out soon, so the
    // template row simply doesn't render (legacy windowInfo without reclaim too).
    reclaimLine() {
      const r = this.w && this.w.reclaim;
      if (!r || !r.next || !r.count) return null;
      const units = r.units ?? r.count;
      return `+${units} unit${units === 1 ? '' : 's'} (${r.count} attempt${r.count === 1 ? '' : 's'}) reclaim in ${fmtUntil(r.next, this.now)}`;
    },
  },
  methods: {
    fmtMoney, fmtAgo,
    refresh() { store.loadWindow(); },
  },
  // compact + no data → render nothing (falls through all branches)
  template: `
    <div v-if="compact && error" class="banner banner-err">
      <span class="grow">Usage unavailable: {{ error }}</span>
      <button class="btn btn-sm" @click="refresh">Retry</button>
    </div>

    <div v-else-if="compact && w" class="row">
      <span class="label nowrap">5h window</span>
      <div class="progress" role="progressbar" aria-label="Five-hour usage"
           aria-valuemin="0" :aria-valuemax="w.pauseThreshold" :aria-valuenow="w.callsInWindow">
        <div class="progress-fill" :style="{ width: fillPct + '%', '--fill-c': color }"></div>
      </div>
      <span class="mono xs nowrap" :style="{ color: color }">{{ w.callsInWindow }}/{{ w.pauseThreshold }}u · {{ rawCalls }}a</span>
      <span class="badge" :style="{ '--badge-c': meta.color }">{{ meta.label }}</span>
    </div>

    <div v-else-if="!compact && error" class="card">
      <div class="card-header"><span class="card-title">5-hour window</span></div>
      <div class="banner banner-err">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-sm" @click="refresh">Retry</button>
      </div>
    </div>

    <div v-else-if="!compact && !w" class="card">
      <div class="card-header">
        <span class="card-title">5-hour window</span>
      </div>
      <div class="skeleton" style="height: 24px; width: 45%"></div>
      <div class="skeleton" style="height: 10px; margin-top: var(--sp-2)"></div>
      <div class="skeleton" style="height: 14px; width: 70%; margin-top: var(--sp-2)"></div>
    </div>

    <div v-else-if="!compact" class="card">
      <div class="card-header">
        <span class="card-title">{{ w.windowHours }}-hour window</span>
        <span class="badge" :style="{ '--badge-c': meta.color }">{{ meta.label }}</span>
        <button class="btn btn-ghost btn-sm right" @click="refresh"
                title="Refresh window status" aria-label="Refresh window status">↻</button>
      </div>
      <div class="kpi-value">{{ w.callsInWindow }} / {{ w.pauseThreshold }} heavy-eq units</div>
      <div class="progress progress-lg" style="margin-top: var(--sp-2)" role="progressbar"
           :aria-label="w.windowHours + '-hour usage'" aria-valuemin="0"
           :aria-valuemax="w.pauseThreshold" :aria-valuenow="w.callsInWindow">
        <div class="progress-fill" :style="{ width: fillPct + '%', '--fill-c': color }"></div>
      </div>
      <div class="small dim" style="margin-top: var(--sp-2)">
        {{ rawCalls }} raw attempts · {{ fmtMoney(w.totalCostInWindow) }} estimated · {{ w.costThresholdsEnforced ? 'cost enforced' : 'cost monitor-only' }}
      </div>
      <div v-if="w.oldestCallAt" class="xs muted" style="margin-top: 4px">
        oldest attempt {{ fmtAgo(w.oldestCallAt, now) }} — attempts age out after {{ w.windowHours }}h
      </div>
      <div v-if="reclaimLine" class="xs" style="margin-top: 2px; color: var(--ok)">
        ↺ {{ reclaimLine }}
      </div>
    </div>
  `,
};

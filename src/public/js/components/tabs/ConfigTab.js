// ConfigTab — per-project config editor (port of the old ConfigEditorSection).
// Numeric overrides + tri-state auto-run toggles + git settings, saved via
// PATCH /projects/:name/config. Only touched fields are sent. A touched empty
// value is sent as null so the server can remove the project-level override.

import { store } from '../../lib/store.js';
import { registerNavigationGuard, router } from '../../lib/router.js';

const TRI_KEYS = [
  'auto_pause_after_phase_1',
  'auto_pause_after_review',
  'chain_audit_to_bugs',
  'auto_promote_audit_bugs',
];

function withoutCommentKeys(value) {
  if (Array.isArray(value)) return value.map(withoutCommentKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('_') && !key.toLowerCase().includes('comment'))
    .map(([key, child]) => [key, withoutCommentKeys(child)]));
}

export default {
  name: 'ConfigTab',
  data() {
    return {
      form: {
        pause_at_calls: '', max_phases_per_run: '', review_every_n_phases: '',
        review_score_threshold: '',
        git_branch: '', git_remote: '',
        auto_pause_after_phase_1: null, auto_pause_after_review: null,
        chain_audit_to_bugs: null, auto_promote_audit_bugs: null,
      },
      errors: {},
      dirty: {},
      initializedFor: null, // project name the form was seeded from
      loadedVersion: null,
      conflict: null,
    };
  },
  computed: {
    name() { return router.project; },
    detail() {
      const d = store.state.detail;
      return d && d.name === router.project ? d : null;
    },
    loading() { return store.state.detailLoading; },
    error() { return store.state.detailError; },
    saving() { return !!store.state.busy['config:' + (router.project || '')]; },
    mutationLocked() {
      return !!(this.detail && (this.detail.processAlive || this.detail.autoRun?.status === 'running' || this.detail.pendingJob));
    },
    hasDirty() { return Object.keys(this.dirty).length > 0; },
    versionReady() { return typeof this.loadedVersion === 'string' && this.loadedVersion.length > 0; },
    conflictMessage() {
      return this.conflict?.message || 'project.json changed after this editor loaded.';
    },
    conflictHint() {
      return this.conflict?.refreshFailed
        ? 'Writes are disabled until the latest config can be loaded.'
        : 'Your unsaved values are preserved; reload only if you want to discard them.';
    },
    numberFields() {
      const eff = (this.detail && this.detail.billingConfig) || {};
      const cfg = this.detail?.effectiveConfig || {};
      return [
        { key: 'pause_at_calls',         label: 'Pause at calls (billing)',          placeholder: 'e.g. 100', min: 1, max: null, effective: eff.pause_at_calls ?? null },
        { key: 'max_phases_per_run',     label: 'Max phases per run',                placeholder: 'e.g. 5',   min: 1, max: null, effective: cfg.auto_run?.max_phases_per_run ?? null },
        { key: 'review_every_n_phases',  label: 'Review every N phases',             placeholder: 'e.g. 3',   min: 1, max: null, effective: cfg.phases?.review_every_n_phases ?? null },
        { key: 'review_score_threshold', label: 'Review auto-proceed score (0–100)', placeholder: 'e.g. 85',  min: 0, max: 100,  effective: cfg.auto_run?.review_auto_proceed_score_threshold ?? null },
      ];
    },
    toggles() {
      const ar = this.detail?.effectiveConfig?.auto_run || {};
      return [
        { key: 'auto_pause_after_phase_1', label: 'Pause after phase 1', effective: ar.auto_pause_after_phase_1 },
        { key: 'auto_pause_after_review',  label: 'Pause after review phase', effective: ar.auto_pause_after_review },
        { key: 'chain_audit_to_bugs',      label: 'Chain audit findings → bugs', effective: ar.chain_audit_to_bugs },
        { key: 'auto_promote_audit_bugs',  label: 'Auto-promote audit bugs', effective: ar.auto_promote_audit_bugs },
      ];
    },
    // Prefer a resolved effective config if the server supplies one. Do not
    // invent defaults from the project override layer: profile/global layers
    // may legitimately produce a different effective value.
    checkpointPolicy() {
      const o = (this.detail && this.detail.projectOverrides) || {};
      const ar = o.auto_run || {};
      const effectiveAr = this.detail?.effectiveConfig?.auto_run || null;
      const overridden = !!(ar.checkpoint_policy && typeof ar.checkpoint_policy === 'object');
      const cp = overridden ? ar.checkpoint_policy : effectiveAr?.checkpoint_policy;
      const mode = cp && ['all', 'intent', 'errors-only'].includes(cp.mode) ? cp.mode : null;
      const intents = Array.isArray(cp?.pause_intents) ? cp.pause_intents : [];
      const minTotal = ar.auto_pause_after_phase_1_min_total_phases ??
        effectiveAr?.auto_pause_after_phase_1_min_total_phases ?? null;
      return {
        mode,
        intents,
        minTotal,
        overridden,
        resolved: overridden || !!effectiveAr,
      };
    },
    projectOverridesText() {
      return JSON.stringify(this.detail?.projectOverrides || {}, null, 2);
    },
    effectiveConfigText() {
      const config = this.detail?.effectiveConfig;
      return config ? JSON.stringify(withoutCommentKeys(config), null, 2) : '';
    },
  },
  watch: {
    detail(d) {
      if (!d) return;
      if (d.name !== this.initializedFor || !this.loadedVersion) {
        if (!this.hasDirty) this.initForm();
        return;
      }
      if (d.configVersion && d.configVersion !== this.loadedVersion) {
        if (this.hasDirty) {
          this.conflict = { message: 'project.json changed after this editor loaded.' };
        } else {
          this.initForm();
        }
      }
    },
  },
  created() {
    if (this.detail) this.initForm();
  },
  mounted() {
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.removeNavigationGuard = registerNavigationGuard(() => {
      if (!this.hasDirty) return true;
      return window.confirm('You have unsaved config changes. Leave this page and discard them?');
    });
  },
  beforeUnmount() {
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.removeNavigationGuard?.();
  },
  methods: {
    retry() { if (router.project) store.loadDetail(router.project); },
    async discardAndReload() {
      const name = router.project;
      const fresh = await store.loadDetail(name);
      if (router.project !== name) return;
      if (fresh && this.detail?.configVersion === fresh.configVersion) this.initForm();
      else store.toast('Reload failed; your unsaved config values were preserved', 'err');
    },
    onBeforeUnload(e) {
      if (!this.hasDirty) return;
      e.preventDefault();
      e.returnValue = '';
    },
    noteConflict(e) {
      if (e?.status === 409 && (e.data?.currentVersion || e.code === 'CONFIG_VERSION_CONFLICT' ||
          /version|changed after|changed since/i.test(e.message || ''))) {
        this.conflict = e;
      }
    },

    initForm() {
      const d = this.detail;
      const o = (d && d.projectOverrides) || {};
      const ar = o.auto_run || {};
      this.form = {
        pause_at_calls:           o.billing?.pause_at_calls              ?? '',
        max_phases_per_run:       ar.max_phases_per_run                  ?? '',
        review_every_n_phases:    o.phases?.review_every_n_phases        ?? '',
        review_score_threshold:   ar.review_auto_proceed_score_threshold ?? '',
        git_branch:               d?.git_branch                          ?? '',
        git_remote:               d?.git_remote                          ?? '',
        auto_pause_after_phase_1: ar.auto_pause_after_phase_1            ?? null,
        auto_pause_after_review:  ar.auto_pause_after_review             ?? null,
        chain_audit_to_bugs:      ar.chain_audit_to_bugs                 ?? null,
        auto_promote_audit_bugs:  ar.auto_promote_audit_bugs             ?? null,
      };
      this.errors = {};
      this.dirty = {};
      this.initializedFor = d ? d.name : null;
      this.loadedVersion = d?.configVersion ?? null;
      this.conflict = null;
    },

    markDirty(key) { this.dirty[key] = true; },
    tri(key, val) {
      this.form[key] = this.form[key] === val ? null : val;
      this.markDirty(key);
    },
    setDefault(key) {
      this.form[key] = null;
      this.markDirty(key);
    },

    resetNumbers() {
      for (const k of ['pause_at_calls', 'max_phases_per_run', 'review_every_n_phases', 'review_score_threshold']) {
        this.form[k] = '';
        this.markDirty(k);
        delete this.errors[k];
      }
    },
    resetToggles() {
      for (const k of TRI_KEYS) this.setDefault(k);
    },
    revertGit() {
      this.form.git_branch = this.detail?.git_branch ?? '';
      this.form.git_remote = this.detail?.git_remote ?? '';
      delete this.dirty.git_branch;
      delete this.dirty.git_remote;
    },
    clearGit() {
      this.form.git_branch = '';
      this.form.git_remote = '';
      this.markDirty('git_branch');
      this.markDirty('git_remote');
    },
    async resetAll() {
      const name = router.project;
      const expectedVersion = this.loadedVersion;
      if (!name || !expectedVersion) {
        store.toast('The current config version is unavailable; reload before clearing overrides', 'err');
        return;
      }
      if (this.mutationLocked) {
        store.toast(`Wait for active or queued work on “${name}” before clearing config`, 'warn');
        return;
      }
      const yes = await store.confirmAction({
        title: 'Clear all editable project overrides?',
        body: 'Run limits and auto-run toggles will inherit from the resolved global/profile config. Git branch and remote will also be cleared.',
        danger: true,
        confirmLabel: 'Clear overrides',
      });
      if (!yes) return;
      // Capture identity/version before opening the dialog, then verify both
      // again. Navigation, an SSE refresh, or a queued job can otherwise turn
      // an old confirmation into a reset of a different/newer project config.
      if (router.project !== name) return;
      const fresh = await store.loadDetail(name, { silent: true });
      if (router.project !== name) return;
      if (!fresh) {
        store.toast('Could not verify the current config lock; reset was not submitted', 'err');
        return;
      }
      if (this.loadedVersion !== expectedVersion || fresh.configVersion !== expectedVersion) {
        this.conflict = { message: 'project.json changed while reset confirmation was open.' };
        store.toast('Config changed; reload before clearing overrides', 'warn');
        return;
      }
      if (fresh.processAlive || fresh.autoRun?.status === 'running' || fresh.pendingJob) {
        store.toast(`Work started on “${name}”; config reset was not submitted`, 'warn');
        return;
      }
      const r = await store.act('config:' + name, 'PATCH',
        '/projects/' + encodeURIComponent(name) + '/config', {
          reset: true,
          expectedVersion,
        }, {
          okMsg: 'Project overrides cleared',
          errPrefix: 'Reset config',
          onError: (e) => this.noteConflict(e),
        });
      if (r) {
        const refreshed = await store.loadDetail(name, { silent: true });
        if (router.project === name && refreshed && this.detail?.configVersion === refreshed.configVersion) this.initForm();
        else if (router.project === name) {
          this.dirty = {};
          this.loadedVersion = null;
          this.conflict = { message: 'Overrides were cleared, but the refreshed project config could not be loaded.', refreshFailed: true };
        }
      }
    },
    async copyEffectiveConfig() {
      if (!this.effectiveConfigText) return;
      try {
        await navigator.clipboard.writeText(this.effectiveConfigText);
        store.toast('Resolved config copied', 'ok');
      } catch {
        store.toast('Copy failed — clipboard permission was denied', 'err');
      }
    },

    validate() {
      const errs = {};
      for (const f of ['pause_at_calls', 'max_phases_per_run', 'review_every_n_phases']) {
        const v = this.form[f];
        if (v !== '' && v !== null && v !== undefined) {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1) errs[f] = 'Must be a positive integer';
        }
      }
      if (this.form.review_score_threshold !== '' && this.form.review_score_threshold !== null) {
        const n = Number(this.form.review_score_threshold);
        if (!Number.isInteger(n) || n < 0 || n > 100) errs.review_score_threshold = 'Must be an integer from 0–100';
      }
      this.errors = errs;
      return Object.keys(errs).length === 0;
    },

    async save() {
      if (!this.validate()) return;
      const f = this.form;
      const body = {};
      const numeric = ['pause_at_calls', 'max_phases_per_run', 'review_every_n_phases', 'review_score_threshold'];
      for (const key of numeric) {
        if (!this.dirty[key]) continue;
        body[key] = f[key] === '' || f[key] === null ? null : Number(f[key]);
      }
      for (const key of ['git_branch', 'git_remote']) {
        if (!this.dirty[key]) continue;
        body[key] = (f[key] ?? '').trim() || null;
      }
      for (const key of TRI_KEYS) {
        if (this.dirty[key]) body[key] = f[key];
      }
      if (!Object.keys(body).length) {
        store.toast('Nothing to save — change at least one field', 'info');
        return;
      }
      body.expectedVersion = this.loadedVersion;
      const name = router.project;
      const r = await store.act('config:' + name, 'PATCH',
        '/projects/' + encodeURIComponent(name) + '/config', body,
        {
          okMsg: '✓ Saved',
          errPrefix: 'Save failed',
          onError: (e) => this.noteConflict(e),
        });
      if (r) {
        const fresh = await store.loadDetail(name, { silent: true });
        if (router.project === name && fresh && this.detail?.configVersion === fresh.configVersion) this.initForm();
        else if (router.project === name) {
          this.dirty = {};
          this.loadedVersion = null;
          this.conflict = { message: 'Config was saved, but the refreshed project config could not be loaded.', refreshFailed: true };
        }
      }
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <div v-if="!detail && loading" class="col" style="gap: var(--sp-4)">
        <div class="skeleton" style="height: 150px"></div>
        <div class="skeleton" style="height: 190px"></div>
        <div class="skeleton" style="height: 110px"></div>
      </div>

      <div v-else-if="!detail && error" class="banner banner-err">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-sm" @click="retry">Retry</button>
      </div>

      <div v-else-if="!detail" class="empty">
        <span class="empty-icon">⚙</span>
        <span>Config not loaded</span>
        <span class="empty-hint">Refresh to load this project’s settings</span>
      </div>

      <template v-else>
        <div v-if="conflict" class="banner banner-warn">
          <span class="grow">{{ conflictMessage }} {{ conflictHint }}</span>
          <button class="btn btn-sm" @click="discardAndReload">{{ conflict.refreshFailed ? 'Retry reload' : 'Discard and reload' }}</button>
        </div>
        <div v-else-if="!versionReady" class="banner banner-err">
          This server did not provide a project.json version, so config writes are disabled to prevent overwriting a newer edit.
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Run limits</span>
            <button class="btn btn-ghost btn-sm right" @click="resetNumbers" title="Remove these project overrides when saved">Reset to inherited</button>
          </div>
          <div class="grid-2">
            <div class="field" v-for="f in numberFields" :key="f.key">
              <span class="row" style="gap: var(--sp-2)">
                <span class="label">{{ f.label }}</span>
                <span v-if="f.effective != null" class="xs muted nowrap">effective: {{ f.effective }}</span>
              </span>
              <input class="input" type="number" :min="f.min" :max="f.max"
                     v-model="form[f.key]" :placeholder="f.placeholder"
                     @input="markDirty(f.key)"
                     :class="{'input-invalid': errors[f.key]}"
                     :aria-label="f.label" :aria-invalid="!!errors[f.key]">
              <span v-if="errors[f.key]" class="error-text">{{ errors[f.key] }}</span>
            </div>
          </div>
          <div class="xs muted" style="margin-top: var(--sp-3)">Only changed fields are saved. Clearing a field removes its project override so the resolved profile/global value is inherited.</div>
        </div>

        <details class="card config-cascade">
          <summary class="config-summary">
            <span class="card-title">Resolved config &amp; cascade</span>
            <span class="xs muted">read-only</span>
          </summary>
          <div class="col" style="gap: var(--sp-3); margin-top: var(--sp-3)">
            <div class="banner banner-info small">
              Effective values include the resolved defaults, profile/global layers, and project overrides. Exact source provenance is shown only for the project override layer; the server does not expose which other layer won.
            </div>
            <div>
              <div class="row" style="margin-bottom: var(--sp-2)">
                <span class="label">Project overrides (exact source)</span>
              </div>
              <pre class="term config-json">{{ projectOverridesText }}</pre>
            </div>
            <div>
              <div class="row" style="margin-bottom: var(--sp-2)">
                <span class="label">Effective resolved config</span>
                <button v-if="effectiveConfigText" class="btn btn-ghost btn-sm right" @click="copyEffectiveConfig">Copy</button>
              </div>
              <pre v-if="effectiveConfigText" class="term config-json">{{ effectiveConfigText }}</pre>
              <div v-else class="banner banner-warn">The server did not return the resolved configuration.</div>
            </div>
          </div>
        </details>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Auto-run behaviour</span>
            <button class="btn btn-ghost btn-sm right" @click="resetToggles">Reset to inherited</button>
          </div>
          <div class="col" style="gap: var(--sp-3)">
            <div class="row config-toggle-row" v-for="t in toggles" :key="t.key">
              <span class="grow">{{ t.label }}</span>
              <span v-if="form[t.key] === null && typeof t.effective === 'boolean'" class="chip">
                effective {{ t.effective ? 'ON' : 'OFF' }}
              </span>
              <div class="row" style="gap: 4px" role="group" :aria-label="t.label">
                <button class="btn btn-sm" :class="{'btn-primary': form[t.key] === true}"
                        :aria-pressed="form[t.key] === true" @click="tri(t.key, true)">ON</button>
                <button class="btn btn-sm" :class="{'btn-primary': form[t.key] === false}"
                        :aria-pressed="form[t.key] === false" @click="tri(t.key, false)">OFF</button>
                <button class="btn btn-sm" :class="{'btn-primary': form[t.key] === null}"
                        :aria-pressed="form[t.key] === null" @click="setDefault(t.key)">INHERIT</button>
              </div>
            </div>
          </div>
          <div class="xs muted" style="margin-top: var(--sp-3)">INHERIT removes the project override and uses the resolved profile/global configuration.</div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Checkpoint policy</span>
          </div>
          <div class="col" style="gap: var(--sp-2)">
            <div class="row">
              <span class="grow">Mode</span>
              <span class="xs muted">{{ checkpointPolicy.mode || 'Inherited (effective value unavailable)' }}{{ checkpointPolicy.overridden ? ' (project override)' : '' }}</span>
            </div>
            <div class="row" v-if="checkpointPolicy.mode === 'intent'">
              <span class="grow">Pause before intents</span>
              <span class="xs muted">{{ checkpointPolicy.intents.join(', ') || '(none)' }}</span>
            </div>
            <div class="row" v-if="checkpointPolicy.minTotal != null && checkpointPolicy.minTotal > 0">
              <span class="grow">Phase-1 checkpoint min plan size</span>
              <span class="xs muted">{{ checkpointPolicy.minTotal }} phases</span>
            </div>
          </div>
          <div class="xs muted" style="margin-top: var(--sp-3)">Read-only — change via chat: “set checkpoint policy to intent” (set_checkpoint_policy). When the resolved cascade is unavailable, this panel deliberately does not guess a default.</div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Git</span>
            <button class="btn btn-ghost btn-sm right" @click="revertGit" title="Discard unsaved Git edits">Revert edits</button>
            <button class="btn btn-ghost btn-sm" @click="clearGit" title="Clear Git branch and remote when saved">Clear</button>
          </div>
          <div class="grid-2">
            <div class="field">
              <span class="label">Git branch</span>
              <input class="input" type="text" v-model="form.git_branch" @input="markDirty('git_branch')" placeholder="develop" aria-label="Git branch">
            </div>
            <div class="field">
              <span class="label">Git remote</span>
              <input class="input" type="text" v-model="form.git_remote" @input="markDirty('git_remote')" placeholder="https://github.com/user/repo.git" aria-label="Git remote">
            </div>
          </div>
        </div>

        <div class="row">
          <span class="xs muted grow">Overrides are saved to projects/{{ name }}/project.json.</span>
          <button class="btn btn-danger" :disabled="saving || mutationLocked || !versionReady" @click="resetAll">Clear all editable overrides</button>
          <button class="btn btn-primary" :disabled="saving || mutationLocked || !versionReady" @click="save"
                  :title="mutationLocked ? 'Wait for active or queued project work to finish' : 'Save project config'">
            <span v-if="saving" class="spin">⟳</span>{{ saving ? 'Saving…' : 'Save config' }}
          </button>
        </div>
      </template>

    </div>
  `,
};

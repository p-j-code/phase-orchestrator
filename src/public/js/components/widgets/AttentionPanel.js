import { api } from '../../lib/api.js';
import { store } from '../../lib/store.js';
import { fmtAgo } from '../../lib/format.js';

export default {
  name: 'AttentionPanel',
  props: { project: { type: String, default: null } },
  data() {
    return {
      data: null, loading: true, error: '', answers: {},
      approvalProject: this.project || '', approvalAction: 'brief', approvalNights: 1,
      // Portfolio autopilot's planner can emit only these actions. Offering
      // unrelated queue actions here creates approvals that can never be
      // consumed and falsely suggests that the approval schedules the action.
      approvalActions: ['brief', 'resume', 'bugs', 'audit', 'suggestions'],
      loadSeq: 0,
    };
  },
  computed: {
    now() { return store.state.now; },
    busy() { return store.state.busy; },
    questions() { return this.data?.questions || []; },
    notices() { return this.data?.notifications || this.data?.notices || []; },
    approvals() { return this.data?.approvals || []; },
    recommendations() {
      const rows = this.data?.autopilot?.lastPlan?.recommendations || [];
      return this.project ? rows.filter((row) => row.project === this.project) : rows;
    },
    count() { return this.questions.length + this.recommendations.length; },
    projects() { return store.state.projects || []; },
    approvalTarget() { return this.project || this.approvalProject; },
  },
  watch: {
    project(value) { this.approvalProject = value || ''; this.load(); },
  },
  mounted() { this.load(); },
  methods: {
    fmtAgo,
    async load() {
      const seq = ++this.loadSeq;
      this.loading = true;
      this.error = '';
      const project = this.project;
      const query = project ? '?project=' + encodeURIComponent(project) : '';
      try {
        const data = await api('GET', '/attention' + query);
        if (this.project === project && seq === this.loadSeq) {
          this.data = {
            ...data,
            questions: (data?.questions || []).map((q) => {
              if (Array.isArray(q.options)) return q;
              try { return { ...q, options: q.options ? JSON.parse(q.options) : [] }; }
              catch { return { ...q, options: [] }; }
            }),
          };
        }
      } catch (e) {
        if (this.project === project && seq === this.loadSeq) this.error = e.message;
      } finally {
        if (this.project === project && seq === this.loadSeq) this.loading = false;
      }
    },
    async answer(q, answer = null) {
      const text = String(answer ?? this.answers[q.id] ?? '').trim();
      if (!text) { store.toast('Write or choose an answer first', 'err'); return; }
      if (text.length > 400) { store.toast('Answers are limited to 400 characters', 'err'); return; }
      const yes = await store.confirmAction({
        title: `Answer operator question #${q.id}?`,
        body: `${q.question}\n\nRecord this durable answer: “${text}”`,
        confirmLabel: 'Record answer',
      });
      if (!yes) return;
      const r = await store.act('question:' + q.id, 'POST', '/attention/questions/' + q.id + '/answer',
        { answer: text }, { okMsg: 'Answer recorded', errPrefix: 'Answer question' });
      if (r) { delete this.answers[q.id]; this.load(); }
    },
    async grantApproval() {
      const project = this.approvalTarget;
      if (!project) { store.toast('Choose a project to approve', 'err'); return; }
      return this.createApproval(project, this.approvalAction, this.approvalNights);
    },
    async createApproval(project, action, requestedNights = 1) {
      if (!this.approvalActions.includes(action)) {
        store.toast(`“${action}” is not an approval-controlled autopilot action`, 'err');
        return null;
      }
      const requested = Number(requestedNights);
      if (!Number.isInteger(requested) || requested < 1 || requested > 30) {
        store.toast('Approval nights must be a whole number from 1 to 30', 'err');
        return null;
      }
      const nights = requested;
      const yes = await store.confirmAction({
        title: `Approve ${action} automation?`,
        body: `Allow portfolio autopilot to enqueue “${action}” for ${project} for ${nights} night(s). This may consume provider budget.`,
        confirmLabel: 'Grant bounded approval',
      });
      if (!yes) return null;
      const r = await store.act('approval:new:' + project + ':' + action, 'POST', '/attention/approvals', {
        project, action, nights,
      }, { okMsg: `Approved ${action} for ${nights} night(s)`, errPrefix: 'Grant approval' });
      if (r) this.load();
      return r;
    },
    async revokeApproval(a) {
      const yes = await store.confirmAction({
        title: 'Revoke autopilot approval?',
        body: `Remove the ${a.action} approval for ${a.project}?`,
        danger: true,
        confirmLabel: 'Revoke',
      });
      if (!yes) return;
      const r = await store.act('approval:delete:' + a.id, 'DELETE', '/attention/approvals/' + a.id,
        undefined, { okMsg: 'Approval revoked', errPrefix: 'Revoke approval' });
      if (r) this.load();
    },
  },
  template: `
    <section class="card" aria-label="Operator attention center">
      <div class="card-header">
        <span class="card-title">Attention center</span>
        <span v-if="count" class="badge" style="--badge-c:var(--warn)">{{ count }} needs action</span>
        <button class="btn btn-ghost btn-sm right" @click="load" :disabled="loading" aria-label="Refresh attention center">
          <span v-if="loading" class="spinner"></span><span v-else>↻</span>
        </button>
      </div>
      <div v-if="loading && !data" class="skeleton" style="height:80px"></div>
      <div v-else-if="error" class="banner banner-err"><span class="grow">{{ error }}</span><button class="btn btn-sm" @click="load">Retry</button></div>
      <template v-else>
        <div v-if="!questions.length && !recommendations.length && !approvals.length && !notices.length" class="empty">
          <span class="empty-icon">✓</span><span>Nothing needs attention</span>
        </div>

        <div v-if="questions.length" class="label" style="margin-bottom:var(--sp-2)">Open questions</div>
        <div v-for="q in questions" :key="'q'+q.id" class="card-flat col" style="margin-bottom:var(--sp-2)">
          <div class="row-wrap">
            <span class="badge" :style="{'--badge-c':q.blocking ? 'var(--err)' : 'var(--warn)'}">Question #{{ q.id }}</span>
            <span class="chip">{{ q.project }}</span>
            <span v-if="q.phase != null" class="chip">phase {{ q.phase }}</span>
            <span class="xs muted right">{{ fmtAgo(q.created_at, now) }}</span>
          </div>
          <strong>{{ q.question }}</strong>
          <p v-if="q.assumption" class="small dim">Current assumption: {{ q.assumption }}</p>
          <div v-if="q.options?.length" class="row-wrap">
            <button v-for="option in q.options" :key="option" class="btn btn-sm" @click="answer(q, option)">{{ option }}</button>
          </div>
          <div class="row">
            <input v-model="answers[q.id]" class="input" :aria-label="'Answer question ' + q.id" placeholder="Type an answer…"
                   maxlength="400" @keydown.enter="answer(q)">
            <button class="btn btn-primary" :disabled="!String(answers[q.id] || '').trim()" @click="answer(q)">Answer</button>
          </div>
        </div>

        <div v-if="recommendations.length" class="label" style="margin:var(--sp-3) 0 var(--sp-1)">Autopilot recommendations awaiting approval</div>
        <div v-for="a in recommendations" :key="'recommend:'+a.project+':'+a.action" class="feed-item">
          <span class="badge" style="--badge-c:var(--warn)">Approval needed</span>
          <span class="chip">{{ a.project }}</span>
          <span class="bold">{{ a.action }}</span>
          <span class="grow small dim">{{ a.reason }}</span>
          <button class="btn btn-sm" :disabled="busy['approval:new:' + a.project + ':' + a.action]" @click="createApproval(a.project, a.action, 1)">Approve 1 night</button>
        </div>

        <div v-if="approvals.length" class="label" style="margin:var(--sp-3) 0 var(--sp-1)">Existing approvals</div>
        <div v-for="a in approvals" :key="a.id" class="feed-item">
          <span class="badge" :style="{'--badge-c':a.valid ? 'var(--ok)' : 'var(--muted)'}">{{ a.valid ? 'Approved' : 'Expired' }}</span>
          <span class="chip">{{ a.project }}</span>
          <span class="bold">{{ a.action }}</span>
          <span class="grow small dim">
            <template v-if="a.remaining_nights != null">{{ a.remaining_nights }} night(s) left</template>
            <template v-else-if="a.expires_at">until {{ new Date(a.expires_at).toLocaleString() }}</template>
          </span>
          <button class="btn btn-ghost btn-sm" :disabled="busy['approval:delete:' + a.id]" @click="revokeApproval(a)">Revoke</button>
        </div>

        <details open style="margin-top:var(--sp-3)">
          <summary class="small bold">Grant bounded autopilot approval</summary>
          <div class="row-wrap" style="margin-top:var(--sp-2)">
            <select v-if="!project" v-model="approvalProject" class="select" aria-label="Approval project">
              <option value="">Choose project…</option>
              <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
            </select>
            <select v-model="approvalAction" class="select" aria-label="Approval action">
              <option v-for="action in approvalActions" :key="action" :value="action">{{ action }}</option>
            </select>
            <label class="row xs">Nights <input v-model.number="approvalNights" type="number" min="1" max="30" class="input" style="width:72px" aria-label="Approval nights"></label>
            <button class="btn" :disabled="!approvalTarget || busy['approval:new:' + approvalTarget + ':' + approvalAction]" @click="grantApproval">Grant approval</button>
          </div>
          <p class="xs muted" style="margin-top:var(--sp-2)">Approvals always expire by night count; they are never permanent silent bypasses.</p>
        </details>

        <details v-if="notices.length" style="margin-top:var(--sp-3)">
          <summary class="small">Recent notifications ({{ notices.length }})</summary>
          <div v-for="n in notices.slice(0, 20)" :key="n.id" class="feed-item">
            <span v-if="n.project" class="chip">{{ n.project }}</span>
            <span class="grow small" style="white-space:pre-wrap">{{ n.text }}</span>
            <span class="xs muted nowrap">{{ fmtAgo(n.created_at, now) }}</span>
          </div>
        </details>
      </template>
    </section>
  `,
};

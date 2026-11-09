import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { navigate, projectHash } from '../../lib/router.js';
import { closeModal, handleModalKey, openModal } from '../../lib/modal-a11y.js';

export default {
  name: 'NewProjectModal',
  data() {
    return {
      name: '',
      gitRemote: '',
      gitBranch: 'develop',
      tech: '',
      profile: '',
      noGit: false,
      profiles: [],
      profilesLoading: false,
      profilesError: '',
      error: '',
      creating: false,
      progress: [],
      createdProject: null,
    };
  },
  computed: {
    nameValid() { return /^[a-z0-9][a-z0-9-]*$/.test(this.name); },
    canCreate() {
      return this.nameValid && (this.noGit || this.gitRemote.trim()) && !this.creating;
    },
  },
  async mounted() {
    document.addEventListener('keydown', this.onKey);
    this.$nextTick(() => openModal(this.$refs.backdrop, this.$refs.nameInput));
    await this.loadProfiles();
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    closeModal(this.$refs.backdrop);
  },
  methods: {
    onKey(e) {
      handleModalKey(this.$refs.backdrop, e, {
        onEscape: this.close,
        escapeDisabled: this.creating,
      });
    },
    close() { store.state.showNewProject = false; },
    openCreatedProject() {
      if (!this.createdProject) return;
      const name = this.createdProject;
      this.close();
      navigate(projectHash(name));
    },
    async loadProfiles() {
      this.profilesLoading = true;
      this.profilesError = '';
      try {
        const rows = await api('GET', '/profiles');
        this.profiles = Array.isArray(rows) ? rows : [];
      } catch (e) {
        this.profilesError = e.message;
      } finally {
        this.profilesLoading = false;
      }
    },
    async create() {
      if (!this.canCreate) return;
      this.error = '';
      this.creating = true;
      this.progress = [];
      try {
        const r = await api('POST', '/projects', {
          name: this.name.trim(),
          gitRemote: this.gitRemote.trim(),
          gitBranch: this.gitBranch.trim() || 'develop',
          tech: this.tech.trim(),
          profile: this.profile || null,
          noGit: this.noGit,
        });
        this.progress = r.progress || [];
        this.createdProject = r.name;
        store.toast(`Project “${r.name}” created`, 'ok');
        await store.loadProjects();
        store.loadStats();
        this.$nextTick(() => this.$refs.openProjectBtn?.focus());
      } catch (e) {
        this.error = e.message;
      } finally {
        this.creating = false;
      }
    },
  },
  template: `
    <div ref="backdrop" class="modal-backdrop" @click.self="!creating && close()" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
      <div class="modal" tabindex="-1">
        <div class="modal-header">
          <span id="new-project-title">＋ New project</span>
          <button class="btn btn-ghost btn-sm right" @click="close" :disabled="creating" aria-label="Close">✕</button>
        </div>
        <div v-if="createdProject" class="modal-body">
          <div class="banner banner-ok" role="status">Project “{{ createdProject }}” was created successfully.</div>
          <div v-if="progress.length" class="col" style="gap: var(--sp-2)" aria-label="Creation progress">
            <div v-for="(line, i) in progress" :key="i" class="row small">
              <span aria-hidden="true" style="color: var(--ok)">✓</span>
              <span>{{ line }}</span>
            </div>
          </div>
          <div v-else class="small dim">The server did not return detailed creation steps.</div>
        </div>
        <div v-else class="modal-body">
          <div class="field">
            <label class="label" for="np-name">Name</label>
            <input id="np-name" ref="nameInput" v-model="name" class="input"
                   :class="{'input-invalid': name && !nameValid}"
                   placeholder="my-project" @keydown.enter="create" autocomplete="off">
            <span v-if="name && !nameValid" class="error-text">lowercase letters, digits and dashes; must start with a letter or digit</span>
          </div>
          <div class="field" v-if="!noGit">
            <label class="label" for="np-remote">Git remote URL</label>
            <input id="np-remote" v-model="gitRemote" class="input" placeholder="git@github.com:me/repo.git" @keydown.enter="create">
          </div>
          <div class="grid-2">
            <div class="field" v-if="!noGit">
              <label class="label" for="np-branch">Branch</label>
              <input id="np-branch" v-model="gitBranch" class="input" placeholder="develop">
            </div>
            <div class="field">
              <label class="label" for="np-tech">Tech stack</label>
              <input id="np-tech" v-model="tech" class="input" placeholder="node, react…">
            </div>
            <div class="field">
              <label class="label" for="np-profile">Profile</label>
              <select id="np-profile" v-model="profile" class="select" :disabled="profilesLoading">
                <option value="">default</option>
                <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
              </select>
              <div v-if="profilesError" class="row xs" style="color: var(--err)">
                <span class="grow">Profiles unavailable: {{ profilesError }}</span>
                <button type="button" class="btn btn-sm" @click="loadProfiles">Retry</button>
              </div>
            </div>
          </div>
          <label class="checkbox">
            <input type="checkbox" v-model="noGit"> No git (local workspace only)
          </label>
          <div v-if="error" class="banner banner-err">{{ error }}</div>
          <div v-if="creating" class="banner banner-info"><span class="spinner"></span> Creating project — cloning may take a moment…</div>
        </div>
        <div class="modal-footer">
          <button v-if="createdProject" class="btn btn-ghost" @click="close">Close</button>
          <button v-if="createdProject" ref="openProjectBtn" data-modal-initial class="btn btn-primary" @click="openCreatedProject">Open project</button>
          <button v-if="!createdProject" class="btn btn-ghost" @click="close" :disabled="creating">Cancel</button>
          <button v-if="!createdProject" class="btn btn-primary" :disabled="!canCreate" @click="create">
            <span v-if="creating" class="spinner"></span> Create project
          </button>
        </div>
      </div>
    </div>
  `,
};

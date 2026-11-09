import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

// Single source of truth for the doc-site layout. Edit the `sidebar`
// blocks below to reorganise navigation; the URL slugs match the .md
// filenames in the docs/ folder.
//
// To run:
//   npm run docs           — dev server with hot reload (localhost:5173)
//   npm run docs:build     — static site in docs/.vitepress/dist/
//   npm run docs:preview   — serve the built site

export default withMermaid(defineConfig({
  title: 'Ashmero Orchestrator',
  description: 'Self-driving Claude development orchestrator — docs',

  // Pretty URLs (/PLAYBOOK instead of /PLAYBOOK.html). Set false if you
  // serve from a host that doesn't auto-rewrite trailing slashes.
  cleanUrls: true,

  // Default to the system colour scheme; user can toggle.
  appearance: true,

  // Default <title> on each page uses `:title — :titleTemplate`.
  titleTemplate: 'Orchestrator Docs',

  // Don't fail the build over dead anchor links inside generated content
  // (the inbox/bug Mermaid diagrams use them).
  ignoreDeadLinks: true,

  themeConfig: {
    siteTitle: '🤖 Orchestrator',

    // Top-right nav. Short list — the sidebar is the main navigation.
    nav: [
      { text: 'Playbook',  link: '/PLAYBOOK' },
      { text: 'Flows',     link: '/FLOWS' },
      { text: 'Reference', link: '/TELEGRAM_BOT' },
      { text: 'Changelog', link: 'https://github.com/' /* fill in your repo */, target: '_blank' },
    ],

    // Left sidebar — grouped, in the order a new user would discover them.
    sidebar: [
      {
        text: '🧭 Start here',
        items: [
          { text: 'Playbook',    link: '/PLAYBOOK' },
          { text: 'Flow index',  link: '/FLOWS' },
        ],
      },
      {
        text: 'Flows',
        collapsed: false,
        items: [
          { text: 'Project lifecycle',  link: '/FLOW_PROJECT_LIFECYCLE' },
          { text: 'Requirements',       link: '/FLOW_REQUIREMENTS' },
          { text: 'Bugs',               link: '/FLOW_BUGS' },
          { text: 'Audit',              link: '/FLOW_AUDIT' },
          { text: 'Roadmap',            link: '/FLOW_ROADMAP' },
          { text: 'Run + queue',        link: '/FLOW_RUN_QUEUE' },
        ],
      },
      {
        text: 'Reference',
        collapsed: false,
        items: [
          { text: 'Telegram bot',       link: '/TELEGRAM_BOT' },
          { text: 'Architecture',       link: '/ARCHITECTURE' },
          { text: 'Auto-run',           link: '/AUTO_RUN' },
          { text: 'Model routing',      link: '/MODEL_ROUTING' },
          { text: 'Prompt design',      link: '/PROMPT_DESIGN' },
          { text: 'Guide layout',       link: '/GUIDE_LAYOUT' },
        ],
      },
      {
        text: 'Operations',
        collapsed: true,
        items: [
          { text: 'Runbook',            link: '/RUNBOOK' },
          { text: 'Audit briefs',       link: '/AUDIT_BRIEF_ROADMAP' },
          { text: 'New features log',   link: '/NEW_FEATURES' },
        ],
      },
    ],

    // Built-in local search (no Algolia signup needed). Indexes all
    // markdown content at build time.
    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },

    // Right-rail table of contents per page. Levels 2-3 = H2 + H3 only.
    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    // Bottom-of-page prev/next links.
    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    footer: {
      message: 'Internal docs — Ashmero Orchestrator',
      copyright: '',
    },

    // The little "Edit this page" link can point at your repo's blob URL.
    // Leave commented until you fill in your repo path.
    // editLink: {
    //   pattern: 'https://github.com/p-j-code/ashmero-orchestrator/edit/main/docs/:path',
    //   text: 'Edit this page on GitHub',
    // },

    socialLinks: [
      // { icon: 'github', link: 'https://github.com/p-j-code/ashmero-orchestrator' },
    ],
  },

  // ─── Mermaid config (passed through to mermaid.initialize) ──────────────
  // The default theme adapts to light/dark mode via VitePress. Override
  // here only if you want specific colours.
  mermaid: {
    // Use the neutral theme; renders well in both light and dark.
    // theme: 'neutral',
  },

  mermaidPlugin: {
    class: 'mermaid orchestrator-diagram',
  },
}));

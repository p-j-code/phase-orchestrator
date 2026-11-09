// src/lib/suggest-prompts.js
// Q&A definitions consumed by the CLI suggest command and Telegram suggest flow.
// 'goal' and 'areas' are collected upfront and passed to generateAISuggestions as context.
// 'passes' is asked after suggestions are selected (supports 1–5 passes).

export const QUESTIONS = [
  {
    id: 'goal',
    text: "What's your goal for this run?",
    type: 'text',
    placeholder: 'e.g. add auth, improve performance, fix onboarding UX…',
  },
  {
    id: 'areas',
    text: 'Which areas should Claude focus on?',
    type: 'multi',
    options: [
      { value: 'logic',    label: 'Logic / Backend' },
      { value: 'frontend', label: 'Frontend / UI' },
      { value: 'infra',    label: 'Performance & Infrastructure' },
      { value: 'security', label: 'Security' },
      { value: 'dx',       label: 'DX / Tooling' },
    ],
    // All five areas by default: the AI scan benefits from full context on first run.
    // Narrowing only constrains (a) the AI prompt's focus hint and
    // (b) filterSuggestions on the rules-engine fallback path.
    default: ['logic', 'frontend', 'infra', 'security', 'dx'],
  },
  {
    id: 'passes',
    text: 'How many pipeline passes do you want to plan?',
    type: 'single',
    options: [
      { value: '1', label: '1x — build everything in one pipeline run' },
      { value: '2', label: '2x — Pass 1 (core) → Pass 2 (polish/extend)' },
      { value: '3', label: '3x — core → extend → new category' },
      { value: '4', label: '4x — four sequential runs' },
      { value: '5', label: '5x — five sequential runs (large roadmap)' },
    ],
  },
];

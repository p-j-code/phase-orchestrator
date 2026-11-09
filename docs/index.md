---
layout: home

hero:
  name: "Ashmero Orchestrator"
  text: "Self-driving Claude development"
  tagline: "Build, audit, fix, ship — from your phone."
  image:
    src: /logo.svg
    alt: Orchestrator
  actions:
    - theme: brand
      text: 🧭 Read the Playbook
      link: /PLAYBOOK
    - theme: alt
      text: Browse the Flows
      link: /FLOWS

features:
  - icon: 🧭
    title: "Coach me"
    details: '"What should I do next?" — state-aware suggestions, tap one button to keep moving. Send /coach to your bot anytime.'
    link: /PLAYBOOK
  - icon: 📱
    title: "Telegram-first"
    details: "Run, audit, promote findings, retry phases, ship to main, hand off to QA — every command works from your phone."
    link: /TELEGRAM_BOT
  - icon: 🤖
    title: "Auto-runs with pauses"
    details: "Brief → plan → phases → review → ship. The bot pauses at review checkpoints so you stay in the loop without watching."
    link: /AUTO_RUN
  - icon: 🐞
    title: "Audits & bug rounds"
    details: "Read-only audits surface findings. Promote real ones to a bug round. The fix cycle is fully automated, validator-gated."
    link: /FLOW_AUDIT
  - icon: 📊
    title: "Cost-aware"
    details: "/predict before /run go. /budget shows lifetime project cost. Auto-pauses when the 5h window is about to flip."
    link: /MODEL_ROUTING
  - icon: ⚙️
    title: "Cross-project concurrency"
    details: "Worker pool runs different projects in parallel, per-project FIFO. Auto-scales to your project count."
    link: /FLOW_RUN_QUEUE
---

<style>
/* Tighten up the hero section and make features grid look balanced */
.VPHero .text { max-width: 720px; }
.VPFeatures .container .items .item { padding: 8px; }
.VPFeature { transition: transform 0.15s ease; }
.VPFeature:hover { transform: translateY(-2px); }
</style>

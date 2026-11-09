// discuss command — launch a multi-agent discussion for a project topic.
//
// Usage:
//   ashmero discuss <project> "<topic>" [--mode auto|medium|max] [--rounds N]
//
// The discussion runs inline (streaming progress to terminal), updates the
// project brief with the conclusion, then triggers auto-dev automatically.

import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProject, listDiscussions, getDiscConclusion } from '../state.js';
import { runDiscussion, formatConclusionSummary } from '../lib/discussion-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function registerDiscussCommand(program) {
  program
    .command('discuss <project> <topic>')
    .description('Run a multi-agent discussion panel for a project topic, then auto-start dev')
    .option('--mode <mode>', 'Agent team size: auto (3-5), medium (5-7), max (8-12)', 'auto')
    .option('--dry-run', 'Show roster only — do not run discussion', false)
    .option('--list', 'List previous discussions for this project', false)
    .action(async (project, topic, opts) => {
      const proj = getProject(project);
      if (!proj) {
        console.error(chalk.red(`Project not found: ${project}`));
        console.error(chalk.dim('Run: ashmero list  to see available projects'));
        process.exit(1);
      }

      if (opts.list) {
        const discussions = listDiscussions(project, 10);
        if (!discussions.length) {
          console.log(chalk.dim(`No discussions yet for ${project}`));
          return;
        }
        console.log(chalk.bold(`\nDiscussions for ${project}:\n`));
        for (const d of discussions) {
          const statusColor = d.status === 'done' ? chalk.green : d.status === 'failed' ? chalk.red : chalk.yellow;
          console.log(`  #${d.id}  ${statusColor(d.status.padEnd(12))}  ${chalk.dim(d.created_at.slice(0, 16))}  [${d.mode}]  ${d.topic}`);
        }
        return;
      }

      const validModes = ['auto', 'medium', 'max'];
      if (!validModes.includes(opts.mode)) {
        console.error(chalk.red(`Invalid mode: ${opts.mode}. Choose: auto, medium, max`));
        process.exit(1);
      }

      console.log(chalk.bold.cyan('\n╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║      Multi-Agent Discussion Panel     ║'));
      console.log(chalk.bold.cyan('╚══════════════════════════════════════╝\n'));
      console.log(`  Project : ${chalk.bold(project)}`);
      console.log(`  Topic   : ${chalk.bold(topic)}`);
      console.log(`  Mode    : ${chalk.bold(opts.mode)}`);
      console.log('');

      if (opts.dryRun) {
        console.log(chalk.yellow('  --dry-run: would generate roster and exit. Not yet implemented for CLI dry-run.'));
        return;
      }

      try {
        const { discId, conclusion } = await runDiscussion({
          projectName: project,
          topic,
          mode: opts.mode,
        });

        console.log(chalk.bold.green('\n╔══════════════════════════════════════╗'));
        console.log(chalk.bold.green('║           Discussion Complete         ║'));
        console.log(chalk.bold.green('╚══════════════════════════════════════╝\n'));

        const recs = conclusion.top_recommendations || [];
        for (const r of recs.slice(0, 3)) {
          console.log(`  ${chalk.bold(`${r.rank}.`)} ${chalk.cyan(r.title)}`);
          console.log(`     Cost: ${r.cost} · Effort: ${r.effort} · Confidence: ${Math.round((r.confidence || 0) * 100)}%`);
          console.log(`     ${chalk.dim(r.description)}`);
          console.log('');
        }

        if (conclusion.open_questions?.length) {
          console.log(chalk.yellow('  Open questions:'));
          for (const q of conclusion.open_questions) {
            console.log(`    • ${q}`);
          }
          console.log('');
        }

        console.log(chalk.dim(`  Brief updated and auto-dev triggered for ${project}`));
        console.log(chalk.dim(`  Discussion files: projects/${project}/.guide/discussions/${discId}/`));
      } catch (err) {
        console.error(chalk.red(`\n  Discussion failed: ${err.message}`));
        if (process.env.DEBUG) console.error(err);
        process.exit(1);
      }
    });
}

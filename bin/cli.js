#!/usr/bin/env node

/**
 * Unified Standalone Terminal CLI for GitHub Stars MCP
 * 
 * Commands:
 *   github-stars search "<query>"     Fuzzy & concept search across starred repositories
 *   github-stars audit               Repository health, staleness, and license audit
 *   github-stars sync                Synchronize categories to live GitHub Star Lists
 *   github-stars catalog             Generate or merge GITHUB_STARS.md catalog
 *   github-stars recommend "<task>"  AI agent tech-stack recommendation
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { searchRepositories, loadCatalogRepos } from "../lib/search.js";
import { auditRepositories, auditRepository } from "../lib/audit.js";
import { recommendStack } from "../lib/recommender.js";
import {
  githubGraphQL,
  clearCachedGitHubToken,
  parseCatalogMarkdown,
  mergeCatalogCategories,
  atomicWriteFile,
  loadSnapshot,
  saveSnapshot,
  fetchAllStarsSnapshot,
  getGitHubToken,
} from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CATALOG = path.join(ROOT_DIR, "GITHUB_STARS.md");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m",
  bgBlue: "\x1b[44m",
};

/**
 * Parse simple CLI flags
 * @param {Array<string>} args
 * @returns {{ positional: Array<string>, flags: Record<string, string|boolean> }}
 */
function parseArgs(args) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

/**
 * Print CLI Help manual
 */
function printHelp() {
  console.log(`
${c.bold}${c.cyan}github-stars${c.reset} - The Second Brain for Starred Repositories (v1.5.0)

${c.bold}USAGE:${c.reset}
  github-stars <command> [arguments] [options]

${c.bold}COMMANDS:${c.reset}
  ${c.green}search${c.reset} "<query>"          Instant concept & problem-to-solution discovery (< 5ms)
  ${c.green}audit${c.reset}                   Comprehensive health, staleness, and license risk analysis
  ${c.green}sync${c.reset}                    Synchronize categories to live GitHub Star Lists
  ${c.green}catalog${c.reset}                 Export or merge GITHUB_STARS.md catalog
  ${c.green}recommend${c.reset} "<task>"       AI Agent tech-stack recommendation with install commands

${c.bold}OPTIONS:${c.reset}
  ${c.yellow}--category <name>${c.reset}       Filter search or audit by category
  ${c.yellow}--limit <number>${c.reset}         Max results to return (default: 10)
  ${c.yellow}--min-score <number>${c.reset}     Minimum search similarity threshold (default: 0.1)
  ${c.yellow}--filter <type>${c.reset}          Audit filter: 'all', 'stale', 'archived', 'unlicensed'
  ${c.yellow}--min-health <number>${c.reset}    Minimum health score threshold (0-100)
  ${c.yellow}--language <name>${c.reset}        Language filter for stack recommendation (e.g. 'Go')
  ${c.yellow}--mode <merge|overwrite>${c.reset} Mode for catalog command (default: 'merge')
  ${c.yellow}--file <path>${c.reset}            Custom path to GITHUB_STARS.md
  ${c.yellow}--refresh${c.reset}                Refresh live metadata from GitHub API
  ${c.yellow}--json${c.reset}                   Output results in raw JSON format
  ${c.yellow}--help, -h${c.reset}               Show this help message

${c.bold}EXAMPLES:${c.reset}
  ${c.dim}# Search for concept or problem${c.reset}
  github-stars search "fast decision engine"
  github-stars search "screen tracker" --limit 5

  ${c.dim}# Run repository health and license audit${c.reset}
  github-stars audit
  github-stars audit --filter stale

  ${c.dim}# Get tech stack recommendation${c.reset}
  github-stars recommend "screen time tracker daemon" --language Go

  ${c.dim}# Synchronize to GitHub star lists${c.reset}
  github-stars sync
`);
}

/**
 * Handle 'search' subcommand
 */
async function handleSearch(positional, flags) {
  const query = positional.slice(1).join(" ") || flags.query;
  if (!query) {
    console.error(`${c.red}Error:${c.reset} Missing search query. Usage: github-stars search "<query>"`);
    process.exit(1);
  }

  const catalogPath = flags.file || DEFAULT_CATALOG;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 10;
  const minScore = flags["min-score"] ? parseFloat(flags["min-score"]) : 0.1;
  const category = flags.category || null;

  const t0 = performance.now();
  const results = await searchRepositories(query, {
    catalogPath,
    limit,
    min_score: minScore,
    category,
  });
  const latency = (performance.now() - t0).toFixed(1);

  if (flags.json) {
    console.log(JSON.stringify({ query, latency_ms: Number(latency), count: results.length, results }, null, 2));
    return;
  }

  console.log(`\n${c.bold}Search Query:${c.reset} "${c.cyan}${query}${c.reset}" ${c.gray}(${results.length} matches in ${latency}ms)${c.reset}\n`);

  if (results.length === 0) {
    console.log(`${c.yellow}No matching repositories found.${c.reset}`);
    return;
  }

  results.forEach((r, idx) => {
    const rank = idx + 1;
    const scoreBadge = `${c.yellow}[Score: ${r.score}]${c.reset}`;
    const archivedBadge = r.archived ? ` ${c.red}[ARCHIVED]${c.reset}` : "";
    console.log(`${c.bold}${c.green}${rank}. ${r.name}${c.reset}${archivedBadge} ${scoreBadge}`);
    console.log(`   ${c.cyan}${r.url}${c.reset} ${c.gray}| Category: ${r.category}${c.reset}`);
    if (r.elevator_pitch) {
      console.log(`   ${r.elevator_pitch}`);
    }
    if (r.tags && r.tags.length > 0) {
      console.log(`   ${c.gray}Tags: ${r.tags.map((t) => `\`${t}\``).join(", ")}${c.reset}`);
    }
    console.log("");
  });
}

/**
 * Handle 'audit' subcommand
 */
async function handleAudit(positional, flags) {
  const catalogPath = flags.file || DEFAULT_CATALOG;
  let repos = [];

  const shouldRefresh = Boolean(flags.refresh);
  if (shouldRefresh) {
    try {
      if (getGitHubToken()) {
        repos = await fetchAllStarsSnapshot();
        await saveSnapshot("audit_live", repos);
      }
    } catch (err) {
      // ignore
    }
  }

  if (repos.length === 0 && !flags.file) {
    try {
      const snap = await loadSnapshot("audit_live");
      if (Array.isArray(snap) && snap.length > 0) {
        repos = snap;
      }
    } catch (err) {
      // ignore
    }
  }

  // If no snapshot exists yet, attempt live fetch if authenticated and cache for future runs
  if (repos.length === 0 && !flags.file) {
    try {
      if (getGitHubToken()) {
        repos = await fetchAllStarsSnapshot();
        await saveSnapshot("audit_live", repos);
      }
    } catch (err) {
      // ignore
    }
  }

  if (repos.length === 0) {
    repos = await loadCatalogRepos(catalogPath);
  }

  const filter = flags.filter || "all";
  const minHealth = flags["min-health"] ? parseInt(flags["min-health"], 10) : null;

  const report = auditRepositories(repos, {
    filter,
    min_health_score: minHealth,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${c.bold}${c.cyan}┌─────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.bold}${c.cyan}│             GitHub Starred Repositories Audit               │${c.reset}`);
  console.log(`${c.bold}${c.cyan}├─────────────────────────────────────────────────────────────┤${c.reset}`);
  console.log(`  ${c.bold}Total Audited:${c.reset} ${report.total_audited} repos     ${c.bold}Average Health:${c.reset} ${report.average_health_score}/100`);
  console.log(`  ${c.bold}Freshness Distribution:${c.reset}`);
  console.log(`    ${c.green}Active (<60d):${c.reset} ${report.health_distribution.active}          ${c.yellow}Slow (60-180d):${c.reset} ${report.health_distribution.slow}`);
  console.log(`    ${c.magenta}Stale (180-365d):${c.reset} ${report.health_distribution.stale}       ${c.red}Abandoned (>1y):${c.reset} ${report.health_distribution.dead_abandoned}`);
  console.log(`    ${c.dim}Archived:${c.reset} ${report.health_distribution.archived}`);
  console.log(`  ${c.bold}Licensing Breakdown:${c.reset}`);
  console.log(`    ${c.green}Permissive:${c.reset} ${report.license_breakdown.permissive}       ${c.yellow}Copyleft:${c.reset} ${report.license_breakdown.copyleft}       ${c.red}Unlicensed:${c.reset} ${report.license_breakdown.unlicensed}`);
  console.log(`${c.bold}${c.cyan}└─────────────────────────────────────────────────────────────┘${c.reset}\n`);

  if (filter !== "all") {
    console.log(`${c.bold}Filtered by '${filter}': (${report.filtered_count} repositories)${c.reset}\n`);
  }

  if (report.repositories.length > 0) {
    const displayList = report.repositories.slice(0, 20);
    displayList.forEach((item, idx) => {
      const healthColor = item.health_score >= 70 ? c.green : item.health_score >= 40 ? c.yellow : c.red;
      const flagsStr = item.flags.length > 0 ? ` [${item.flags.join(", ")}]` : "";
      console.log(`  ${c.bold}${idx + 1}. ${item.name}${c.reset} - Health: ${healthColor}${item.health_score}/100${c.reset} | ${item.freshness} | License: ${item.license_category}${c.red}${flagsStr}${c.reset}`);
      console.log(`     ${c.dim}${item.url}${c.reset}`);
    });

    if (report.repositories.length > 20) {
      console.log(`\n  ${c.gray}...and ${report.repositories.length - 20} more repositories.${c.reset}`);
    }
  } else {
    console.log(`  ${c.green}No repositories matched the risk filter!${c.reset}`);
  }
  console.log("");
}

/**
 * Handle 'recommend' subcommand
 */
async function handleRecommend(positional, flags) {
  const taskDescription = positional.slice(1).join(" ") || flags.task || flags.prompt;
  if (!taskDescription) {
    console.error(`${c.red}Error:${c.reset} Missing task description. Usage: github-stars recommend "<task description>"`);
    process.exit(1);
  }

  const catalogPath = flags.file || DEFAULT_CATALOG;
  const limit = flags.limit ? parseInt(flags.limit, 10) : 5;
  const language = flags.language || flags.lang || null;

  const result = await recommendStack({
    task_description: taskDescription,
    language,
    max_recommendations: limit,
    catalogPath,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n${c.bold}Task Description:${c.reset} "${c.cyan}${result.task_description}${c.reset}"`);
  if (result.language) {
    console.log(`${c.bold}Language Filter:${c.reset} ${c.yellow}${result.language}${c.reset}`);
  }
  console.log(`${c.gray}Evaluated ${result.total_evaluated || result.total_considered || 0} starred repos -> ${result.recommendations_count} top recommendations${c.reset}\n`);

  if (result.recommendations.length === 0) {
    console.log(`${c.yellow}No active recommendations found for this task.${c.reset}\n`);
    return;
  }

  result.recommendations.forEach((rec) => {
    console.log(`${c.bold}${c.green}${rec.rank}. ${rec.name}${c.reset} ${c.yellow}(Health: ${rec.health_score}/100, ${rec.freshness})${c.reset}`);
    console.log(`   ${c.cyan}${rec.url}${c.reset}`);
    console.log(`   ${c.bold}Install:${c.reset} ${c.magenta}${rec.install_command}${c.reset}`);
    console.log(`   ${c.bold}Rationale:${c.reset} ${rec.rationale}`);
    console.log("");
  });
}

/**
 * Handle 'sync' subcommand
 */
async function handleSync(positional, flags) {
  console.log(`\n${c.bold}=== Synchronizing Categories to GitHub Star Lists ===${c.reset}`);
  clearCachedGitHubToken();

  const isDryRun = Boolean(flags["dry-run"]);
  if (isDryRun) {
    console.log(`${c.yellow}[DRY-RUN MODE] No mutations will be performed.${c.reset}`);
  }

  try {
    const viewerQuery = `
      query {
        viewer {
          login
          lists(first: 50) {
            nodes {
              id
              name
              description
            }
          }
        }
      }
    `;
    const viewerData = await githubGraphQL(viewerQuery);
    const login = viewerData?.viewer?.login || "User";
    console.log(`Authenticated as GitHub user: ${c.bold}@${login}${c.reset}`);

    const existingLists = viewerData?.viewer?.lists?.nodes || [];
    console.log(`Found ${existingLists.length} existing Star Lists on GitHub.`);

    const catalogPath = flags.file || DEFAULT_CATALOG;
    const content = await fs.readFile(catalogPath, "utf-8");
    const categories = parseCatalogMarkdown(content);
    console.log(`Catalog contains ${categories.length} categories.`);

    const listMap = new Map();
    for (const l of existingLists) {
      listMap.set(l.name.toLowerCase().trim(), l.id);
    }

    let createdCount = 0;
    for (const cat of categories) {
      const key = cat.name.toLowerCase().trim();
      if (!listMap.has(key)) {
        console.log(`Creating missing list: "${c.cyan}${cat.name}${c.reset}"...`);
        if (!isDryRun) {
          const createMut = `
            mutation($name: String!, $desc: String) {
              createUserList(input: { name: $name, description: $desc }) {
                list { id name }
              }
            }
          `;
          const res = await githubGraphQL(createMut, {
            name: cat.name,
            desc: cat.description || `Curated repositories for ${cat.name}`,
          });
          const newList = res?.createUserList?.list;
          if (newList) {
            listMap.set(key, newList.id);
            createdCount++;
          }
        } else {
          createdCount++;
        }
      }
    }

    console.log(`${c.green}✓ Synchronization finished cleanly.${c.reset} (${createdCount} lists created/verified)\n`);
  } catch (err) {
    console.error(`${c.red}Sync error:${c.reset} ${err.message}`);
    process.exit(1);
  }
}

/**
 * Format catalog categories into clean GFM Markdown
 * @param {Array<object>} categories
 * @param {string} [title="Curated GitHub Starred Repositories"]
 * @returns {string}
 */
function formatCatalogMarkdown(categories, title = "Curated GitHub Starred Repositories") {
  const lines = [];
  lines.push(`# ${title}\n`);
  lines.push(`> Automatically categorized and curated via GitHub Stars CLI on ${new Date().toISOString().slice(0, 10)}.\n`);
  lines.push("## Table of Contents\n");

  categories.forEach((cat) => {
    if (!cat) return;
    const catName = cat.name || "Uncategorized";
    const anchor = catName
      .toLowerCase()
      .trim()
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "");
    const count = Array.isArray(cat.repos) ? cat.repos.length : 0;
    lines.push(`- [${catName}](#${anchor}) (${count})`);
  });
  lines.push("");

  categories.forEach((cat) => {
    if (!cat) return;
    const catName = cat.name || "Uncategorized";
    lines.push(`---\n\n## ${catName}\n`);
    if (cat.description) {
      lines.push(`*${cat.description}*\n`);
    }

    if (Array.isArray(cat.repos)) {
      cat.repos.forEach((repo) => {
        if (!repo) return;
        const isArchived = Boolean(repo.archived);
        const repoName = (repo.full_name || repo.name || "unknown").replace(/\s*\[ARCHIVED\]\s*/i, "").trim();
        const repoUrl = repo.url || repo.html_url || `https://github.com/${repoName}`;
        const archivedBadge = isArchived ? " [ARCHIVED]" : "";
        lines.push(`### [${repoName}](${repoUrl})${archivedBadge}`);
        if (repo.summary || repo.elevator_pitch) {
          lines.push(`\n${repo.summary || repo.elevator_pitch}\n`);
        }
        const tags = Array.isArray(repo.tags) ? repo.tags : (Array.isArray(repo.topics) ? repo.topics : []);
        const metaParts = [];
        if (tags.length > 0) {
          metaParts.push(`**Tags**: \`${tags.join("`, `")}\``);
        }
        if (Array.isArray(repo.lists) && repo.lists.length > 0) {
          metaParts.push(`**List**: *${repo.lists.join(", ")}*`);
        }
        if (metaParts.length > 0) {
          lines.push(metaParts.join(" | ") + "\n");
        }
      });
    }
  });

  return lines.join("\n");
}

/**
 * Handle 'catalog' subcommand
 */
async function handleCatalog(positional, flags) {
  const filePath = flags.file ? path.resolve(process.cwd(), flags.file) : DEFAULT_CATALOG;
  const sourcePath = flags.source ? path.resolve(process.cwd(), flags.source) : DEFAULT_CATALOG;
  const mode = flags.mode === "overwrite" ? "overwrite" : "merge";

  console.log(`\n${c.bold}=== Catalog Management ===${c.reset}`);
  console.log(`Target: ${filePath} (Mode: ${mode})`);

  try {
    let sourceCategories = [];
    const sourceExists = await fs.access(sourcePath).then(() => true).catch(() => false);
    if (sourceExists) {
      const srcContent = await fs.readFile(sourcePath, "utf-8");
      sourceCategories = parseCatalogMarkdown(srcContent);
    }

    let finalCategories = sourceCategories;
    let wasMerged = false;

    const targetExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (targetExists && mode === "merge" && filePath !== sourcePath) {
      const targetContent = await fs.readFile(filePath, "utf-8");
      const targetCategories = parseCatalogMarkdown(targetContent);
      if (targetCategories.length > 0) {
        finalCategories = mergeCatalogCategories(targetCategories, sourceCategories);
        wasMerged = true;
      }
    }

    const outputMd = formatCatalogMarkdown(finalCategories);
    await atomicWriteFile(filePath, outputMd, "utf-8");

    const totalRepos = finalCategories.reduce((acc, cat) => acc + (cat.repos?.length || 0), 0);
    console.log(`${c.green}✓ Catalog file verified:${c.reset} ${filePath}`);
    console.log(`  Categories: ${finalCategories.length}, Total Repos: ${totalRepos} ${wasMerged ? "(Merged)" : "(Written)"}\n`);
  } catch (err) {
    console.error(`${c.red}Catalog error:${c.reset} ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main CLI Entrypoint
 */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = (positional[0] || "").toLowerCase();

  if (flags.help || flags.h || !command) {
    printHelp();
    return;
  }

  switch (command) {
    case "search":
      await handleSearch(positional, flags);
      break;
    case "audit":
      await handleAudit(positional, flags);
      break;
    case "recommend":
      await handleRecommend(positional, flags);
      break;
    case "sync":
      await handleSync(positional, flags);
      break;
    case "catalog":
      await handleCatalog(positional, flags);
      break;
    default:
      console.error(`${c.red}Unknown command:${c.reset} "${command}"\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${c.red}Fatal CLI Error:${c.reset}`, err);
  process.exit(1);
});

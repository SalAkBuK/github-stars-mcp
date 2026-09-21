/**
 * AI Agent Tech-Stack Recommender
 * 
 * Ingests project briefs or task descriptions, scores against vetted starred repositories,
 * filters out abandoned or archived projects, and provides actionable recommendations
 * with copy-paste installation commands and rationale.
 */

import { BM25SearchEngine, loadCatalogRepos } from "./search.js";
import { auditRepository } from "./audit.js";

/**
 * Detect language alias mappings
 */
const LANGUAGE_ALIASES = {
  js: ["javascript", "js", "node", "typescript", "ts"],
  javascript: ["javascript", "js", "node"],
  ts: ["typescript", "ts", "javascript", "js"],
  typescript: ["typescript", "ts", "javascript", "js"],
  py: ["python", "py"],
  python: ["python", "py"],
  golang: ["go", "golang"],
  go: ["go", "golang"],
  rust: ["rust", "rs", "cargo"],
  rs: ["rust", "rs", "cargo"],
  cpp: ["c++", "cpp"],
  "c++": ["c++", "cpp"],
  c: ["c"],
  csharp: ["c#", "csharp", "cs", "dotnet", ".net"],
  "c#": ["c#", "csharp", "cs", "dotnet", ".net"],
  cs: ["c#", "csharp", "cs", "dotnet", ".net"],
  java: ["java", "jvm"],
  kotlin: ["kotlin", "kt"],
  swift: ["swift"],
  ruby: ["ruby", "rb", "gem"],
  rb: ["ruby", "rb", "gem"],
  php: ["php"],
  shell: ["shell", "bash", "sh", "zsh"],
  bash: ["shell", "bash", "sh", "zsh"],
  sh: ["shell", "bash", "sh", "zsh"],
};

/**
 * Infer the programming language for a repository based on explicit metadata, tags, and summary
 * @param {object} repo
 * @param {string} [requestedLang]
 * @returns {string|null}
 */
export function inferRepoLanguage(repo, requestedLang) {
  if (requestedLang && matchesLanguage(repo, requestedLang)) {
    const low = requestedLang.toLowerCase().trim();
    if (low === "go" || low === "golang") return "Go";
    if (low === "py" || low === "python") return "Python";
    if (low === "rust" || low === "rs") return "Rust";
    if (low === "ts" || low === "typescript") return "TypeScript";
    if (low === "js" || low === "javascript" || low === "node") return "JavaScript";
    if (low === "cpp" || low === "c++") return "C++";
    if (low === "c") return "C";
    if (low === "c#" || low === "csharp" || low === "cs") return "C#";
    if (low === "java") return "Java";
    if (low === "kotlin" || low === "kt") return "Kotlin";
    if (low === "swift") return "Swift";
    if (low === "ruby" || low === "rb") return "Ruby";
    if (low === "php") return "PHP";
    if (low === "shell" || low === "bash" || low === "sh") return "Shell";
    return requestedLang;
  }

  if (repo.language && typeof repo.language === "string" && repo.language.trim()) {
    return repo.language.trim();
  }

  if (matchesLanguage(repo, "rust")) return "Rust";
  if (matchesLanguage(repo, "go")) return "Go";
  if (matchesLanguage(repo, "python")) return "Python";
  if (matchesLanguage(repo, "typescript")) return "TypeScript";
  if (matchesLanguage(repo, "javascript")) return "JavaScript";
  if (matchesLanguage(repo, "c++")) return "C++";
  if (matchesLanguage(repo, "c")) return "C";
  if (matchesLanguage(repo, "c#")) return "C#";
  if (matchesLanguage(repo, "java")) return "Java";
  if (matchesLanguage(repo, "swift")) return "Swift";
  if (matchesLanguage(repo, "ruby")) return "Ruby";
  if (matchesLanguage(repo, "shell")) return "Shell";

  return null;
}

/**
 * Infer the best installation command for a repository
 * @param {object} repo
 * @returns {string}
 */
export function inferInstallCommand(repo) {
  const name = repo.name || repo.full_name || "";
  const baseName = name.includes("/") ? name.split("/")[1] : name;
  const lang = (repo.language || "").toLowerCase();
  const tags = Array.isArray(repo.tags) ? repo.tags.map((t) => t.toLowerCase()) : [];
  const pitch = (repo.summary || repo.elevator_pitch || "").toLowerCase();

  if (lang === "go" || tags.includes("golang") || tags.includes("go")) {
    return `go install github.com/${name}@latest`;
  }

  if (
    lang === "python" ||
    tags.includes("python") ||
    pitch.includes("pip install") ||
    pitch.includes("uv pip")
  ) {
    return `pip install ${baseName.toLowerCase()}`;
  }

  if (lang === "rust" || tags.includes("rust") || tags.includes("cargo")) {
    return `cargo add ${baseName.toLowerCase()}`;
  }

  if (
    lang === "typescript" ||
    lang === "javascript" ||
    tags.includes("mcp") ||
    tags.includes("npm") ||
    tags.includes("node")
  ) {
    if (tags.includes("mcp") || pitch.includes("mcp server")) {
      return `npx -y ${baseName.toLowerCase()}`;
    }
    return `npm install ${baseName.toLowerCase()}`;
  }

  // Fallback to git clone
  const url = repo.url || repo.html_url || `https://github.com/${name}`;
  return `git clone ${url}.git`;
}

/**
 * Check if a repository matches a specified language filter
 * @param {object} repo
 * @param {string} requestedLang
 * @returns {boolean}
 */
function matchesLanguage(repo, requestedLang) {
  if (!requestedLang) return true;

  const target = requestedLang.toLowerCase().trim();
  const allowed = LANGUAGE_ALIASES[target] || [target];

  const repoLang = (repo.language || "").toLowerCase().trim();
  if (repoLang && allowed.includes(repoLang)) {
    return true;
  }

  const tags = Array.isArray(repo.tags) ? repo.tags.map((t) => t.toLowerCase()) : [];
  for (const tag of tags) {
    if (allowed.includes(tag)) {
      return true;
    }
  }

  const pitch = (repo.summary || repo.elevator_pitch || repo.description || "").toLowerCase();
  for (const term of allowed) {
    if (pitch.includes(` ${term} `) || pitch.includes(`(${term})`)) {
      return true;
    }
  }

  return false;
}

/**
 * Recommend stack and libraries for a task description
 * @param {object} options
 * @param {string} options.task_description
 * @param {string} [options.language]
 * @param {number} [options.max_recommendations=5]
 * @param {Array<object>} [options.repos]
 * @param {string} [options.catalogPath]
 * @param {Date} [options.referenceDate]
 * @returns {Promise<object>}
 */
export async function recommendStack(options = {}) {
  const {
    task_description,
    language,
    max_recommendations = 5,
    catalogPath,
    referenceDate = new Date(),
  } = options;

  if (!task_description || typeof task_description !== "string" || !task_description.trim()) {
    throw new Error("task_description is required");
  }

  const limit = Math.max(1, Math.min(20, Number(max_recommendations) || 5));

  let rawRepos = options.repos;
  if (!rawRepos || !Array.isArray(rawRepos) || rawRepos.length === 0) {
    rawRepos = await loadCatalogRepos(catalogPath);
  }

  const repos = (Array.isArray(rawRepos) ? rawRepos : []).filter(
    (r) => r && typeof r === "object"
  );

  // 1. Audit and filter out ARCHIVED and DEAD_ABANDONED projects
  const eligibleRepos = [];
  const auditMap = new Map();

  for (const r of repos) {
    const audit = auditRepository(r, referenceDate);
    auditMap.set(audit.name, audit);

    // Skip archived or dead/abandoned projects
    if (audit.archived || audit.freshness === "ARCHIVED") {
      continue;
    }
    if (audit.freshness === "DEAD_ABANDONED") {
      continue;
    }

    // If language is strictly requested, filter or prioritize
    if (language) {
      if (!matchesLanguage(r, language)) {
        continue;
      }
    }

    eligibleRepos.push(r);
  }

  // Fallback: if strict language filter left no repos, relax to all non-dead repos
  const reposToSearch = eligibleRepos.length > 0 ? eligibleRepos : repos.filter((r) => {
    const a = auditMap.get(r.name) || auditRepository(r, referenceDate);
    return !a.archived && a.freshness !== "DEAD_ABANDONED";
  });

  // 2. Score with BM25 Search Engine
  const engine = new BM25SearchEngine(reposToSearch);
  const searchResults = engine.search(task_description, {
    limit: limit * 2,
    min_score: 0.1,
  });

  // 3. Format top recommendations
  const recommendations = [];

  for (let i = 0; i < searchResults.length; i++) {
    if (recommendations.length >= limit) break;

    const hit = searchResults[i];
    const audit = auditMap.get(hit.name) || auditRepository(hit, referenceDate);
    const installCmd = inferInstallCommand(hit);
    const inferredLang = inferRepoLanguage(hit, language);

    const rationaleParts = [];
    if (hit.elevator_pitch) {
      rationaleParts.push(hit.elevator_pitch);
    }
    const tagsSlice = hit.tags.slice(0, 4);
    if (tagsSlice.length > 0) {
      rationaleParts.push(`Key capabilities: ${tagsSlice.join(", ")}.`);
    }
    rationaleParts.push(`Health score: ${audit.health_score}/100 (${audit.freshness}).`);

    recommendations.push({
      rank: recommendations.length + 1,
      name: hit.name,
      url: hit.url,
      category: hit.category,
      score: hit.score,
      elevator_pitch: hit.elevator_pitch,
      tags: hit.tags,
      language: inferredLang,
      health_score: audit.health_score,
      freshness: audit.freshness,
      install_command: installCmd,
      rationale: rationaleParts.join(" "),
    });
  }

  return {
    task_description: task_description.trim(),
    language: language ? language.trim() : null,
    total_evaluated: repos.length,
    total_considered: repos.length,
    eligible_repositories: reposToSearch.length,
    recommendations_count: recommendations.length,
    recommendations,
  };
}

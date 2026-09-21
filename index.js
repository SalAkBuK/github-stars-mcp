#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".cache");

/**
 * In-memory L1 cache for instant 0ms access within the same session.
 */
const memoryCache = new Map();

/**
 * In-memory store for active multi-agent orchestration sessions
 */
const orchestrationSessions = new Map();

/**
 * Default Baseline Taxonomy
 */
const DEFAULT_BASELINE_TAXONOMY = [
  "AI & Agent Infrastructure",
  "Developer Tools & CLI",
  "System Design & Backend Architecture",
  "Frontend & UI Libraries",
  "Databases & Data Engineering",
  "Security & Reverse Engineering",
  "Educational & Roadmaps",
  "Inspiration & Creative Ideas",
];

/**
 * Cache configuration defaults
 */
const CACHE_TTL = {
  STARS_PAGE: 10 * 60 * 1000, // 10 minutes
  README: 24 * 60 * 60 * 1000, // 24 hours
  USER_INFO: 15 * 60 * 1000, // 15 minutes
  USER_LISTS: 5 * 60 * 1000, // 5 minutes
  SNAPSHOT_MAX_AGE_HOURS: 24,
};

/**
 * Context Profiles configuration
 */
const CONTEXT_PROFILES = {
  compact: {
    targetTokens: 1500,
    defaultPerPage: 4,
    charsPerRepo: 1000,
    description: "Tailored for small context windows (8k-16k, local models, Ollama/LMStudio)",
  },
  standard: {
    targetTokens: 6000,
    defaultPerPage: 8,
    charsPerRepo: 2500,
    description: "Tailored for standard context windows (32k-128k, GPT-4o, Claude Sonnet)",
  },
  deep: {
    targetTokens: 25000,
    defaultPerPage: 15,
    charsPerRepo: 7000,
    description: "Tailored for ultra-large context windows (200k-1M+, Gemini Pro/Flash)",
  },
};

const DEFAULT_PROFILE = process.env.CONTEXT_PROFILE || "standard";
const DEFAULT_TOKEN_BUDGET = process.env.DEFAULT_TOKEN_BUDGET
  ? parseInt(process.env.DEFAULT_TOKEN_BUDGET, 10)
  : null;

/**
 * Ensure disk cache directory exists
 */
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    // ignore if exists
  }
}

/**
 * Atomic write helper for Windows to prevent EBUSY/EPERM file locking errors.
 * Writes to a temporary file (.tmp) and atomically renames with retry backoff.
 */
async function atomicWriteFile(targetPath, data, encoding = "utf-8", retries = 8, retryDelayMs = 50) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const baseName = sanitizeKey(path.basename(targetPath));
  const tmpPath = path.join(dir, `.${baseName}.${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmpPath, data, encoding);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      if (["EBUSY", "EPERM", "EACCES", "EEXIST"].includes(err.code) && attempt < retries - 1) {
        const delay = retryDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      // On Windows, if rename is persistently blocked, fallback to copyFile + unlink
      try {
        await fs.copyFile(tmpPath, targetPath);
        await fs.unlink(tmpPath).catch(() => {});
        return;
      } catch (_) {
        await fs.unlink(tmpPath).catch(() => {});
        throw err;
      }
    }
  }
}

/**
 * Sanitize key for disk filename
 */
function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

/**
 * Startup Garbage Collection: Clean up snapshots and sessions older than 24 hours
 * and orphaned temporary files (.tmp) older than 1 hour.
 */
async function cleanupOldSnapshots(maxAgeHours = CACHE_TTL.SNAPSHOT_MAX_AGE_HOURS) {
  try {
    await ensureCacheDir();
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const maxTmpAgeMs = 60 * 60 * 1000; // 1 hour for orphaned temp files
    for (const file of files) {
      const isTmp = file.endsWith(".tmp") || file.includes(".tmp.") || file.includes(".tmp");
      const isSnapshotOrOrch = file.startsWith("snapshot_") || file.startsWith("orch_");
      if (isTmp || isSnapshotOrOrch) {
        const filePath = path.join(CACHE_DIR, file);
        const stats = await fs.stat(filePath).catch(() => null);
        const allowedAge = isTmp ? maxTmpAgeMs : maxAgeMs;
        if (stats && now - stats.mtimeMs > allowedAge) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Non-critical background cleanup error
  }
}

/**
 * Fast string similarity (Sørensen–Dice coefficient)
 */
function diceCoefficient(str1, str2) {
  if (str1 === str2) return 1.0;
  if (str1.length < 2 || str2.length < 2) return 0.0;

  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.slice(i, i + 2));
    }
    return bigrams;
  };

  const b1 = getBigrams(str1);
  const b2 = getBigrams(str2);
  let intersection = 0;
  for (const gram of b1) {
    if (b2.has(gram)) intersection++;
  }
  return (2.0 * intersection) / (b1.size + b2.size);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize category against baseline taxonomy to prevent taxonomy drift
 */
function normalizeCategory(rawCategory, baselineTaxonomy = DEFAULT_BASELINE_TAXONOMY) {
  const baseline =
    Array.isArray(baselineTaxonomy) && baselineTaxonomy.length > 0
      ? baselineTaxonomy
      : DEFAULT_BASELINE_TAXONOMY;

  if (!rawCategory || typeof rawCategory !== "string") {
    return baseline[0];
  }

  const target = rawCategory.trim();
  const lowerTarget = target.toLowerCase();

  // 1. Exact match
  for (const base of baseline) {
    if (base.toLowerCase() === lowerTarget) return base;
  }

  // 2. Deterministic keyword containment mapping with word-boundary matching
  const keywordMappings = [
    {
      keywords: ["ai", "llm", "agent", "gpt", "rag", "mcp", "model", "prompt", "neural"],
      category: "AI & Agent Infrastructure",
    },
    {
      keywords: ["cli", "tool", "terminal", "utility", "developer", "devtools", "shell", "git"],
      category: "Developer Tools & CLI",
    },
    {
      keywords: ["system", "backend", "distributed", "architecture", "microservice", "server", "game", "infra"],
      category: "System Design & Backend Architecture",
    },
    {
      keywords: ["frontend", "ui", "ux", "css", "component", "react", "vue", "tailwind", "icon", "canvas"],
      category: "Frontend & UI Libraries",
    },
    {
      keywords: ["data", "database", "sql", "nosql", "vector", "cache", "redis", "storage", "analytics"],
      category: "Databases & Data Engineering",
    },
    {
      keywords: ["security", "auth", "crypto", "vulnerability", "reverse", "hack", "penetration", "scanner"],
      category: "Security & Reverse Engineering",
    },
    {
      keywords: ["study", "roadmap", "learn", "book", "guide", "tutorial", "course", "interview", "education"],
      category: "Educational & Roadmaps",
    },
    {
      keywords: ["idea", "inspiration", "awesome", "showcase", "future", "creative", "experimental"],
      category: "Inspiration & Creative Ideas",
    },
  ];

  for (const mapping of keywordMappings) {
    if (baseline.includes(mapping.category)) {
      if (
        mapping.keywords.some((kw) => {
          const regex = new RegExp(`\\b${escapeRegex(kw)}(?:s|es)?\\b`, "i");
          return regex.test(target);
        })
      ) {
        return mapping.category;
      }
    }
  }

  // 3. Fuzzy similarity matching
  let bestMatch = null;
  let bestScore = 0;
  for (const base of baseline) {
    const score = diceCoefficient(lowerTarget, base.toLowerCase());
    if (score > bestScore && score > 0.4) {
      bestScore = score;
      bestMatch = base;
    }
  }

  return bestMatch || target;
}

/**
 * Extract established category headers from an existing catalog file
 */
async function extractExistingCatalogCategories(filePath = "GITHUB_STARS.md") {
  try {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const content = await fs.readFile(resolvedPath, "utf-8");
    const headers = [];
    const lines = content.split(/\r?\n/);
    let inCodeBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = trimmed.match(/^##\s+([^#\n]+)$/);
      if (match) {
        const title = match[1].trim();
        if (title.toLowerCase() !== "table of contents") {
          headers.push(title);
        }
      }
    }
    return headers;
  } catch (err) {
    return [];
  }
}

/**
 * Parse an existing GITHUB_STARS.md catalog file into structured categories, repos,
 * preserving custom user notes, comments, tags, and archived indicators.
 */
function parseCatalogMarkdown(content) {
  const categories = [];
  let currentCategory = null;
  let currentRepo = null;

  const lines = content.split(/\r?\n/);
  let inToc = false;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track code blocks so inner markdown headings or delimiters aren't misparsed
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      if (currentRepo) {
        currentRepo.raw_lines.push(line);
      }
      continue;
    }

    if (inCodeBlock) {
      if (currentRepo) {
        currentRepo.raw_lines.push(line);
      }
      continue;
    }

    // Check for Category Header: ## <Category Name>
    const catMatch = trimmed.match(/^##\s+([^#\n]+)$/);
    if (catMatch) {
      const headerTitle = catMatch[1].trim();
      if (headerTitle.toLowerCase() === "table of contents") {
        inToc = true;
        continue;
      }
      inToc = false;
      currentRepo = null;
      currentCategory = {
        name: headerTitle,
        description: "",
        repos: [],
      };
      categories.push(currentCategory);
      continue;
    }

    if (inToc) continue;

    // Check category description (e.g. *description*)
    if (
      currentCategory &&
      !currentRepo &&
      trimmed.startsWith("*") &&
      trimmed.endsWith("*") &&
      !trimmed.startsWith("**")
    ) {
      currentCategory.description = trimmed.slice(1, -1).trim();
      continue;
    }

    // Check for Repo Header: ### [<name>](<url>) [ARCHIVED]
    const repoMatch = trimmed.match(/^###\s+\[([^\]]+)\]\(([^)]+)\)(.*)$/);
    if (repoMatch) {
      const rawRepoName = repoMatch[1].trim();
      const repoUrl = repoMatch[2].trim();
      const rest = repoMatch[3].trim();
      const isArchived = /\[ARCHIVED\]/i.test(rest) || /\[ARCHIVED\]/i.test(rawRepoName);
      const cleanRepoName = rawRepoName.replace(/\s*\[ARCHIVED\]\s*/i, "").trim();

      currentRepo = {
        name: cleanRepoName,
        url: repoUrl,
        archived: isArchived,
        summary: "",
        custom_notes: "",
        tags: [],
        lists: [],
        sync_status: "synced",
        raw_lines: [],
      };

      if (currentCategory) {
        currentCategory.repos.push(currentRepo);
      } else {
        currentCategory = { name: "Uncategorized", description: "", repos: [currentRepo] };
        categories.push(currentCategory);
      }
      continue;
    }

    // Inside a repo block
    if (currentRepo) {
      if (trimmed === "---") {
        currentRepo = null;
        continue;
      }

      // Metadata line: **Tags**: ... | **List**: ...
      if (trimmed.startsWith("**Tags**:") || trimmed.startsWith("**List**:")) {
        const tagMatch = trimmed.match(/\*\*Tags\*\*:\s*`([^`]+(?:`,\s*`[^`]+)*)`/);
        if (tagMatch) {
          currentRepo.tags = tagMatch[1].split(/`,\s*`/);
        } else {
          // Fallback parsing for unquoted or raw comma-separated tags
          const rawTagMatch = trimmed.match(/\*\*Tags\*\*:\s*([^|]+)/);
          if (rawTagMatch) {
            currentRepo.tags = rawTagMatch[1]
              .split(",")
              .map((t) => t.replace(/[`*]/g, "").trim())
              .filter(Boolean);
          }
        }
        const listMatch = trimmed.match(/\*\*List\*\*:\s*\*([^*]+)\*/);
        if (listMatch) {
          const listText = listMatch[1].replace(/\(⚠️.*?\)/, "").trim();
          currentRepo.lists = listText.split(/,\s*/);
        }
        if (trimmed.includes("⚠️ Local Tag Only")) {
          currentRepo.sync_status = "local_only";
        }
        continue;
      }

      currentRepo.raw_lines.push(line);
    }
  }

  // Post-process repo raw_lines into summary and custom_notes
  const isNoteParagraph = (p) => {
    if (!p) return false;
    return (
      p.startsWith(">") ||
      p.startsWith("<!--") ||
      p.startsWith("```") ||
      p.startsWith("~~~") ||
      /^\*?\*?(?:note|notes|comment|comments|personal note|user note|my note|my notes|todo|review)\*?\*?:/i.test(p)
    );
  };

  for (const cat of categories) {
    for (const repo of cat.repos) {
      const paragraphs = [];
      let curPara = [];
      let insideCode = false;

      for (const line of repo.raw_lines) {
        if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
          insideCode = !insideCode;
        }
        if (!insideCode && line.trim().length === 0) {
          if (curPara.length > 0) {
            paragraphs.push(curPara.join("\n").trim());
            curPara = [];
          }
        } else {
          curPara.push(line);
        }
      }
      if (curPara.length > 0) {
        paragraphs.push(curPara.join("\n").trim());
      }

      if (paragraphs.length === 0) {
        repo.summary = "";
        repo.custom_notes = "";
      } else {
        const firstNoteIdx = paragraphs.findIndex(isNoteParagraph);
        if (firstNoteIdx === -1) {
          repo.summary = paragraphs.join("\n\n");
          repo.custom_notes = "";
        } else if (firstNoteIdx === 0) {
          repo.summary = "";
          repo.custom_notes = paragraphs.join("\n\n");
        } else {
          repo.summary = paragraphs.slice(0, firstNoteIdx).join("\n\n");
          repo.custom_notes = paragraphs.slice(firstNoteIdx).join("\n\n");
        }
      }
      delete repo.raw_lines;
    }
  }

  return categories;
}

function normalizeStringArray(val) {
  if (Array.isArray(val)) {
    return val.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof val === "string" && val.trim()) {
    return val.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Safely resolve and sanitize category names, falling back to 'Uncategorized'
 * if the category name is missing, empty, only whitespace, or null.
 */
function resolveCategoryName(cat) {
  if (!cat || typeof cat !== "object") return "Uncategorized";
  if (typeof cat.name === "string" && cat.name.trim()) return cat.name.trim();
  if (typeof cat.category === "string" && cat.category.trim()) return cat.category.trim();
  if (cat.name != null && String(cat.name).trim()) return String(cat.name).trim();
  if (cat.category != null && String(cat.category).trim()) return String(cat.category).trim();
  return "Uncategorized";
}

/**
 * Intelligently merge existing catalog categories with incoming categories.
 * Preserves custom notes/comments, user tags, and handles reclassifications.
 */
function mergeCatalogCategories(existingCategories, incomingCategories) {
  if (!existingCategories || existingCategories.length === 0) {
    return incomingCategories || [];
  }
  if (!incomingCategories || incomingCategories.length === 0) {
    return existingCategories || [];
  }

  const mergedMap = new Map();
  const normKey = (str) => String(str || "").trim().toLowerCase();

  // 1. Populate map with existing categories
  for (const existingCat of existingCategories) {
    if (!existingCat) continue;
    const catName = resolveCategoryName(existingCat);
    const key = normKey(catName);
    if (mergedMap.has(key)) {
      const existing = mergedMap.get(key);
      existing.repos.push(...(existingCat.repos || []));
    } else {
      mergedMap.set(key, {
        name: catName,
        description: existingCat.description || "",
        repos: [...(existingCat.repos || [])],
      });
    }
  }

  const norm = (str) => String(str || "").trim().toLowerCase().replace(/\/+$/, "");

  // 2. Merge incoming categories and repos
  for (const incomingCat of incomingCategories) {
    if (!incomingCat) continue;
    const catName = resolveCategoryName(incomingCat);
    const key = normKey(catName);
    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        name: catName,
        description: incomingCat.description || "",
        repos: [],
      });
    }

    const targetCat = mergedMap.get(key);
    if (incomingCat.description && !targetCat.description) {
      targetCat.description = incomingCat.description;
    }

    for (const incomingRepo of incomingCat.repos || []) {
      if (!incomingRepo) continue;
      const incomingName = incomingRepo.name != null && String(incomingRepo.name).trim()
        ? String(incomingRepo.name).trim()
        : (incomingRepo.full_name != null ? String(incomingRepo.full_name).trim() : "");
      const existingIdx = targetCat.repos.findIndex(
        (r) =>
          norm(r.name) === norm(incomingName) ||
          (r.url && incomingRepo.url && norm(r.url) === norm(incomingRepo.url))
      );

      if (existingIdx >= 0) {
        const existingRepo = targetCat.repos[existingIdx];
        targetCat.repos[existingIdx] = {
          name: incomingName || existingRepo.name,
          url: incomingRepo.url || existingRepo.url,
          archived:
            incomingRepo.archived !== undefined
              ? Boolean(incomingRepo.archived)
              : Boolean(existingRepo.archived),
          summary: incomingRepo.summary || existingRepo.summary,
          custom_notes: existingRepo.custom_notes || incomingRepo.custom_notes || "",
          tags: Array.from(
            new Set([...normalizeStringArray(incomingRepo.tags), ...normalizeStringArray(existingRepo.tags)])
          ),
          lists: Array.from(
            new Set([...normalizeStringArray(incomingRepo.lists), ...normalizeStringArray(existingRepo.lists)])
          ),
          sync_status: incomingRepo.sync_status || existingRepo.sync_status,
        };
      } else {
        // Check if repo existed in another category (moved/reclassified)
        let foundInOtherCat = false;
        for (const [otherCatKey, otherCat] of mergedMap.entries()) {
          if (otherCatKey === key) continue;
          const otherIdx = otherCat.repos.findIndex(
            (r) =>
              norm(r.name) === norm(incomingName) ||
              (r.url && incomingRepo.url && norm(r.url) === norm(incomingRepo.url))
          );
          if (otherIdx >= 0) {
            const oldRepo = otherCat.repos.splice(otherIdx, 1)[0];
            targetCat.repos.push({
              ...incomingRepo,
              name: incomingName || oldRepo.name,
              archived:
                incomingRepo.archived !== undefined
                  ? Boolean(incomingRepo.archived)
                  : Boolean(oldRepo.archived),
              summary: incomingRepo.summary || oldRepo.summary,
              custom_notes: oldRepo.custom_notes || incomingRepo.custom_notes || "",
              tags: Array.from(
                new Set([...normalizeStringArray(incomingRepo.tags), ...normalizeStringArray(oldRepo.tags)])
              ),
              lists: Array.from(
                new Set([...normalizeStringArray(incomingRepo.lists), ...normalizeStringArray(oldRepo.lists)])
              ),
              sync_status: incomingRepo.sync_status || oldRepo.sync_status,
            });
            foundInOtherCat = true;
            break;
          }
        }
        if (!foundInOtherCat) {
          targetCat.repos.push({
            ...incomingRepo,
            name: incomingName || "Unknown Repository",
            archived: Boolean(incomingRepo.archived),
            tags: normalizeStringArray(incomingRepo.tags),
            lists: normalizeStringArray(incomingRepo.lists),
          });
        }
      }
    }
  }

  // Filter out any categories that became empty, maintaining order
  return Array.from(mergedMap.values()).filter((c) => c.repos && c.repos.length > 0);
}

/**
 * Get item from L1 (memory) or L2 (disk) cache
 */
async function getCache(key) {
  const now = Date.now();

  if (memoryCache.has(key)) {
    const entry = memoryCache.get(key);
    if (entry.expiresAt > now) {
      return { data: entry.data, etag: entry.etag, from: "memory" };
    }
    memoryCache.delete(key);
  }

  try {
    const filePath = path.join(CACHE_DIR, `${sanitizeKey(key)}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    const entry = JSON.parse(raw);
    if (entry.expiresAt > now) {
      memoryCache.set(key, entry);
      return { data: entry.data, etag: entry.etag, from: "disk" };
    } else {
      await fs.unlink(filePath).catch(() => {});
    }
  } catch (err) {
    // Disk miss
  }

  return null;
}

let cacheWriteEpoch = 0;
const pendingCacheWrites = new Map();

/**
 * Set item in L1 (memory) and L2 (disk) cache
 */
async function setCache(key, data, ttlMs, etag = null) {
  const expiresAt = Date.now() + ttlMs;
  const entry = { data, etag, expiresAt };

  memoryCache.set(key, entry);

  const writeEpoch = ++cacheWriteEpoch;
  pendingCacheWrites.set(key, writeEpoch);

  setImmediate(async () => {
    if (pendingCacheWrites.get(key) !== writeEpoch) {
      return; // Invalidation or newer write occurred; abort writing stale entry
    }
    try {
      await ensureCacheDir();
      const filePath = path.join(CACHE_DIR, `${sanitizeKey(key)}.json`);
      if (pendingCacheWrites.get(key) !== writeEpoch) return;
      await atomicWriteFile(filePath, JSON.stringify(entry), "utf-8");
      if (pendingCacheWrites.get(key) === writeEpoch) {
        pendingCacheWrites.delete(key);
      }
    } catch (err) {
      // Non-critical cache write error
    }
  });
}

/**
 * Invalidate item in L1 (memory) and L2 (disk) cache
 */
async function invalidateCache(key) {
  memoryCache.delete(key);
  pendingCacheWrites.delete(key);
  try {
    const filePath = path.join(CACHE_DIR, `${sanitizeKey(key)}.json`);
    await fs.unlink(filePath).catch(() => {});
  } catch (err) {
    // ignore
  }
}

const sessionLoadPromises = new Map();

/**
 * Load orchestration session
 */
async function getOrchestrationSession(sessionId) {
  if (orchestrationSessions.has(sessionId)) {
    return orchestrationSessions.get(sessionId);
  }
  if (sessionLoadPromises.has(sessionId)) {
    return sessionLoadPromises.get(sessionId);
  }

  const loadPromise = (async () => {
    try {
      const filePath = path.join(CACHE_DIR, `orch_${sanitizeKey(sessionId)}.json`);
      const raw = await fs.readFile(filePath, "utf-8");
      const session = JSON.parse(raw);
      if (session) {
        if (session.archived_repos) {
          session.archived_repos = Object.assign(Object.create(null), session.archived_repos);
        }
        if (session.repos_by_name) {
          session.repos_by_name = Object.assign(Object.create(null), session.repos_by_name);
        }
        if (session.categories) {
          session.categories = Object.assign(Object.create(null), session.categories);
        }
        if (session.workers) {
          session.workers = Object.assign(Object.create(null), session.workers);
        }
      }
      orchestrationSessions.set(sessionId, session);
      return session;
    } catch (err) {
      return null;
    } finally {
      sessionLoadPromises.delete(sessionId);
    }
  })();

  sessionLoadPromises.set(sessionId, loadPromise);
  return loadPromise;
}

/**
 * Save orchestration session using atomic write to eliminate EBUSY on Windows
 */
async function saveOrchestrationSession(sessionId, sessionData) {
  orchestrationSessions.set(sessionId, sessionData);

  try {
    await ensureCacheDir();
    const filePath = path.join(CACHE_DIR, `orch_${sanitizeKey(sessionId)}.json`);
    await atomicWriteFile(filePath, JSON.stringify(sessionData, null, 2), "utf-8");
  } catch (err) {
    // Non-critical write error
  }
}

/**
 * Save static snapshot for session using atomic write
 */
async function saveSnapshot(sessionId, repos) {
  await ensureCacheDir();
  const filePath = path.join(CACHE_DIR, `snapshot_${sanitizeKey(sessionId)}.json`);
  await atomicWriteFile(filePath, JSON.stringify(repos), "utf-8");
}

/**
 * Load static snapshot for session
 */
async function loadSnapshot(sessionId) {
  try {
    const filePath = path.join(CACHE_DIR, `snapshot_${sanitizeKey(sessionId)}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Delete snapshot file (on completion or cleanup)
 */
async function deleteSnapshot(sessionId) {
  try {
    const filePath = path.join(CACHE_DIR, `snapshot_${sanitizeKey(sessionId)}.json`);
    await fs.unlink(filePath).catch(() => {});
  } catch (err) {
    // ignore
  }
}

let cachedGhCliToken = null;
let cachedGhCliTokenExpiresAt = 0;

function clearCachedGitHubToken() {
  cachedGhCliToken = null;
  cachedGhCliTokenExpiresAt = 0;
}

/**
 * Resolve GitHub authentication token from environment or gh CLI
 * Caches resolved gh CLI token in memory for 1 hour to prevent synchronous process spawning.
 */
function getGitHubToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }
  if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) {
    return process.env.GH_TOKEN.trim();
  }
  const now = Date.now();
  if (cachedGhCliToken && cachedGhCliTokenExpiresAt > now) {
    return cachedGhCliToken;
  }
  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      cachedGhCliToken = token;
      cachedGhCliTokenExpiresAt = now + 60 * 60 * 1000; // 1-hour TTL
      return token;
    }
  } catch (err) {
    // gh CLI might not be authenticated
  }
  throw new Error(
    "No GitHub token found. Please set the GITHUB_TOKEN environment variable or authenticate via 'gh auth login'."
  );
}

/**
 * Distill README content: strips badges, HTML noise, and boilerplate sections.
 * Masks fenced and inline code blocks before HTML & boilerplate removal to protect
 * generics, code comments, and embedded HTML examples.
 */
function distillReadme(text, maxChars = 2500) {
  if (!text) return { content: "", truncated: false };

  const codeBlocks = [];
  const nonce = "NONCE_" + Math.random().toString(36).slice(2, 8);

  // 1. Mask fenced code blocks (supporting 3+ backticks or tildes, nested blocks, and unclosed EOF blocks)
  const fencedRegex = /(?:^|\r?\n)([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)([\s\S]*?)(?:(?:\r?\n)\1\2[ \t]*(?=\r?\n|$)|$)/g;
  let masked = text.replace(fencedRegex, (match) => {
    const placeholder = `__FENCED_${nonce}_${codeBlocks.length}__`;
    codeBlocks.push(match);
    return "\n" + placeholder + "\n";
  });

  // 2. Mask inline code spans (`...`)
  const inlineBlocks = [];
  masked = masked.replace(/(`+)([\s\S]*?)\1/g, (match) => {
    const placeholder = `__INLINE_${nonce}_${inlineBlocks.length}__`;
    inlineBlocks.push(match);
    return placeholder;
  });

  // 3. Strip badges, HTML noise, comments, void tags, media containers, and markup tags
  let cleaned = masked
    .replace(/\[\!\[[^\]]*\]\([^)]*\)\](?:\([^)]*\))?/g, "") // badges with outer link
    .replace(/\!\[[^\]]*\]\([^)]*\)/g, "")                   // raw image badges
    .replace(/<!--[\s\S]*?-->/g, "")                         // html comments
    .replace(/<(picture|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")   // strip whole-tag media/graphic container elements
    .replace(/<(?:img|source|br|hr|wbr)\b[^>]*\/?>/gi, "")   // void html elements
    .replace(/<\/?(div|p|details|summary|span)\b[^>]*>/gi, "") // strip layout markup tags while preserving inner text
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");                     // strip any remaining html tags without breaking inequalities (0 < min_val)

  // 4. Strip boilerplate sections (# License, # Contributing, etc.) bounded to next heading of equal or higher level or EOF
  const unboilered = cleaned
    .replace(
      /(?:^|\r?\n)#{1,3}\s+(?:License|Contributing|Code of Conduct|Contributors|Acknowledgments|Sponsors|Changelog|Release Notes)\b[\s\S]*?(?=(?:\r?\n#{1,3}\s+|$))/gi,
      ""
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // markdown links -> link text

  // 5. Restore inline code spans
  let restored = unboilered.replace(new RegExp(`__INLINE_${nonce}_(\\d+)__`, "g"), (_, idx) => {
    return inlineBlocks[Number(idx)] || "";
  });

  // 6. Restore fenced code blocks
  restored = restored.replace(new RegExp(`__FENCED_${nonce}_(\\d+)__`, "g"), (_, idx) => {
    return codeBlocks[Number(idx)] || "";
  });

  cleaned = restored.replace(/\n{3,}/g, "\n\n").trim();

  let truncated = false;
  if (cleaned.length > maxChars) {
    const cut = cleaned.slice(0, maxChars);
    const lastParagraph = cut.lastIndexOf("\n\n");
    if (lastParagraph > maxChars * 0.7) {
      cleaned = cut.slice(0, lastParagraph) + "\n\n... [Distilled README truncated to fit token budget]";
    } else {
      cleaned = cut + "\n... [Distilled README truncated to fit token budget]";
    }
    // If truncation cut inside a fenced code block, close it so subsequent text is not swallowed
    const fenceMatches = (cleaned.match(/```|~~~/g) || []).length;
    if (fenceMatches % 2 !== 0) {
      cleaned = cleaned + "\n```\n";
    }
    truncated = true;
  }

  return { content: cleaned, truncated };
}

/**
 * Generate fallback context when README is missing or < 50 characters
 */
function generateFallbackReadme(repo) {
  if (!repo) repo = {};
  const name =
    repo.full_name ||
    (repo.owner ? `${typeof repo.owner === "object" ? repo.owner.login : repo.owner}/${repo.name}` : repo.name) ||
    "Repository";
  const desc = repo.description?.trim() || "No description provided.";
  const lang = repo.language || "Not specified";
  const topics =
    Array.isArray(repo.topics) && repo.topics.length > 0 ? repo.topics.join(", ") : "None";

  return [
    `# ${name}`,
    ``,
    `${desc}`,
    ``,
    `**Language**: ${lang}`,
    `**Topics**: ${topics}`,
    ``,
    `*(Note: Repository README is missing or under 50 characters. Fallback context generated from repository metadata.)*`,
  ].join("\n");
}

/**
 * Sleep helper that respects an AbortSignal.
 * Immediately rejects if signal is aborted before or during the sleep duration.
 */
function sleepWithSignal(ms, signal) {
  if (signal?.aborted) {
    const err = signal.reason || new Error("This operation was aborted");
    if (!err.name || err.name === "Error") err.name = "AbortError";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      const err = signal.reason || new Error("This operation was aborted");
      if (!err.name || err.name === "Error") err.name = "AbortError";
      reject(err);
    };
    timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Execute GitHub REST API request with optional conditional ETag caching
 * and automatic exponential backoff retry on HTTP 403 (rate limit / abuse) & HTTP 429.
 */
async function githubRest(endpoint, options = {}) {
  const token = options.token || getGitHubToken();
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const headers = {
    "User-Agent": "github-stars-mcp/1.4.0",
    Authorization: `Bearer ${token}`,
    Accept: options.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };

  if (options.etag) {
    headers["If-None-Match"] = options.etag;
  }

  const MAX_RETRIES = options.maxRetries !== undefined ? options.maxRetries : 3;
  const baseDelay = options.baseDelayMs || 1000;
  const maxDelay = options.maxDelayMs !== undefined ? options.maxDelayMs : 60000;
  let attempt = 0;

  while (true) {
    let res;
    try {
      const requestSignal = options.signal
        ? (typeof AbortSignal.any === "function"
            ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs || 30000)])
            : options.signal)
        : AbortSignal.timeout(options.timeoutMs || 30000);

      res = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
        signal: requestSignal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      if (attempt < MAX_RETRIES) {
        attempt++;
        const backoffMs = Math.min(
          baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * (baseDelay * 0.5)),
          maxDelay
        );
        console.error(
          `[github-stars-mcp] Transient network error (${err.message || err.name}). Retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_RETRIES})...`
        );
        await sleepWithSignal(backoffMs, options.signal);
        continue;
      }
      throw err;
    }

    if (res.status === 304 && options.cachedData) {
      return { data: options.cachedData, notModified: true, etag: options.etag, headers: res.headers };
    }

    if ((res.status === 429 || res.status === 403) && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get("retry-after");
      const rlResetHeader = res.headers.get("x-ratelimit-reset");
      const rlRemainingHeader = res.headers.get("x-ratelimit-remaining");

      let isRateLimitOrAbuse =
        res.status === 429 || Boolean(retryAfterHeader) || rlRemainingHeader === "0";
      let errorBody = "";

      if (!isRateLimitOrAbuse && res.status === 403) {
        try {
          errorBody = await res.clone().text();
          if (/secondary rate limit|abuse|rate limit|temporarily blocked/i.test(errorBody)) {
            isRateLimitOrAbuse = true;
          }
        } catch (_) {}
      }

      if (isRateLimitOrAbuse) {
        attempt++;
        let backoffMs = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * (baseDelay * 0.5));

        if (retryAfterHeader) {
          let parsedSec = parseFloat(retryAfterHeader);
          if (isNaN(parsedSec)) {
            const dateMs = Date.parse(retryAfterHeader);
            if (!isNaN(dateMs)) {
              parsedSec = Math.max(0, (dateMs - Date.now()) / 1000);
            }
          }
          if (!isNaN(parsedSec) && parsedSec > 0) {
            const multiplier = options.retryAfterMultiplier || 1000;
            backoffMs = Math.ceil(parsedSec * multiplier) + Math.floor(Math.random() * (baseDelay * 0.5));
          }
        } else if (rlResetHeader) {
          const resetEpoch = parseInt(rlResetHeader, 10);
          if (!isNaN(resetEpoch)) {
            const waitTime = resetEpoch * 1000 - Date.now();
            if (waitTime > 0) {
              backoffMs = waitTime + Math.floor(Math.random() * 1000);
            }
          }
        }

        // Strictly enforce delay capping on all rate limit and abuse branches
        backoffMs = Math.min(backoffMs, maxDelay);

        console.error(
          `[github-stars-mcp] Rate limit/abuse hit (HTTP ${res.status}). Retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_RETRIES})...`
        );
        await sleepWithSignal(backoffMs, options.signal);
        continue;
      }
    }

    if (!res.ok) {
      if (res.status === 401) {
        clearCachedGitHubToken();
      }
      if (res.status === 404 && options.allow404) {
        return null;
      }
      const text = await res.text();
      throw new Error(`GitHub API error (${res.status}): ${text}`);
    }

    const newEtag = res.headers.get("etag");
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return { data: null, notModified: false, etag: newEtag, headers: res.headers };
    }

    let data;
    if (options.raw) {
      data = await res.text();
    } else {
      data = await res.json();
    }

    return { data, notModified: false, etag: newEtag, headers: res.headers };
  }
}

/**
 * Execute GitHub GraphQL API request
 */
async function githubGraphQL(query, variables = {}, options = {}) {
  const token = options.token || getGitHubToken();
  const endpoint = options.endpoint || "https://api.github.com/graphql";
  const result = await githubRest(endpoint, {
    method: "POST",
    token,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: { query, variables },
    timeoutMs: options.timeoutMs || 30000,
    ...options,
  });

  const data = result.data;
  if (data && data.errors && data.errors.length > 0) {
    const messages = data.errors.map((e) => e.message).join("; ");
    throw new Error(`GitHub GraphQL error: ${messages}`);
  }
  return data?.data;
}

/**
 * Fetch raw README for a repo with ETag caching
 */
async function getReadmeCached(owner, repo, refresh = false) {
  const cacheKey = `readme_${owner}_${repo}`;

  if (!refresh) {
    const cached = await getCache(cacheKey);
    if (cached) {
      return { content: cached.data, fromCache: cached.from };
    }
  }

  const result = await githubRest(`/repos/${owner}/${repo}/readme`, {
    accept: "application/vnd.github.raw",
    raw: true,
    allow404: true,
  });

  if (!result || result.data === null) {
    return { content: null, fromCache: false };
  }

  await setCache(cacheKey, result.data, CACHE_TTL.README, result.etag);
  return { content: result.data, fromCache: false };
}

/**
 * Fetch starred page with caching
 */
async function getStarredPageCached(page, perPage, sort, direction, refresh = false) {
  const cacheKey = `starred_p${page}_n${perPage}_${sort}_${direction}`;

  if (!refresh) {
    const cached = await getCache(cacheKey);
    if (cached) {
      return { items: cached.data, fromCache: cached.from };
    }
  }

  const res = await githubRest(
    `/user/starred?page=${page}&per_page=${perPage}&sort=${sort}&direction=${direction}`,
    {
      accept: "application/vnd.github.star+json",
    }
  );

  await setCache(cacheKey, res.data, CACHE_TTL.STARS_PAGE, res.etag);
  return { items: res.data, fromCache: false };
}

/**
 * Fetch all starred repositories in one full snapshot to freeze indices
 */
async function fetchAllStarsSnapshot() {
  const allRepos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await githubRest(
      `/user/starred?page=${page}&per_page=${perPage}&sort=created&direction=desc`,
      {
        accept: "application/vnd.github.star+json",
      }
    );

    const items = res.data;
    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      const repo = item.repo;
      allRepos.push({
        index: allRepos.length + 1,
        node_id: repo.node_id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner?.login,
        description: repo.description,
        language: repo.language,
        topics: repo.topics || [],
        stars: repo.stargazers_count,
        url: repo.html_url,
        starred_at: item.starred_at,
        archived: Boolean(repo.archived),
      });
    }

    if (items.length < perPage) break;
    page++;
  }

  return allRepos;
}

/**
 * Concurrency limiting helpers: batch async tasks in chunks (default 5)
 * to avoid triggering GitHub secondary abuse and rate limits.
 */
async function chunkedAsyncMap(items, fn, chunkSize = 5) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const validChunkSize = Math.max(1, chunkSize || 5);
  const results = [];
  for (let i = 0; i < items.length; i += validChunkSize) {
    const chunk = items.slice(i, i + validChunkSize);
    const chunkResults = await Promise.all(
      chunk.map((item, idx) => fn(item, i + idx, items))
    );
    results.push(...chunkResults);
  }
  return results;
}

async function chunkedAsyncAllSettled(items, fn, chunkSize = 5) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const validChunkSize = Math.max(1, chunkSize || 5);
  const results = [];
  for (let i = 0; i < items.length; i += validChunkSize) {
    const chunk = items.slice(i, i + validChunkSize);
    const chunkResults = await Promise.allSettled(
      chunk.map((item, idx) => fn(item, i + idx, items))
    );
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Speculative Prefetching
 */
function triggerPrefetch(nextPage, perPage, sort, direction) {
  setImmediate(async () => {
    try {
      const { items } = await getStarredPageCached(
        nextPage,
        perPage,
        sort,
        direction,
        false
      );
      if (Array.isArray(items) && items.length > 0) {
        await chunkedAsyncAllSettled(
          items,
          (item) => {
            const owner = item.repo?.owner?.login;
            const name = item.repo?.name;
            if (owner && name) {
              return getReadmeCached(owner, name, false);
            }
          },
          5
        );
      }
    } catch (err) {
      // Silent background prefetch fail
    }
  });
}

/**
 * Create and configure MCP Server
 */
const server = new Server(
  {
    name: "github-stars-mcp",
    version: "1.4.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool definitions
const TOOLS = [
  {
    name: "github_orchestrate_workers",
    description:
      "Map-Reduce Step 1: Takes an immutable frozen snapshot of all starred repos (eliminating mid-run mutation drift), extracts baseline taxonomy, and generates balanced worker chunk plans.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional custom session identifier. Defaults to auto-generated ID.",
        },
        num_workers: {
          type: "number",
          description: "Number of parallel workers to partition work across (default: 4).",
        },
        profile: {
          type: "string",
          enum: ["compact", "standard", "deep"],
          description: "Context profile recommended for the workers (default: 'compact').",
        },
        custom_categories: {
          type: "array",
          items: { type: "string" },
          description: "Optional custom category names to add to the baseline taxonomy.",
        },
      },
    },
  },
  {
    name: "github_get_worker_chunk",
    description:
      "Worker Tool: Fetches the exact frozen snapshot chunk assigned to this worker by session_id and worker_id, including pre-distilled READMEs.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The active orchestration session identifier.",
        },
        worker_id: {
          type: "string",
          description: "The worker identifier (e.g. 'worker-1').",
        },
        profile: {
          type: "string",
          enum: ["compact", "standard", "deep"],
          description: "Context window profile for README budget (default: 'compact').",
        },
      },
      required: ["session_id", "worker_id"],
    },
  },
  {
    name: "github_submit_worker_digest",
    description:
      "Map-Reduce Step 2: Allows sub-agents to submit their distilled category & pitch digest. Validates against baseline taxonomy, prevents reassigned worker race conditions, and handles GraphQL list sync fallback.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The active orchestration session identifier.",
        },
        worker_id: {
          type: "string",
          description: "Worker ID submitting this digest (e.g. 'worker-1').",
        },
        analyzed_repos: {
          type: "array",
          description: "List of repositories analyzed by this worker.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Full repository name (e.g. 'owner/repo').",
              },
              url: {
                type: "string",
                description: "GitHub repository URL.",
              },
              node_id: {
                type: "string",
                description: "Optional GraphQL Node ID for list assignment.",
              },
              category: {
                type: "string",
                description: "High-level category from baseline taxonomy.",
              },
              elevator_pitch: {
                type: "string",
                description: "1-2 sentence core value proposition distilled from README.",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "3 to 5 key keywords or technologies.",
              },
              recommended_lists: {
                type: "array",
                items: { type: "string" },
                description: "Optional recommended GitHub list names.",
              },
            },
            required: ["name", "url", "category", "elevator_pitch", "tags"],
          },
        },
      },
      required: ["session_id", "worker_id", "analyzed_repos"],
    },
  },
  {
    name: "github_force_reduce_session",
    description:
      "Resilience Tool: Force-reduces an orchestration session when a worker is orphaned, times out, or fails. Can proceed with available repos or reassign missing chunks.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Orchestration session identifier.",
        },
        missing_worker_policy: {
          type: "string",
          enum: ["proceed_with_available", "reassign"],
          description:
            "Policy: 'proceed_with_available' compiles catalog immediately with completed data; 'reassign' generates new retry worker plans for failed chunks.",
        },
      },
      required: ["session_id", "missing_worker_policy"],
    },
  },
  {
    name: "github_get_orchestration_status",
    description:
      "Inspect current progress, completed workers, worker state machine, and compiled categories of an orchestration session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Orchestration session identifier.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "github_get_user_info",
    description:
      "Get authenticated GitHub user details and total count of starred repositories (cached with 15min TTL).",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Force live refresh from GitHub API, bypassing cache.",
        },
      },
    },
  },
  {
    name: "github_list_starred",
    description:
      "Fetch a paginated list of starred repositories with details (cached with 10min TTL).",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number (1-indexed). Default is 1.",
        },
        per_page: {
          type: "number",
          description: "Number of repositories per page (default: 10, max: 30).",
        },
        sort: {
          type: "string",
          enum: ["created", "updated"],
          description: "Sort by star creation date or repository update date. Default: created.",
        },
        direction: {
          type: "string",
          enum: ["desc", "asc"],
          description: "Sort direction. Default: desc.",
        },
        refresh: {
          type: "boolean",
          description: "Force live refresh from GitHub API, bypassing cache.",
        },
      },
    },
  },
  {
    name: "github_get_readme",
    description:
      "Fetch the README markdown for a repository with semantic distillation, ETag caching (24h TTL), and context budget controls.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (e.g. 'astralapp').",
        },
        repo: {
          type: "string",
          description: "Repository name (e.g. 'astral').",
        },
        profile: {
          type: "string",
          enum: ["compact", "standard", "deep"],
          description: "Context window profile. Default is 'standard'.",
        },
        distill: {
          type: "boolean",
          description: "Strip badges and HTML noise to save tokens (default: true).",
        },
        max_chars: {
          type: "number",
          description: "Maximum number of characters to return.",
        },
        refresh: {
          type: "boolean",
          description: "Bypass cache and fetch fresh README from GitHub.",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_batch_get_starred_with_readme",
    description:
      "High-performance batch tool: fetches starred repositories + distilled READMEs with dynamic token budgeting, local caching, and speculative next-batch prefetching.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "number",
          description: "Page number (1-indexed). Default is 1.",
        },
        per_page: {
          type: "number",
          description: "Number of repositories in this batch.",
        },
        profile: {
          type: "string",
          enum: ["compact", "standard", "deep"],
          description: "Context window profile. Default: 'standard'.",
        },
        token_budget: {
          type: "number",
          description: "Explicit token budget for the entire batch payload.",
        },
        distill: {
          type: "boolean",
          description: "Enable semantic distillation. Default: true.",
        },
        prefetch_next: {
          type: "boolean",
          description: "Speculatively prefetch the next batch in background. Default: true.",
        },
        refresh: {
          type: "boolean",
          description: "Force live refresh from GitHub API, bypassing cache.",
        },
        sort: {
          type: "string",
          enum: ["created", "updated"],
          description: "Sort order. Default is 'created'.",
        },
        direction: {
          type: "string",
          enum: ["desc", "asc"],
          description: "Sort direction. Default is 'desc'.",
        },
      },
    },
  },
  {
    name: "github_clear_cache",
    description: "Clear memory and disk caches for GitHub stars and READMEs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "github_get_user_lists",
    description:
      "Get all native GitHub Star Lists created by the authenticated user along with their current items and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Bypass cache and query GitHub GraphQL live.",
        },
      },
    },
  },
  {
    name: "github_create_user_list",
    description:
      "Create a new native GitHub Star List on github.com (requires token with 'user' scope).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the new list (e.g., 'AI & LLM Tools').",
        },
        description: {
          type: "string",
          description: "Optional description of the list.",
        },
        is_private: {
          type: "boolean",
          description: "Whether the list should be private. Default: false.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "github_assign_repo_to_lists",
    description:
      "Assign or update a repository's membership in native GitHub Star Lists (requires token with 'user' scope).",
    inputSchema: {
      type: "object",
      properties: {
        repo_node_id: {
          type: "string",
          description: "The GraphQL node ID of the repository.",
        },
        list_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of UserList IDs.",
        },
      },
      required: ["repo_node_id", "list_ids"],
    },
  },
  {
    name: "github_export_catalog",
    description:
      "Save or update an organized Markdown catalog file (e.g. GITHUB_STARS.md) grouping repositories by category with summaries and tags.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Destination file path. Default: 'GITHUB_STARS.md'.",
        },
        catalog_title: {
          type: "string",
          description: "Main title of the catalog. Default: 'Organized GitHub Stars'.",
        },
        mode: {
          type: "string",
          enum: ["merge", "overwrite"],
          description:
            "Export mode: 'merge' preserves existing repos, custom user notes, and manual comments in GITHUB_STARS.md; 'overwrite' replaces the entire file. Default: 'merge'.",
        },
        categories: {
          type: "array",
          description: "List of categories with their repositories.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Category name" },
              description: {
                type: "string",
                description: "Brief description of this category",
              },
              repos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Repo full name (owner/repo)" },
                    url: { type: "string", description: "GitHub URL" },
                    archived: {
                      type: "boolean",
                      description: "Whether repository is archived on GitHub",
                    },
                    summary: {
                      type: "string",
                      description: "1-2 sentence overview of what the repo does",
                    },
                    tags: {
                      type: "array",
                      items: { type: "string" },
                      description: "Key topics/tags",
                    },
                    lists: {
                      type: "array",
                      items: { type: "string" },
                      description: "GitHub Lists assigned",
                    },
                    sync_status: {
                      type: "string",
                      description: "e.g. 'synced' or 'local_only'",
                    },
                  },
                  required: ["name", "url", "summary"],
                },
              },
            },
            required: ["name", "repos"],
          },
        },
        compiled_categories: {
          type: "array",
          description: "Alternative parameter name for categories (output by multi-agent orchestrator).",
          items: {
            type: "object",
          },
        },
      },
      required: [],
    },
  },
];

// Register list_tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Register call_tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const startTime = Date.now();

  try {
    switch (name) {
      case "github_orchestrate_workers": {
        const {
          session_id = `stars_orch_${Date.now()}`,
          num_workers = 4,
          profile = "compact",
        } = args;

        const rawCustomCategories = Array.isArray(args.custom_categories) ? args.custom_categories : [];

        // 1. Taxonomy Extraction & Harmonization
        const existingHeaders = await extractExistingCatalogCategories();
        const combinedTaxonomy = Array.from(
          new Set([
            ...existingHeaders,
            ...rawCustomCategories,
            ...DEFAULT_BASELINE_TAXONOMY,
          ])
        );

        // 2. Fetch and Freeze Immutable Snapshot to eliminate Upstream Mutation drift
        const snapshotRepos = await fetchAllStarsSnapshot();
        await saveSnapshot(session_id, snapshotRepos);

        const totalStars = snapshotRepos.length;
        const actualWorkers = totalStars > 0 ? Math.min(num_workers, totalStars) : 0;
        const chunkSize = actualWorkers > 0 ? Math.ceil(totalStars / actualWorkers) : 0;

        const workerPlans = [];
        const workersState = Object.create(null);

        for (let i = 0; i < actualWorkers; i++) {
          const startIndex = i * chunkSize;
          const endIndex = Math.min((i + 1) * chunkSize, totalStars);
          if (startIndex >= totalStars) break;

          const workerId = `worker-${i + 1}`;
          const assignedSlice = snapshotRepos.slice(startIndex, endIndex);

          workerPlans.push({
            worker_id: workerId,
            start_index: startIndex,
            end_index: endIndex,
            repo_count: assignedSlice.length,
            assigned_repos_preview: assignedSlice.slice(0, 3).map((r) => r.full_name),
            subagent_prompt: [
              `You are worker '${workerId}'.`,
              `Your task: Fetch your assigned snapshot chunk using:`,
              `  github_get_worker_chunk(session_id='${session_id}', worker_id='${workerId}', profile='${profile}')`,
              ``,
              `Classification Rules:`,
              `1. You must classify each repository into one of the following mandatory baseline categories:`,
              `   ${JSON.stringify(combinedTaxonomy, null, 2)}`,
              `2. Extract a punchy 1-2 sentence elevator pitch (max 280 chars) from the distilled README.`,
              `3. If the repository README is in a language other than English, translate its core concepts into English for the elevator pitch and category assignment.`,
              `4. Extract 3-5 high-signal tags.`,
              `5. When finished, submit your digest using:`,
              `   github_submit_worker_digest(session_id='${session_id}', worker_id='${workerId}', analyzed_repos=[...])`,
            ].join("\n"),
          });

          workersState[workerId] = {
            status: "assigned",
            start_index: startIndex,
            end_index: endIndex,
            repo_count: assignedSlice.length,
            retry_count: 0,
            assigned_to: null,
          };
        }

        const archivedMap = Object.create(null);
        snapshotRepos.forEach((r) => {
          if (r.archived) {
            archivedMap[r.name] = true;
            if (r.full_name) archivedMap[r.full_name] = true;
            if (r.url) archivedMap[r.url] = true;
            if (r.html_url) archivedMap[r.html_url] = true;
          }
        });

        const sessionData = {
          session_id,
          created_at: new Date().toISOString(),
          status: "in_progress",
          profile: profile || "compact",
          total_repos: totalStars,
          baseline_taxonomy: combinedTaxonomy,
          archived_repos: archivedMap,
          workers: workersState,
          repos_by_name: Object.create(null),
          categories: Object.create(null),
        };

        await saveOrchestrationSession(session_id, sessionData);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id,
                  total_stars_frozen: totalStars,
                  baseline_taxonomy: combinedTaxonomy,
                  workers_count: workerPlans.length,
                  worker_plans: workerPlans,
                  instructions:
                    "Spin up parallel subagents matching the worker_plans array. Each subagent runs its subagent_prompt, fetches its chunk via github_get_worker_chunk, and submits via github_submit_worker_digest.",
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_get_worker_chunk": {
        const { session_id, worker_id, profile = "compact" } = args;

        const session = await getOrchestrationSession(session_id);
        if (!session) {
          throw new Error(`Orchestration session '${session_id}' not found.`);
        }

        const workerState = session.workers?.[worker_id];
        if (!workerState) {
          throw new Error(`Worker '${worker_id}' not found in session '${session_id}'.`);
        }

        if (workerState.status === "reassigned") {
          throw new Error(
            `Worker '${worker_id}' has been reassigned to '${workerState.assigned_to}'. Chunk cannot be retrieved by this worker.`
          );
        }

        // Transition to in_progress
        workerState.status = "in_progress";
        await saveOrchestrationSession(session_id, session);

        // Load frozen snapshot
        const allRepos = await loadSnapshot(session_id);
        if (!allRepos) {
          throw new Error(`Snapshot for session '${session_id}' not found on disk.`);
        }

        const slice = allRepos.slice(workerState.start_index, workerState.end_index);
        const profileConfig = CONTEXT_PROFILES[profile] || CONTEXT_PROFILES.compact;
        const charsPerRepo = profileConfig.charsPerRepo;

        // Fetch & distill READMEs for this chunk concurrently in chunks of 5
        const reposWithReadmes = await chunkedAsyncMap(
          slice,
          async (repo) => {
            let raw = null;
            try {
              const res = await getReadmeCached(repo.owner, repo.name, false);
              raw = res.content;
            } catch (_) {}

            let readme = "";
            let truncated = false;
            let fallbackInjected = false;

            if (raw && raw.trim().length >= 50) {
              const res = distillReadme(raw, charsPerRepo);
              readme = res.content;
              truncated = res.truncated;
            }

            if (!readme || readme.trim().length < 50) {
              // Missing or under 50 chars (raw or post-distillation) -> generate fallback using repo metadata
              const fallbackText = generateFallbackReadme(repo);
              const res = distillReadme(fallbackText, charsPerRepo);
              readme = res.content;
              truncated = res.truncated;
              fallbackInjected = true;
            }

            return {
              ...repo,
              archived: Boolean(repo.archived),
              readme_snippet: readme,
              readme_truncated: truncated,
              readme_fallback_injected: fallbackInjected,
            };
          },
          5
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id,
                  worker_id,
                  chunk_repo_count: reposWithReadmes.length,
                  baseline_taxonomy: session.baseline_taxonomy,
                  repos: reposWithReadmes,
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_submit_worker_digest": {
        const { session_id, worker_id, analyzed_repos = [] } = args;

        const session = await getOrchestrationSession(session_id);
        if (!session) {
          throw new Error(`Orchestration session '${session_id}' not found.`);
        }

        const workerState = session.workers?.[worker_id];
        if (!workerState) {
          throw new Error(`Worker '${worker_id}' is not registered in session '${session_id}'.`);
        }

        // Race condition protection: Reject submissions from reassigned lagging workers
        if (workerState.status === "reassigned") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "rejected_reassigned",
                    message: `Submission from '${worker_id}' rejected because it was previously reassigned to '${workerState.assigned_to}'.`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Idempotent processing of analyzed repos
        analyzed_repos.forEach((repo) => {
          const rawCategory = repo.category;
          const canonicalCategory = normalizeCategory(
            rawCategory,
            session.baseline_taxonomy
          );

          const isArchived =
            Boolean(repo.archived) ||
            Boolean(session.archived_repos && Object.prototype.hasOwnProperty.call(session.archived_repos, repo.name) && session.archived_repos[repo.name]) ||
            Boolean(repo.full_name && session.archived_repos && Object.prototype.hasOwnProperty.call(session.archived_repos, repo.full_name) && session.archived_repos[repo.full_name]) ||
            Boolean(repo.url && session.archived_repos && Object.prototype.hasOwnProperty.call(session.archived_repos, repo.url) && session.archived_repos[repo.url]);

          const isListSynced = false; // Fallback indicator
          const repoEntry = {
            name: repo.name,
            url: repo.url,
            node_id: repo.node_id,
            archived: isArchived,
            category: canonicalCategory,
            elevator_pitch: repo.elevator_pitch,
            tags: repo.tags || [],
            recommended_lists: repo.recommended_lists || [],
            sync_status: isListSynced ? "synced" : "local_only",
            submitted_by: worker_id,
            submitted_at: new Date().toISOString(),
          };

          const normStr = (s) => String(s || "").trim().toLowerCase().replace(/\/+$/, "");
          const repoNormName = normStr(repo.name);
          const repoNormUrl = normStr(repo.url);

          if (!session.repos_by_name) {
            session.repos_by_name = Object.create(null);
          }
          // Deduplicate in session.repos_by_name case-insensitively
          const existingKey = Object.keys(session.repos_by_name).find(
            (k) => normStr(k) === repoNormName
          );
          if (existingKey && existingKey !== repo.name) {
            delete session.repos_by_name[existingKey];
          }
          session.repos_by_name[repo.name] = repoEntry;

          // If repo previously existed in another category, remove it from that category (reclassification deduplication)
          if (session.categories) {
            for (const [catName, catRepos] of Object.entries(session.categories)) {
              if (catName !== canonicalCategory && Array.isArray(catRepos)) {
                const oldIdx = catRepos.findIndex(
                  (r) =>
                    normStr(r.name) === repoNormName ||
                    (repoNormUrl && normStr(r.url) === repoNormUrl)
                );
                if (oldIdx >= 0) {
                  catRepos.splice(oldIdx, 1);
                  if (catRepos.length === 0) {
                    delete session.categories[catName];
                  }
                }
              }
            }
          }

          if (!session.categories) {
            session.categories = Object.create(null);
          }
          if (!Object.prototype.hasOwnProperty.call(session.categories, canonicalCategory) || !Array.isArray(session.categories[canonicalCategory])) {
            session.categories[canonicalCategory] = [];
          }

          // Idempotent upsert by repo name in category list
          const existingIdx = session.categories[canonicalCategory].findIndex(
            (r) =>
              normStr(r.name) === repoNormName ||
              (repoNormUrl && normStr(r.url) === repoNormUrl)
          );

          const catalogItem = {
            name: repo.name,
            url: repo.url,
            archived: isArchived,
            summary: repo.elevator_pitch,
            tags: repo.tags || [],
            lists: repo.recommended_lists || [],
            sync_status: isListSynced ? "synced" : "local_only",
          };

          if (existingIdx >= 0) {
            session.categories[canonicalCategory][existingIdx] = catalogItem;
          } else {
            session.categories[canonicalCategory].push(catalogItem);
          }
        });

        // Update worker state
        workerState.status = "completed";
        workerState.completed_at = new Date().toISOString();

        // Check overall completion
        const allWorkers = Object.values(session.workers);
        const allCompleted = allWorkers.every(
          (w) => w.status === "completed" || w.status === "reassigned"
        );

        if (allCompleted) {
          session.status = "completed";
          // Clean up snapshot to prevent disk bloat
          await deleteSnapshot(session_id);
        }

        await saveOrchestrationSession(session_id, session);

        const categoryOverview = Object.entries(session.categories).map(([name, r]) => ({
          category: name,
          count: r.length,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id,
                  status: "digest_accepted",
                  worker_id,
                  repos_processed: analyzed_repos.length,
                  total_unique_repos_cataloged: Object.keys(session.repos_by_name).length,
                  all_workers_completed: allCompleted,
                  categories_overview: categoryOverview,
                  list_sync_mode: "graceful_local_fallback",
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_force_reduce_session": {
        const { session_id, missing_worker_policy = "proceed_with_available" } = args;

        const session = await getOrchestrationSession(session_id);
        if (!session) {
          throw new Error(`Orchestration session '${session_id}' not found.`);
        }

        const workers = session.workers || Object.create(null);
        const missingWorkerIds = Object.keys(workers).filter(
          (id) => workers[id].status !== "completed" && workers[id].status !== "reassigned"
        );

        if (missing_worker_policy === "proceed_with_available") {
          session.status = "force_reduced";
          await saveOrchestrationSession(session_id, session);
          await deleteSnapshot(session_id);

          const compiledCategories = Object.entries(session.categories).map(
            ([name, repos]) => ({ name, repos })
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    session_id,
                    status: "force_reduced",
                    policy: "proceed_with_available",
                    total_repos_cataloged: Object.keys(session.repos_by_name).length,
                    missing_workers_abandoned: missingWorkerIds,
                    compiled_categories: compiledCategories,
                    instructions:
                      "Call github_export_catalog with the compiled_categories array to generate your GITHUB_STARS.md.",
                    latency_ms: Date.now() - startTime,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (missing_worker_policy === "reassign") {
          const snapshotRepos = await loadSnapshot(session_id);
          const newWorkerPlans = [];

          for (const workerId of missingWorkerIds) {
            const oldState = workers[workerId];
            const retryCount = (oldState.retry_count || 0) + 1;
            const newWorkerId = `${workerId}-retry-${retryCount}`;

            // Mark old worker reassigned
            oldState.status = "reassigned";
            oldState.assigned_to = newWorkerId;

            // Register new worker
            workers[newWorkerId] = {
              status: "assigned",
              start_index: oldState.start_index,
              end_index: oldState.end_index,
              repo_count: oldState.repo_count,
              retry_count: retryCount,
              assigned_to: null,
            };

            const slicePreview = snapshotRepos
              ? snapshotRepos.slice(oldState.start_index, oldState.end_index).slice(0, 2).map((r) => r.full_name)
              : [];

            newWorkerPlans.push({
              worker_id: newWorkerId,
              supersedes: workerId,
              start_index: oldState.start_index,
              end_index: oldState.end_index,
              repo_count: oldState.repo_count,
              assigned_repos_preview: slicePreview,
              subagent_prompt: [
                `You are replacement worker '${newWorkerId}'.`,
                `Fetch your chunk with:`,
                `  github_get_worker_chunk(session_id='${session_id}', worker_id='${newWorkerId}', profile='${session.profile || "compact"}')`,
                `Classification Rules:`,
                `1. Classify into baseline taxonomy:`,
                `   ${JSON.stringify(session.baseline_taxonomy, null, 2)}`,
                `2. Extract a punchy 1-2 sentence elevator pitch (max 280 chars) from the distilled README.`,
                `3. If the repository README is in a language other than English, translate its core concepts into English for the elevator pitch and category assignment.`,
                `4. Extract 3-5 high-signal tags.`,
                `5. Submit results with:`,
                `   github_submit_worker_digest(session_id='${session_id}', worker_id='${newWorkerId}', analyzed_repos=[...])`,
              ].join("\n"),
            });
          }

          await saveOrchestrationSession(session_id, session);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    session_id,
                    status: "workers_reassigned",
                    policy: "reassign",
                    reassigned_workers: missingWorkerIds,
                    new_worker_plans: newWorkerPlans,
                    latency_ms: Date.now() - startTime,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          throw new Error(`Unknown missing_worker_policy: ${missing_worker_policy}`);
        }
      }

      case "github_get_orchestration_status": {
        const { session_id } = args;
        const session = await getOrchestrationSession(session_id);
        if (!session) {
          throw new Error(`Orchestration session '${session_id}' not found.`);
        }

        const workers = session.workers || Object.create(null);
        const completed = Object.keys(workers).filter(
          (id) => workers[id].status === "completed"
        );
        const inProgress = Object.keys(workers).filter(
          (id) => workers[id].status === "in_progress"
        );
        const reassigned = Object.keys(workers).filter(
          (id) => workers[id].status === "reassigned"
        );
        const pending = Object.keys(workers).filter(
          (id) => workers[id].status === "assigned"
        );

        const compiledCategories = Object.entries(session.categories || Object.create(null)).map(
          ([name, repos]) => ({
            name,
            repos,
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  session_id,
                  session_status: session.status,
                  total_stars: session.total_repos,
                  total_unique_repos_cataloged: Object.keys(session.repos_by_name || {}).length,
                  workers_summary: {
                    completed,
                    in_progress: inProgress,
                    assigned: pending,
                    reassigned,
                  },
                  all_completed: session.status === "completed" || session.status === "force_reduced",
                  compiled_categories: compiledCategories,
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_clear_cache": {
        memoryCache.clear();
        pendingCacheWrites.clear();
        clearCachedGitHubToken();
        orchestrationSessions.clear();
        sessionLoadPromises.clear();
        try {
          const files = await fs.readdir(CACHE_DIR);
          await Promise.all(
            files.map((file) => fs.unlink(path.join(CACHE_DIR, file)).catch(() => {}))
          );
        } catch (err) {
          // ignore
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, message: "Memory and disk caches cleared." }, null, 2),
            },
          ],
        };
      }

      case "github_get_user_info": {
        const cacheKey = "user_info_stats";
        if (!args.refresh) {
          const cached = await getCache(cacheKey);
          if (cached) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ...cached.data,
                      cache_hit: cached.from,
                      latency_ms: Date.now() - startTime,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        const userRes = await githubRest("/user");
        const user = userRes.data;

        let totalStars = "unknown";
        try {
          const starsRes = await githubRest("/user/starred?per_page=1");
          const link = starsRes?.headers?.get("link");
          if (link) {
            const match = link.match(/[?&]page=(\d+)[^>]*>;\s*rel=["']?last["']?/i);
            if (match) {
              totalStars = parseInt(match[1], 10);
            } else if (Array.isArray(starsRes?.data)) {
              totalStars = starsRes.data.length;
            }
          } else if (Array.isArray(starsRes?.data)) {
            totalStars = starsRes.data.length;
          }
        } catch (err) {
          console.error(`[github-stars-mcp] Failed to fetch starred count: ${err.message}`);
        }

        const info = {
          login: user.login,
          name: user.name,
          html_url: user.html_url,
          public_repos: user.public_repos,
          total_stars: totalStars,
        };

        await setCache(cacheKey, info, CACHE_TTL.USER_INFO);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...info,
                  cache_hit: false,
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_list_starred": {
        const page = args.page || 1;
        const perPage = Math.min(args.per_page || 10, 30);
        const sort = args.sort || "created";
        const direction = args.direction || "desc";

        const { items: starred, fromCache } = await getStarredPageCached(
          page,
          perPage,
          sort,
          direction,
          args.refresh
        );

        const formatted = starred.map((item) => {
          const repo = item.repo;
          return {
            node_id: repo.node_id,
            name: repo.name,
            full_name: repo.full_name,
            owner: repo.owner?.login,
            description: repo.description,
            language: repo.language,
            topics: repo.topics || [],
            stars: repo.stargazers_count,
            url: repo.html_url,
            starred_at: item.starred_at,
            archived: repo.archived,
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  page,
                  per_page: perPage,
                  count: formatted.length,
                  cache_hit: fromCache || false,
                  latency_ms: Date.now() - startTime,
                  repos: formatted,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_get_readme": {
        const {
          owner,
          repo,
          profile = DEFAULT_PROFILE,
          distill = true,
          max_chars,
          refresh = false,
        } = args;

        const profileConfig = CONTEXT_PROFILES[profile] || CONTEXT_PROFILES.standard;
        const effectiveMaxChars = max_chars || profileConfig.charsPerRepo;

        let rawReadme = null;
        let fromCache = false;
        try {
          const res = await getReadmeCached(owner, repo, refresh);
          rawReadme = res.content;
          fromCache = res.fromCache;
        } catch (_) {}

        let content = "";
        let truncated = false;
        let fallbackInjected = false;

        if (rawReadme && rawReadme.trim().length >= 50) {
          if (distill) {
            const distilled = distillReadme(rawReadme, effectiveMaxChars);
            content = distilled.content;
            truncated = distilled.truncated;
          } else if (rawReadme.length > effectiveMaxChars) {
            content =
              rawReadme.slice(0, effectiveMaxChars) +
              `\n\n... [README truncated to ${effectiveMaxChars} characters]`;
            truncated = true;
          } else {
            content = rawReadme;
          }
        }

        if (!content || content.trim().length < 50) {
          try {
            const repoRes = await githubRest(`/repos/${owner}/${repo}`);
            if (repoRes && repoRes.data) {
              const fallbackText = generateFallbackReadme(repoRes.data);
              fallbackInjected = true;
              if (distill) {
                const distilled = distillReadme(fallbackText, effectiveMaxChars);
                content = distilled.content;
                truncated = distilled.truncated;
              } else {
                content = fallbackText;
              }
            }
          } catch (err) {
            // If remote metadata fails, synthesize fallback with available owner/repo
            const fallbackText = generateFallbackReadme({ full_name: `${owner}/${repo}`, name: repo, owner });
            fallbackInjected = true;
            if (distill) {
              const distilled = distillReadme(fallbackText, effectiveMaxChars);
              content = distilled.content;
              truncated = distilled.truncated;
            } else {
              content = fallbackText;
            }
          }
        }

        const estimatedTokens = Math.ceil(content.length / 4);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  owner,
                  repo,
                  found: true,
                  fallback_injected: fallbackInjected,
                  raw_length: rawReadme ? rawReadme.length : content.length,
                  returned_length: content.length,
                  truncated,
                  distilled: distill,
                  cache_hit: fromCache || false,
                  latency_ms: Date.now() - startTime,
                  token_stats: {
                    estimated_tokens: estimatedTokens,
                    profile,
                    char_limit: effectiveMaxChars,
                  },
                  content,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_batch_get_starred_with_readme": {
        const profileName = args.profile || DEFAULT_PROFILE;
        const profileConfig = CONTEXT_PROFILES[profileName] || CONTEXT_PROFILES.standard;
        const page = args.page || 1;
        const perPage = Math.min(
          args.per_page || profileConfig.defaultPerPage,
          25
        );
        const distill = args.distill !== false;
        const sort = args.sort || "created";
        const direction = args.direction || "desc";
        const prefetchNext = args.prefetch_next !== false;

        const tokenBudget = args.token_budget || DEFAULT_TOKEN_BUDGET || profileConfig.targetTokens;
        const metadataReserveChars = perPage * 250;
        const totalCharBudget = Math.max(tokenBudget * 4 - metadataReserveChars, 2000);
        const charsPerRepo = Math.max(
          Math.floor(totalCharBudget / perPage),
          600
        );

        const { items: starred, fromCache: pageFromCache } = await getStarredPageCached(
          page,
          perPage,
          sort,
          direction,
          args.refresh
        );

        let cacheHitsCount = 0;
        let totalBatchChars = 0;

        const items = await chunkedAsyncMap(
          starred,
          async (item, i) => {
            const repo = item.repo;
            const owner = repo.owner?.login;
            const repoName = repo.name;

            let readme = "";
            let truncated = false;
            let rawLength = 0;
            let readmeCacheHit = false;
            let fallbackInjected = false;

            try {
              const { content: raw, fromCache: readmeFromCache } = await getReadmeCached(
                owner,
                repoName,
                args.refresh
              );

              if (readmeFromCache) {
                cacheHitsCount++;
                readmeCacheHit = readmeFromCache;
              }

              if (raw && raw.trim().length >= 50) {
                rawLength = raw.length;
                if (distill) {
                  const distilledRes = distillReadme(raw, charsPerRepo);
                  readme = distilledRes.content;
                  truncated = distilledRes.truncated;
                } else if (raw.length > charsPerRepo) {
                  readme =
                    raw.slice(0, charsPerRepo) +
                    `\n\n... [README truncated to ${charsPerRepo} chars]`;
                  truncated = true;
                } else {
                  readme = raw;
                }
              }

              if (!readme || readme.trim().length < 50) {
                // Missing, under 50 chars, or distilled down to under 50 chars -> generate fallback using repo metadata
                const fallbackText = generateFallbackReadme(repo);
                rawLength = raw ? raw.length : fallbackText.length;
                fallbackInjected = true;
                if (distill) {
                  const distilledRes = distillReadme(fallbackText, charsPerRepo);
                  readme = distilledRes.content;
                  truncated = distilledRes.truncated;
                } else {
                  readme = fallbackText;
                }
              }
            } catch (err) {
              const fallbackText = generateFallbackReadme(repo);
              rawLength = fallbackText.length;
              fallbackInjected = true;
              if (distill) {
                const distilledRes = distillReadme(fallbackText, charsPerRepo);
                readme = distilledRes.content;
                truncated = distilledRes.truncated;
              } else if (fallbackText.length > charsPerRepo) {
                readme =
                  fallbackText.slice(0, charsPerRepo) +
                  `\n\n... [README truncated to ${charsPerRepo} chars]`;
                truncated = true;
              } else {
                readme = fallbackText;
              }
            }

            totalBatchChars += readme.length;

            return {
              batch_index: (page - 1) * perPage + i + 1,
              node_id: repo.node_id,
              name: repo.name,
              full_name: repo.full_name,
              owner,
              description: repo.description,
              language: repo.language,
              topics: repo.topics || [],
              stars: repo.stargazers_count,
              url: repo.html_url,
              starred_at: item.starred_at,
              archived: Boolean(repo.archived),
              readme_snippet: readme,
              readme_truncated: truncated,
              readme_cache_hit: readmeCacheHit,
              readme_fallback_injected: fallbackInjected,
              original_readme_length: rawLength,
            };
          },
          5
        );

        const estimatedTokensUsed = Math.ceil(
          (totalBatchChars + items.length * 250) / 4
        );

        if (prefetchNext && items.length === perPage) {
          triggerPrefetch(page + 1, perPage, sort, direction);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  page,
                  per_page: perPage,
                  batch_count: items.length,
                  performance: {
                    latency_ms: Date.now() - startTime,
                    page_cache_hit: pageFromCache || false,
                    readmes_cache_hits: `${cacheHitsCount}/${items.length}`,
                    prefetch_next_batch_active: prefetchNext && items.length === perPage,
                  },
                  token_stats: {
                    profile: profileName,
                    target_token_budget: tokenBudget,
                    estimated_tokens_used: estimatedTokensUsed,
                    budget_utilization_pct: Math.min(
                      Math.round((estimatedTokensUsed / tokenBudget) * 100),
                      100
                    ),
                    chars_per_repo_limit: charsPerRepo,
                    distilled: distill,
                  },
                  items,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "github_get_user_lists": {
        const cacheKey = "user_lists_cache";
        if (!args.refresh) {
          const cached = await getCache(cacheKey);
          if (cached) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ...cached.data,
                      cache_hit: cached.from,
                      latency_ms: Date.now() - startTime,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        const query = `
          query {
            viewer {
              lists(first: 50) {
                nodes {
                  id
                  name
                  description
                  isPrivate
                  items(first: 50) {
                    totalCount
                    nodes {
                      ... on Repository {
                        id
                        nameWithOwner
                      }
                    }
                  }
                }
              }
            }
          }
        `;
        try {
          const data = await githubGraphQL(query);
          const lists = (data?.viewer?.lists?.nodes || []).map((l) => ({
            id: l.id,
            name: l.name,
            description: l.description,
            is_private: l.isPrivate,
            item_count: l.items?.totalCount || 0,
            sample_repos: (l.items?.nodes || []).map((r) => r.nameWithOwner),
          }));

          const result = { lists_count: lists.length, lists };
          await setCache(cacheKey, result, CACHE_TTL.USER_LISTS);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...result,
                    cache_hit: false,
                    latency_ms: Date.now() - startTime,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err) {
          if (
            err.message &&
            (err.message.includes("INSUFFICIENT_SCOPES") ||
              err.message.includes("Resource not accessible") ||
              err.message.toLowerCase().includes("scope") ||
              err.message.includes("GitHub GraphQL error"))
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: "INSUFFICIENT_SCOPES",
                      message:
                        "Listing or managing GitHub Star Lists requires the 'user' scope on your token. Run 'gh auth refresh -s user' in PowerShell to grant it.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          throw err;
        }
      }

      case "github_create_user_list": {
        const { name: listName, description = "", is_private = false } = args;
        const query = `
          mutation($input: CreateUserListInput!) {
            createUserList(input: $input) {
              list {
                id
                name
                description
                isPrivate
              }
            }
          }
        `;
        try {
          const data = await githubGraphQL(query, {
            input: {
              name: listName,
              description,
              isPrivate: is_private,
            },
          });
          await invalidateCache("user_lists_cache");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    created_list: data.createUserList?.list,
                    latency_ms: Date.now() - startTime,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err) {
          if (err.message.includes("INSUFFICIENT_SCOPES")) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: "INSUFFICIENT_SCOPES",
                      message:
                        "Creating GitHub Star Lists requires the 'user' scope on your token. Run 'gh auth refresh -s user' in PowerShell to grant it.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          throw err;
        }
      }

      case "github_assign_repo_to_lists": {
        const { repo_node_id, list_ids } = args;
        const query = `
          mutation($itemId: ID!, $listIds: [ID!]!) {
            updateUserListsForItem(input: {itemId: $itemId, listIds: $listIds}) {
              clientMutationId
            }
          }
        `;
        try {
          await githubGraphQL(query, {
            itemId: repo_node_id,
            listIds: list_ids,
          });
          await invalidateCache("user_lists_cache");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    repo_node_id,
                    assigned_lists: list_ids,
                    latency_ms: Date.now() - startTime,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err) {
          if (err.message.includes("INSUFFICIENT_SCOPES")) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: "INSUFFICIENT_SCOPES",
                      message:
                        "Assigning repositories to GitHub Star Lists requires the 'user' scope on your token. Run 'gh auth refresh -s user' in PowerShell to grant it.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          throw err;
        }
      }

      case "github_export_catalog": {
        const {
          catalog_title = "Organized GitHub Stars",
          mode = "merge",
        } = args;

        const rawCategories = Array.isArray(args.categories)
          ? args.categories
          : (Array.isArray(args.compiled_categories)
            ? args.compiled_categories
            : (args.categories || args.compiled_categories || []));

        const categories = Array.isArray(rawCategories) ? rawCategories : [];

        const rawFilePath = typeof args.file_path === "string" && args.file_path.trim()
          ? args.file_path.trim()
          : "GITHUB_STARS.md";

        const cwd = path.resolve(process.cwd());
        const resolvedPath = path.resolve(cwd, rawFilePath);
        const rel = path.relative(cwd, resolvedPath);

        // Security Defense (CWE-22): Sandbox destination path within process.cwd()
        if (rel.startsWith("..") || path.isAbsolute(rel) || resolvedPath === cwd) {
          throw new Error(
            `Security Error (CWE-22): Target file_path '${rawFilePath}' must reside within the current working directory.`
          );
        }

        // Ensure the target file has a .md extension
        if (path.extname(resolvedPath).toLowerCase() !== ".md") {
          throw new Error(
            `Security Error: Target file_path '${rawFilePath}' must have a .md extension.`
          );
        }

        let finalCategories = categories;
        let wasMerged = false;

        if (mode === "merge") {
          try {
            const existingContent = await fs.readFile(resolvedPath, "utf-8");
            const existingCategories = parseCatalogMarkdown(existingContent);
            if (existingCategories.length > 0) {
              finalCategories = mergeCatalogCategories(existingCategories, categories);
              wasMerged = true;
            }
          } catch (err) {
            // File does not exist or read failed -> proceed with new categories
          }
        }

        // Sort finalCategories according to DEFAULT_BASELINE_TAXONOMY order, keeping any custom categories at the end
        finalCategories.sort((a, b) => {
          const nameA = resolveCategoryName(a);
          const nameB = resolveCategoryName(b);
          let idxA = DEFAULT_BASELINE_TAXONOMY.findIndex(
            (t) => t.toLowerCase() === nameA.toLowerCase()
          );
          let idxB = DEFAULT_BASELINE_TAXONOMY.findIndex(
            (t) => t.toLowerCase() === nameB.toLowerCase()
          );
          if (idxA === -1) idxA = 999;
          if (idxB === -1) idxB = 999;
          if (idxA !== idxB) return idxA - idxB;
          return nameA.localeCompare(nameB);
        });

        const generateGfmAnchor = (heading) => {
          if (!heading || typeof heading !== "string") return "category";
          return (
            heading
              .toLowerCase()
              .trim()
              .replace(/[^\w\- ]+/g, "")
              .replace(/\s+/g, (m) => "-".repeat(m.length))
              .replace(/^-+|-+$/g, "") || "category"
          );
        };

        const generateLegacyAnchor = (heading) => {
          if (!heading || typeof heading !== "string") return "category";
          return (
            heading
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "category"
          );
        };

        let lines = [];
        lines.push(`# ${catalog_title}\n`);
        lines.push(`> Automatically categorized and curated via GitHub Stars MCP on ${new Date().toISOString().split("T")[0]}.\n`);

        lines.push("## Table of Contents\n");
        finalCategories.forEach((cat) => {
          if (!cat) return;
          const catName = resolveCategoryName(cat);
          const anchor = generateGfmAnchor(catName);
          const count = Array.isArray(cat.repos) ? cat.repos.length : 0;
          lines.push(`- [${catName}](#${anchor}) (${count})`);
        });
        lines.push("");

        finalCategories.forEach((cat) => {
          if (!cat) return;
          const catName = resolveCategoryName(cat);
          const gfmAnchor = generateGfmAnchor(catName);
          const legacyAnchor = generateLegacyAnchor(catName);
          let anchorTag = "";
          if (legacyAnchor && legacyAnchor !== gfmAnchor) {
            anchorTag = `<a id="${legacyAnchor}"></a>\n`;
          }
          lines.push(`---\n\n${anchorTag}## ${catName}\n`);
          if (cat.description) {
            lines.push(`*${cat.description}*\n`);
          }

          if (Array.isArray(cat.repos)) {
            cat.repos.forEach((repo) => {
              if (!repo) return;
              const isArchived = Boolean(repo.archived);
              const rawRepoName = typeof repo.name === "string" && repo.name.trim()
                ? repo.name.trim()
                : (repo.full_name && typeof repo.full_name === "string" && repo.full_name.trim()
                  ? repo.full_name.trim()
                  : (repo.name != null ? String(repo.name).trim() : (repo.full_name != null ? String(repo.full_name).trim() : "Unknown Repository")));
              const cleanRepoName = rawRepoName.replace(/\s*\[ARCHIVED\]\s*/i, "").trim();
              const repoUrl = repo.url || `https://github.com/${cleanRepoName}`;
              const archivedTag = isArchived ? " [ARCHIVED]" : "";
              lines.push(`### [${cleanRepoName}](${repoUrl})${archivedTag}`);
              if (repo.summary) {
                lines.push(`\n${repo.summary}\n`);
              }
              if (repo.custom_notes) {
                lines.push(`\n${repo.custom_notes}\n`);
              }
              const metaParts = [];
              const tagsList = normalizeStringArray(repo.tags);
              if (tagsList.length > 0) {
                metaParts.push(`**Tags**: \`${tagsList.join("`, `")}\``);
              }
              const listsList = normalizeStringArray(repo.lists);
              if (listsList.length > 0) {
                const listText = listsList.join(", ");
                if (repo.sync_status === "local_only") {
                  metaParts.push(`**List**: *${listText}* *(⚠️ Local Tag Only - GitHub Sync Disabled)*`);
                } else {
                  metaParts.push(`**List**: *${listText}*`);
                }
              }
              if (metaParts.length > 0) {
                lines.push(metaParts.join(" | ") + "\n");
              }
            });
          }
        });

        const outputMarkdown = lines.join("\n");
        await atomicWriteFile(resolvedPath, outputMarkdown, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  file_path: resolvedPath,
                  mode,
                  merged_existing_file: wasMerged,
                  categories_count: finalCategories.length,
                  total_repos_cataloged: finalCategories.reduce(
                    (acc, c) => acc + (c.repos?.length || 0),
                    0
                  ),
                  latency_ms: Date.now() - startTime,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${error.message}`,
        },
      ],
    };
  }
});

/**
 * Start the server using stdio transport
 */
async function main() {
  await cleanupOldSnapshots();

  // Periodic background disk cache cleanup every 6 hours
  const cleanupInterval = setInterval(() => {
    cleanupOldSnapshots(24).catch(() => {});
  }, 6 * 60 * 60 * 1000);
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("github-stars-mcp running on stdio (v1.4.0 - Production Resilience Layer)");
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Fatal error starting github-stars-mcp:", err);
    process.exit(1);
  });
}

export {
  githubRest,
  sleepWithSignal,
  githubGraphQL,
  generateFallbackReadme,
  parseCatalogMarkdown,
  mergeCatalogCategories,
  atomicWriteFile,
  distillReadme,
  normalizeCategory,
  resolveCategoryName,
  extractExistingCatalogCategories,
  cleanupOldSnapshots,
  invalidateCache,
  getGitHubToken,
  clearCachedGitHubToken,
  getCache,
  setCache,
  memoryCache,
  pendingCacheWrites,
  orchestrationSessions,
  sessionLoadPromises,
  chunkedAsyncMap,
  chunkedAsyncAllSettled,
  main,
};

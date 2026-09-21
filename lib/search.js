/**
 * Local Hybrid Concept Search Engine
 * 
 * Zero-cloud-dependency BM25 + multi-field weighted scoring + n-gram/phrase matching.
 * Performs problem-to-solution discovery across starred repositories in < 5ms completely offline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIELD_WEIGHTS = {
  name: 1.5,
  tags: 2.0,
  category: 1.2,
  elevator_pitch: 1.8,
  distilled_readme: 1.0,
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "that", "the",
  "to", "was", "were", "will", "with", "or", "into", "over", "such",
  "via", "where", "which",
]);

/**
 * Lightweight English stemmer covering common technical and descriptive word forms.
 * @param {string} word
 * @returns {string}
 */
export function stemWord(word) {
  if (!word || word.length < 3) return word;
  let s = word.toLowerCase();

  // Common technical suffix replacements
  if (s.endsWith("ing") && s.length > 5) {
    s = s.slice(0, -3);
  } else if (s.endsWith("tion") && s.length > 6) {
    s = s.slice(0, -4) + "t";
  } else if (s.endsWith("tions") && s.length > 7) {
    s = s.slice(0, -5) + "t";
  } else if (s.endsWith("ies") && s.length > 5) {
    s = s.slice(0, -3) + "y";
  } else if (s.endsWith("ive") && s.length > 5) {
    s = s.slice(0, -3);
  } else if (s.endsWith("ed") && s.length > 4) {
    s = s.slice(0, -2);
  } else if (s.endsWith("es") && s.length > 4 && !s.endsWith("ses") && !s.endsWith("ves")) {
    s = s.slice(0, -2);
  } else if (s.endsWith("er") && s.length > 4) {
    s = s.slice(0, -2);
  } else if (s.endsWith("or") && s.length > 4) {
    s = s.slice(0, -2);
  } else if (s.endsWith("s") && s.length > 3 && !s.endsWith("ss")) {
    s = s.slice(0, -1);
  }

  // Normalize silent trailing 'e' on stems (e.g. engine -> engin, service -> servic, configure -> configur)
  if (s.endsWith("e") && s.length > 4 && !s.endsWith("ee")) {
    s = s.slice(0, -1);
  }

  return s;
}

/**
 * Tokenize a text string into an array of search tokens.
 * Extracts individual words, splits hyphenated words, extracts CamelCase parts,
 * and includes stemmed forms for maximum conceptual recall.
 * @param {string} text
 * @returns {Array<string>}
 */
export function tokenize(text) {
  if (!text || typeof text !== "string") return [];

  const raw = text.toLowerCase();
  const tokens = [];

  // Match C++ and C# specifically with boundary-safe lookarounds
  const techMatches = [...raw.matchAll(/(?<=^|[^\p{L}\p{N}])(c\+\+|c#)(?=[^\p{L}\p{N}]|$)/gu)].map((m) => m[1]);
  for (const tm of techMatches) {
    tokens.push(tm);
  }

  // Replace matched tech tokens with whitespace so 'c' is not matched separately
  const cleanRaw = raw.replace(/(?<=^|[^\p{L}\p{N}])(c\+\+|c#)(?=[^\p{L}\p{N}]|$)/gu, " ");

  // Match words, alphanumeric tokens, and hyphenated/underscore terms across all Unicode scripts
  const wordMatches = cleanRaw.match(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu) || [];

  for (const match of wordMatches) {
    if (STOP_WORDS.has(match) && match.length < 4) {
      continue;
    }

    tokens.push(match);

    // Accent normalization (e.g. café -> cafe)
    const normalized = match.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (normalized !== match && normalized.length > 0 && !STOP_WORDS.has(normalized)) {
      tokens.push(normalized);
    }

    // If word contains hyphens or underscores (e.g. 'decision-engine' or 'screen_time')
    if (match.includes("-") || match.includes("_")) {
      const parts = match.split(/[-_]/).filter((p) => p.length > 0);
      for (const p of parts) {
        if (!STOP_WORDS.has(p)) {
          tokens.push(p);
          const st = stemWord(p);
          if (st !== p) tokens.push(st);
        }
      }
    } else {
      const st = stemWord(match);
      if (st !== match) {
        tokens.push(st);
      }

      // Handle common technical compound prefixes (e.g. microservices -> services, subprocess -> process)
      for (const prefix of ["micro", "multi", "sub"]) {
        if (match.startsWith(prefix) && match.length > prefix.length + 3) {
          const basePart = match.slice(prefix.length);
          if (!STOP_WORDS.has(basePart)) {
            tokens.push(basePart);
            const pst = stemWord(basePart);
            if (pst !== basePart) tokens.push(pst);
          }
        }
      }
    }
  }

  // Handle CamelCase splits on original text
  const camelMatches = text.match(/[A-Z][a-z0-9]+/g) || [];
  for (const cm of camelMatches) {
    const low = cm.toLowerCase();
    if (low.length > 2 && !STOP_WORDS.has(low)) {
      tokens.push(low);
      const st = stemWord(low);
      if (st !== low) tokens.push(st);
    }
  }

  return tokens;
}

/**
 * BM25 Search Index for Repositories
 */
export class BM25SearchEngine {
  /**
   * @param {Array<object>} repos
   * @param {object} [options]
   */
  constructor(repos = [], options = {}) {
    this.fieldWeights = { ...FIELD_WEIGHTS, ...(options.fieldWeights || {}) };
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.documents = [];
    this.docFreq = new Map(); // term -> count of docs containing term
    this.avgFieldLengths = {};
    this.totalDocs = 0;

    if (Array.isArray(repos) && repos.length > 0) {
      this.indexRepositories(repos);
    }
  }

  /**
   * Index an array of repositories
   * @param {Array<object>} repos
   */
  indexRepositories(repos) {
    this.documents = [];
    this.docFreq.clear();
    const safeRepos = (Array.isArray(repos) ? repos : []).filter(
      (r) => r && typeof r === "object"
    );
    this.totalDocs = safeRepos.length;

    const totalFieldLengths = {
      name: 0,
      tags: 0,
      category: 0,
      elevator_pitch: 0,
      distilled_readme: 0,
    };

    for (let i = 0; i < safeRepos.length; i++) {
      const r = safeRepos[i];
      const nameStr = String(r.name || r.full_name || "");
      const tagsList = Array.isArray(r.tags)
        ? r.tags
        : Array.isArray(r.topics)
        ? r.topics
        : [];
      const tagsStr = tagsList.join(" ");
      const catStr = String(r.category || "");
      const pitchStr = String(r.summary || r.elevator_pitch || r.description || "");
      const readmeStr = String(r.distilled_readme || r.readme || "");

      const fieldTokens = {
        name: tokenize(nameStr),
        tags: tokenize(tagsStr),
        category: tokenize(catStr),
        elevator_pitch: tokenize(pitchStr),
        distilled_readme: tokenize(readmeStr),
      };

      // Compute term frequencies per field
      const fieldTfs = {};
      const uniqueDocTerms = new Set();

      for (const field of Object.keys(fieldTokens)) {
        fieldTfs[field] = new Map();
        const tokens = fieldTokens[field];
        totalFieldLengths[field] += tokens.length;

        for (const token of tokens) {
          fieldTfs[field].set(token, (fieldTfs[field].get(token) || 0) + 1);
          uniqueDocTerms.add(token);
        }
      }

      for (const token of uniqueDocTerms) {
        this.docFreq.set(token, (this.docFreq.get(token) || 0) + 1);
      }

      this.documents.push({
        repo: r,
        rawStrings: {
          name: nameStr.toLowerCase(),
          tags: tagsStr.toLowerCase(),
          category: catStr.toLowerCase(),
          elevator_pitch: pitchStr.toLowerCase(),
          distilled_readme: readmeStr.toLowerCase(),
        },
        fieldTokens,
        fieldLengths: {
          name: fieldTokens.name.length,
          tags: fieldTokens.tags.length,
          category: fieldTokens.category.length,
          elevator_pitch: fieldTokens.elevator_pitch.length,
          distilled_readme: fieldTokens.distilled_readme.length,
        },
        fieldTfs,
      });
    }

    for (const field of Object.keys(totalFieldLengths)) {
      this.avgFieldLengths[field] =
        this.totalDocs > 0 ? totalFieldLengths[field] / this.totalDocs : 1;
    }
  }

  /**
   * Compute IDF for a term
   * @param {string} term
   * @returns {number}
   */
  idf(term) {
    const n = this.docFreq.get(term) || 0;
    if (n === 0) return 0;
    const val = Math.log(1 + (this.totalDocs - n + 0.5) / (n + 0.5));
    return Math.max(0.1, val);
  }

  /**
   * Search indexed repositories
   * @param {string} query
   * @param {object} [options]
   * @param {string} [options.category]
   * @param {number} [options.limit=10]
   * @param {number} [options.min_score=0.1]
   * @returns {Array<object>}
   */
  search(query, options = {}) {
    if (!query || typeof query !== "string" || !query.trim()) {
      return [];
    }

    const trimmedQuery = query.trim();
    const queryTokens = tokenize(trimmedQuery);
    if (queryTokens.length === 0) return [];

    const categoryFilter = options.category
      ? options.category.toLowerCase().trim()
      : null;
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 10;
    const minScore = Number.isFinite(Number(options.min_score))
      ? Number(options.min_score)
      : 0.1;

    const rawQueryLower = trimmedQuery.toLowerCase();
    const subPhrases = [];
    const queryWords = rawQueryLower.split(/\s+/).filter((w) => w.length > 1);
    if (queryWords.length >= 2) {
      subPhrases.push(rawQueryLower);
      for (let i = 0; i < queryWords.length - 1; i++) {
        subPhrases.push(`${queryWords[i]} ${queryWords[i + 1]}`);
      }
    }
    const uniqueSubPhrases = Array.from(new Set(subPhrases));

    const results = [];

    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      const r = doc.repo;

      // Filter by category if requested
      if (categoryFilter) {
        const docCat = (r.category || "").toLowerCase();
        if (!docCat.includes(categoryFilter)) {
          continue;
        }
      }

      let score = 0;
      const matchedFields = new Set();
      let matchedUniqueTerms = 0;

      // 1. BM25 Multi-field scoring
      for (const token of queryTokens) {
        const idfVal = this.idf(token);
        if (idfVal <= 0) continue;

        let tokenMatchedInDoc = false;

        for (const [field, weight] of Object.entries(this.fieldWeights)) {
          const tf = doc.fieldTfs[field]?.get(token) || 0;
          if (tf > 0) {
            tokenMatchedInDoc = true;
            matchedFields.add(field);
            const len = doc.fieldLengths[field];
            const avgLen = this.avgFieldLengths[field] || 1;
            const tfNorm =
              (tf * (this.k1 + 1)) /
              (tf + this.k1 * (1 - this.b + this.b * (len / avgLen)));
            score += weight * idfVal * tfNorm;
          }
        }

        if (tokenMatchedInDoc) {
          matchedUniqueTerms++;
        }
      }

      // 2. Phrase & Substring Boosts
      for (const phrase of uniqueSubPhrases) {
        if (doc.rawStrings.name.includes(phrase)) {
          score += 4.5;
          matchedFields.add("name");
        }
        if (doc.rawStrings.tags.includes(phrase)) {
          score += 4.0;
          matchedFields.add("tags");
        }
        if (doc.rawStrings.elevator_pitch.includes(phrase)) {
          score += 3.5;
          matchedFields.add("elevator_pitch");
        }
        if (doc.rawStrings.category.includes(phrase)) {
          score += 1.5;
          matchedFields.add("category");
        }
      }

      // 3. Full coverage bonus (when all query tokens are matched somewhere in the repo)
      if (matchedUniqueTerms >= queryTokens.length && queryTokens.length > 1) {
        score += 2.5;
      }

      if (score >= minScore && matchedFields.size > 0) {
        const repoName = r.full_name || r.name;
        results.push({
          score: Math.round(score * 100) / 100,
          name: repoName,
          url: r.url || r.html_url || `https://github.com/${repoName}`,
          category: r.category || "Uncategorized",
          elevator_pitch: r.summary || r.elevator_pitch || r.description || "",
          tags: Array.isArray(r.tags) ? r.tags : (Array.isArray(r.topics) ? r.topics : []),
          archived: Boolean(r.archived),
          stars: Number(r.stars || r.stargazers_count || 0),
          language: r.language || null,
          matched_fields: Array.from(matchedFields),
        });
      }
    }

    // Sort descending by score, tie-breaking with stars
    results.sort((a, b) => b.score - a.score || b.stars - a.stars);

    return results.slice(0, limit);
  }
}

/**
 * Load repositories from GITHUB_STARS.md
 * @param {string} [filePath]
 * @returns {Promise<Array<object>>}
 */
export async function loadCatalogRepos(filePath) {
  let resolvedPath = filePath;
  if (!resolvedPath) {
    const cwdPath = path.join(process.cwd(), "GITHUB_STARS.md");
    try {
      await fs.access(cwdPath);
      resolvedPath = cwdPath;
    } catch {
      resolvedPath = path.resolve(__dirname, "..", "GITHUB_STARS.md");
    }
  }
  try {
    const content = await fs.readFile(resolvedPath, "utf-8");
    const categories = parseSimpleCatalog(content);
    const repos = [];

    for (const cat of categories) {
      for (const r of cat.repos) {
        repos.push({
          ...r,
          category: cat.name,
        });
      }
    }
    return repos;
  } catch (err) {
    return [];
  }
}

/**
 * Self-contained GITHUB_STARS.md parser to maintain zero-coupling
 * @param {string} content
 * @returns {Array<object>}
 */
function parseSimpleCatalog(content) {
  const categories = [];
  let currentCategory = null;
  let currentRepo = null;

  const lines = content.split(/\r?\n/);
  let inToc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const catMatch = trimmed.match(/^##\s+([^#\n]+)$/);
    if (catMatch) {
      const headerTitle = catMatch[1].trim();
      if (headerTitle.toLowerCase() === "table of contents") {
        inToc = true;
        continue;
      }
      inToc = false;
      currentRepo = null;
      currentCategory = { name: headerTitle, repos: [] };
      categories.push(currentCategory);
      continue;
    }

    if (inToc) continue;

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
        tags: [],
        lists: [],
      };

      if (currentCategory) {
        currentCategory.repos.push(currentRepo);
      } else {
        currentCategory = { name: "Uncategorized", repos: [currentRepo] };
        categories.push(currentCategory);
      }
      continue;
    }

    if (currentRepo) {
      if (trimmed === "---") {
        currentRepo = null;
        continue;
      }

      if (trimmed.startsWith("**Tags**:") || trimmed.startsWith("**List**:")) {
        const tagMatch = trimmed.match(/\*\*Tags\*\*:\s*`([^`]+(?:`,\s*`[^`]+)*)`/);
        if (tagMatch) {
          currentRepo.tags = tagMatch[1].split(/`,\s*`/);
        } else {
          const rawTagMatch = trimmed.match(/\*\*Tags\*\*:\s*([^|]+)/);
          if (rawTagMatch) {
            currentRepo.tags = rawTagMatch[1]
              .split(",")
              .map((t) => t.replace(/[`*]/g, "").trim())
              .filter(Boolean);
          }
        }
        continue;
      }

      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("<") && !trimmed.startsWith("**")) {
        currentRepo.summary = currentRepo.summary
          ? `${currentRepo.summary} ${trimmed}`
          : trimmed;
      }
    }
  }

  return categories;
}

/**
 * Top-level convenience search function
 * @param {string} query
 * @param {object} [options]
 * @param {Array<object>} [options.repos]
 * @param {string} [options.catalogPath]
 * @param {string} [options.category]
 * @param {number} [options.limit=10]
 * @param {number} [options.min_score=0.1]
 * @returns {Promise<Array<object>>}
 */
export async function searchRepositories(query, options = {}) {
  let repos = options.repos;
  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    repos = await loadCatalogRepos(options.catalogPath);
  }

  const engine = new BM25SearchEngine(repos);
  return engine.search(query, options);
}

/**
 * Repository Health & Staleness Audit Engine
 * 
 * Analyzes repository freshness, maintenance cadence, licensing risks,
 * and computes a composite normalized Health Score (0-100).
 */

const PERMISSIVE_LICENSES = new Set([
  "MIT",
  "APACHE-2.0",
  "APACHE 2.0",
  "APACHE-1.1",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "BSD-CLEAR",
  "BSD",
  "ISC",
  "UNLICENSE",
  "CC0-1.0",
  "CC0",
  "0BSD",
  "ZLIB",
  "BSL-1.0",
  "WTFPL",
  "ARTISTIC-2.0",
  "MIT-0",
]);

const COPYLEFT_LICENSES = new Set([
  "GPL",
  "GPL-2.0",
  "GPL-3.0",
  "GPL-2.0-ONLY",
  "GPL-2.0-OR-LATER",
  "GPL-3.0-ONLY",
  "GPL-3.0-OR-LATER",
  "GPLV2",
  "GPLV3",
  "AGPL",
  "AGPL-3.0",
  "AGPL-3.0-ONLY",
  "AGPL-3.0-OR-LATER",
  "AGPLV3",
  "LGPL",
  "LGPL-2.1",
  "LGPL-3.0",
  "LGPL-2.1-ONLY",
  "LGPL-3.0-ONLY",
  "LGPLV2.1",
  "LGPLV3",
  "MPL-2.0",
  "MPL-1.1",
  "MPL",
  "EUPL-1.2",
  "EUPL",
  "SSPL-1.0",
  "SSPL",
  "EPL-2.0",
  "EPL-1.0",
  "EPL",
  "OSL-3.0",
  "CC-BY-SA-4.0",
]);

/**
 * Classify license string or object into PERMISSIVE, COPYLEFT, or UNLICENSED
 * @param {string|object|null|undefined} licenseInput
 * @returns {"PERMISSIVE"|"COPYLEFT"|"UNLICENSED"}
 */
export function classifyLicense(licenseInput) {
  if (!licenseInput) return "UNLICENSED";

  let rawName = "";
  if (typeof licenseInput === "string") {
    rawName = licenseInput.trim();
  } else if (typeof licenseInput === "object") {
    const candidate =
      licenseInput.spdx_id ??
      licenseInput.key ??
      licenseInput.name ??
      "";
    rawName = String(candidate).trim();
  }

  if (!rawName) return "UNLICENSED";

  const upper = rawName.toUpperCase();
  if (
    upper === "NOASSERTION" ||
    upper === "NONE" ||
    upper === "UNKNOWN" ||
    upper === "OTHER"
  ) {
    return "UNLICENSED";
  }

  if (PERMISSIVE_LICENSES.has(upper)) {
    return "PERMISSIVE";
  }
  if (COPYLEFT_LICENSES.has(upper)) {
    return "COPYLEFT";
  }

  // Regex fallback matching
  if (
    /MIT/i.test(upper) ||
    /APACHE/i.test(upper) ||
    /BSD/i.test(upper) ||
    /ISC/i.test(upper) ||
    /UNLICENSE/i.test(upper) ||
    /CC0/i.test(upper) ||
    /0BSD/i.test(upper)
  ) {
    return "PERMISSIVE";
  }

  if (
    /AGPL/i.test(upper) ||
    /GPL/i.test(upper) ||
    /LGPL/i.test(upper) ||
    /GENERAL PUBLIC LICENSE/i.test(upper) ||
    /MPL/i.test(upper) ||
    /MOZILLA/i.test(upper) ||
    /EUPL/i.test(upper) ||
    /SSPL/i.test(upper) ||
    /ECLIPSE|EPL/i.test(upper) ||
    /CC-BY-SA/i.test(upper)
  ) {
    return "COPYLEFT";
  }

  return "UNLICENSED";
}

/**
 * Determine days since last activity and categorize repository freshness:
 * - ARCHIVED: Repo is archived on GitHub
 * - ACTIVE: < 60 days
 * - SLOW: 60 - 180 days
 * - STALE: 180 - 365 days
 * - DEAD_ABANDONED: > 365 days
 *
 * @param {object} repo
 * @param {Date} [referenceDate]
 * @returns {{ freshness: "ACTIVE"|"SLOW"|"STALE"|"DEAD_ABANDONED"|"ARCHIVED"|"UNKNOWN", days: number|null }}
 */
export function classifyFreshness(repo, referenceDate = new Date()) {
  if (!repo || typeof repo !== "object") {
    return { freshness: "UNKNOWN", days: null };
  }

  const isArchived = Boolean(repo.archived);

  // Check explicit days_since_push or calculate from commit/push timestamp
  let days = null;
  if (repo.days_since_push !== undefined && repo.days_since_push !== null && !isNaN(Number(repo.days_since_push))) {
    days = Math.max(0, Math.floor(Number(repo.days_since_push)));
  } else {
    const dateStr =
      repo.pushed_at ||
      repo.last_commit_at ||
      repo.updated_at;

    if (dateStr) {
      const actDate = new Date(dateStr);
      if (!isNaN(actDate.getTime())) {
        days = Math.max(0, Math.floor((referenceDate.getTime() - actDate.getTime()) / (1000 * 60 * 60 * 24)));
      }
    }
  }

  if (isArchived) {
    return { freshness: "ARCHIVED", days };
  }

  if (days === null) {
    return { freshness: "UNKNOWN", days: null };
  }

  if (days < 60) {
    return { freshness: "ACTIVE", days };
  }
  if (days <= 180) {
    return { freshness: "SLOW", days };
  }
  if (days <= 365) {
    return { freshness: "STALE", days };
  }
  return { freshness: "DEAD_ABANDONED", days };
}

/**
 * Computes a composite normalized Health Score (0-100)
 * Factoring in:
 * 1. Freshness / Activity (0-50 pts)
 * 2. Community adoption / Stargazers (0-30 pts)
 * 3. Licensing & Maintenance indicators (0-20 pts)
 *
 * @param {object} repo
 * @param {Date} [referenceDate]
 * @returns {number} Integer between 0 and 100
 */
export function calculateHealthScore(repo, referenceDate = new Date()) {
  if (!repo || typeof repo !== "object") return 0;

  const { freshness, days } = classifyFreshness(repo, referenceDate);
  const licenseCategory = classifyLicense(repo.license);
  const isArchived = Boolean(repo.archived) || freshness === "ARCHIVED";

  // 1. Freshness Component (0 - 50 points)
  let freshnessScore = 0;
  if (isArchived) {
    freshnessScore = 0;
  } else if (freshness === "ACTIVE") {
    if (days !== null && days <= 14) freshnessScore = 50;
    else if (days !== null && days <= 30) freshnessScore = 46;
    else freshnessScore = 42;
  } else if (freshness === "SLOW") {
    if (days !== null && days <= 120) freshnessScore = 32;
    else freshnessScore = 25;
  } else if (freshness === "STALE") {
    if (days !== null && days <= 270) freshnessScore = 15;
    else freshnessScore = 10;
  } else if (freshness === "DEAD_ABANDONED") {
    freshnessScore = 4;
  } else {
    // UNKNOWN - neutral fallback
    freshnessScore = 25;
  }

  // 2. Community & Popularity Component (0 - 30 points)
  const rawStars = Number(repo.stars || repo.stargazers_count || 0);
  const stars = isNaN(rawStars) ? 0 : Math.max(0, rawStars);
  let starsScore = 0;
  if (stars >= 10000) starsScore = 30;
  else if (stars >= 5000) starsScore = 27;
  else if (stars >= 1000) starsScore = 24;
  else if (stars >= 500) starsScore = 20;
  else if (stars >= 100) starsScore = 16;
  else if (stars >= 25) starsScore = 12;
  else if (stars >= 5) starsScore = 8;
  else if (stars > 0) starsScore = 4;
  else starsScore = 2;

  // 3. Maintenance & Licensing Component (0 - 20 points)
  let maintenanceScore = 0;
  if (licenseCategory === "PERMISSIVE") {
    maintenanceScore += 12;
  } else if (licenseCategory === "COPYLEFT") {
    maintenanceScore += 8;
  } else {
    // UNLICENSED - 0 points
    maintenanceScore += 0;
  }

  const pitch = repo.summary || repo.elevator_pitch || repo.description || "";
  if (pitch && pitch.trim().length > 15) {
    maintenanceScore += 5;
  }

  const tags = repo.tags || repo.topics || [];
  if (Array.isArray(tags) && tags.length > 0) {
    maintenanceScore += 3;
  }

  let totalScore = freshnessScore + starsScore + maintenanceScore;

  // Penalties & Caps
  if (isArchived) {
    totalScore = Math.min(totalScore, 25);
  } else if (freshness === "DEAD_ABANDONED") {
    totalScore = Math.min(totalScore, 42);
  }

  return Math.max(0, Math.min(100, Math.round(totalScore)));
}

/**
 * Audit a single repository
 * @param {object} repo
 * @param {Date} [referenceDate]
 * @returns {object}
 */
export function auditRepository(repo, referenceDate = new Date()) {
  if (!repo || typeof repo !== "object") {
    throw new TypeError("repo must be an object");
  }

  const name =
    repo.name ||
    repo.full_name ||
    (repo.url ? repo.url.replace(/^https?:\/\/github\.com\//i, "") : "unknown/repo");
  const url = repo.url || repo.html_url || `https://github.com/${name}`;
  const { freshness, days } = classifyFreshness(repo, referenceDate);
  const licenseCategory = classifyLicense(repo.license);
  const healthScore = calculateHealthScore(repo, referenceDate);

  const rawLicense = typeof repo.license === "object" && repo.license !== null
    ? String(repo.license.spdx_id || repo.license.name || repo.license.key || "Unknown")
    : (repo.license ? String(repo.license) : "Unknown");

  const flags = [];
  if (repo.archived || freshness === "ARCHIVED") flags.push("archived");
  if (freshness === "DEAD_ABANDONED") flags.push("abandoned");
  if (freshness === "STALE") flags.push("stale");
  if (licenseCategory === "UNLICENSED") flags.push("unlicensed");
  if (healthScore < 40) flags.push("low_health");

  return {
    name,
    url,
    health_score: healthScore,
    freshness,
    days_since_push: days,
    last_activity_date: repo.pushed_at || repo.last_commit_at || repo.updated_at || null,
    license: rawLicense,
    license_category: licenseCategory,
    stars: Number(repo.stars || repo.stargazers_count || 0),
    language: repo.language || null,
    archived: Boolean(repo.archived) || freshness === "ARCHIVED",
    category: repo.category || "Uncategorized",
    summary: repo.summary || repo.elevator_pitch || repo.description || "",
    tags: Array.isArray(repo.tags) ? repo.tags : (Array.isArray(repo.topics) ? repo.topics : []),
    flags,
  };
}

/**
 * Audit a collection of repositories and return aggregated health report
 * @param {Array<object>} repos
 * @param {object} [options]
 * @param {"all"|"stale"|"archived"|"unlicensed"} [options.filter="all"]
 * @param {number} [options.min_health_score]
 * @param {Date} [options.referenceDate]
 * @returns {object} Aggregated health audit report
 */
export function auditRepositories(repos = [], options = {}) {
  const filter = (options.filter || "all").toLowerCase();
  const minHealth = options.min_health_score !== undefined && options.min_health_score !== null && !isNaN(Number(options.min_health_score))
    ? Number(options.min_health_score)
    : null;
  const referenceDate = options.referenceDate || new Date();

  const safeRepos = (Array.isArray(repos) ? repos : []).filter(
    (r) => r && typeof r === "object"
  );
  const auditedList = safeRepos.map((r) => auditRepository(r, referenceDate));

  const healthDist = {
    active: 0,
    slow: 0,
    stale: 0,
    dead_abandoned: 0,
    archived: 0,
    unknown: 0,
  };

  const licenseBreakdown = {
    permissive: 0,
    copyleft: 0,
    unlicensed: 0,
  };

  let totalHealthSum = 0;
  let highRiskCount = 0;

  for (const item of auditedList) {
    totalHealthSum += item.health_score;

    if (item.freshness === "ACTIVE") healthDist.active++;
    else if (item.freshness === "SLOW") healthDist.slow++;
    else if (item.freshness === "STALE") healthDist.stale++;
    else if (item.freshness === "DEAD_ABANDONED") healthDist.dead_abandoned++;
    else if (item.freshness === "ARCHIVED") healthDist.archived++;
    else healthDist.unknown++;

    if (item.license_category === "PERMISSIVE") licenseBreakdown.permissive++;
    else if (item.license_category === "COPYLEFT") licenseBreakdown.copyleft++;
    else licenseBreakdown.unlicensed++;

    if (item.flags.length > 0) {
      highRiskCount++;
    }
  }

  const averageHealth = safeRepos.length > 0
    ? Math.round((totalHealthSum / safeRepos.length) * 10) / 10
    : 0;

  // Apply filtering
  let filtered = auditedList.filter((item) => {
    if (filter === "stale") {
      return item.freshness === "STALE" || item.freshness === "DEAD_ABANDONED";
    }
    if (filter === "archived") {
      return item.archived === true || item.freshness === "ARCHIVED";
    }
    if (filter === "unlicensed") {
      return item.license_category === "UNLICENSED";
    }
    return true;
  });

  if (minHealth !== null) {
    filtered = filtered.filter((item) => item.health_score >= minHealth);
  }

  return {
    total_audited: safeRepos.length,
    filtered_count: filtered.length,
    average_health_score: averageHealth,
    health_distribution: healthDist,
    license_breakdown: licenseBreakdown,
    high_risk_count: highRiskCount,
    filter_applied: filter,
    min_health_threshold: minHealth,
    repositories: filtered,
  };
}

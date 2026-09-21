import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubGraphQL, clearCachedGitHubToken } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure fresh token with 'user' scope is loaded
clearCachedGitHubToken();

const CATEGORY_DESCRIPTIONS = {
  "AI & Agent Infrastructure": "Agent harnesses, LLM toolkits, MCP servers, and prompt frameworks.",
  "Developer Tools & CLI": "Terminals, build tools, editors, and modern developer utilities.",
  "System Design & Backend Architecture": "Distributed systems, network proxies, games, and backend engines.",
  "Frontend & UI Libraries": "Component libraries, design systems, icons, and UI primitives.",
  "Databases & Data Engineering": "Embedded databases, SQL engines, and analytical storage.",
  "Security & Reverse Engineering": "Decompilers, secret scanners, static analyzers, and offensive tooling.",
  "Educational & Roadmaps": "CS fundamentals, interview guides, and engineering primers.",
  "Inspiration & Creative Ideas": "Creative experiments, hardware drivers, and retro simulators.",
};

async function syncToGitHub() {
  console.log("=== GitHub Star Lists Synchronizer ===");
  console.log("Connecting with authenticated token...");

  // 1. Fetch existing user lists
  const existingListsQuery = `
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

  const viewerData = await githubGraphQL(existingListsQuery);
  const login = viewerData?.viewer?.login || "User";
  console.log(`Authenticated as GitHub user: @${login}`);

  const existingLists = viewerData?.viewer?.lists?.nodes || [];
  const listMap = new Map();

  for (const l of existingLists) {
    listMap.set(l.name.toLowerCase().trim(), l.id);
    console.log(`Found existing list on GitHub: "${l.name}" (ID: ${l.id})`);
  }

  // 2. Ensure all 8 canonical categories exist on GitHub
  const categories = Object.keys(CATEGORY_DESCRIPTIONS);
  for (const cat of categories) {
    const key = cat.toLowerCase().trim();
    if (!listMap.has(key)) {
      console.log(`Creating list on GitHub: "${cat}"...`);
      const createMutation = `
        mutation($input: CreateUserListInput!) {
          createUserList(input: $input) {
            list {
              id
              name
            }
          }
        }
      `;
      const res = await githubGraphQL(createMutation, {
        input: {
          name: cat,
          description: CATEGORY_DESCRIPTIONS[cat],
          isPrivate: false,
        },
      });
      const created = res?.createUserList?.list;
      if (created) {
        listMap.set(key, created.id);
        console.log(`-> Created list "${created.name}" (ID: ${created.id})`);
      }
    }
  }

  // 3. Load repositories from newest session snapshot or GITHUB_STARS.md
  let repos = [];
  const cacheDir = path.join(__dirname, ".cache");

  try {
    const files = await fs.readdir(cacheDir);
    const sessionFiles = files
      .filter((f) => f.startsWith("orch_stars_orch_") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (sessionFiles.length > 0) {
      const sessionPath = path.join(cacheDir, sessionFiles[0]);
      const sessionContent = await fs.readFile(sessionPath, "utf-8");
      const session = JSON.parse(sessionContent);
      repos = Object.values(session.repos_by_name || {});
      console.log(`Loaded ${repos.length} repositories from active session snapshot: ${sessionFiles[0]}`);
    }
  } catch (err) {
    // Cache dir might not exist
  }

  // Fallback to parsing GITHUB_STARS.md if no session file
  if (repos.length === 0) {
    const catalogPath = path.join(__dirname, "GITHUB_STARS.md");
    console.log(`Loading repositories directly from ${catalogPath}...`);
    const { parseCatalogMarkdown } = await import("./index.js");
    const content = await fs.readFile(catalogPath, "utf-8");
    const categories = parseCatalogMarkdown(content);
    for (const cat of categories) {
      for (const r of cat.repos || []) {
        repos.push({
          name: r.name,
          category: cat.name,
          url: r.url,
        });
      }
    }
    console.log(`Loaded ${repos.length} repositories from GITHUB_STARS.md.`);
  }

  console.log(`\nBeginning assignment to GitHub lists...`);

  let assignedCount = 0;
  let failCount = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const cat = repo.category;
    const listId = listMap.get((cat || "").toLowerCase().trim());

    if (!listId) {
      console.warn(`[${i + 1}/${repos.length}] Warning: No list found for category "${cat}" (repo: ${repo.name})`);
      failCount++;
      continue;
    }

    let nodeId = repo.node_id;
    if (!nodeId) {
      // Resolve node_id on the fly via GraphQL
      const [owner, name] = repo.name.split("/");
      if (owner && name) {
        try {
          const repoQuery = `
            query($owner: String!, $name: String!) {
              repository(owner: $owner, name: $name) {
                id
              }
            }
          `;
          const repoData = await githubGraphQL(repoQuery, { owner, name });
          nodeId = repoData?.repository?.id;
        } catch (err) {
          // ignore
        }
      }
    }

    if (!nodeId) {
      console.warn(`[${i + 1}/${repos.length}] Warning: Could not resolve GraphQL node_id for repo: ${repo.name}`);
      failCount++;
      continue;
    }

    try {
      const assignMutation = `
        mutation($itemId: ID!, $listIds: [ID!]!) {
          updateUserListsForItem(input: { itemId: $itemId, listIds: $listIds }) {
            clientMutationId
          }
        }
      `;
      await githubGraphQL(assignMutation, {
        itemId: nodeId,
        listIds: [listId],
      });
      assignedCount++;
      console.log(`[${i + 1}/${repos.length}] Assigned ${repo.name} -> "${cat}"`);
      // 120ms delay between mutations
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      console.error(`[${i + 1}/${repos.length}] Error assigning ${repo.name}:`, err.message);
      failCount++;
    }
  }

  console.log("\n=== Synchronization Complete! ===");
  console.log(`Successfully assigned: ${assignedCount}/${repos.length} repositories`);
  if (failCount > 0) console.log(`Failed / Skipped: ${failCount}`);
  console.log(`View your live lists on GitHub: https://github.com/stars/${login}/lists\n`);
}

syncToGitHub().catch((err) => {
  console.error("Fatal error during sync:", err);
  process.exit(1);
});

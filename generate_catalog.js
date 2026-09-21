import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = __dirname;
const CATALOG_PATH = path.join(WORKSPACE_DIR, "GITHUB_STARS.md");
const SERVER_INDEX = path.join(__dirname, "index.js");

// Canonical Baseline Taxonomy
const BASELINE_TAXONOMY = [
  "AI & Agent Infrastructure",
  "Developer Tools & CLI",
  "System Design & Backend Architecture",
  "Frontend & UI Libraries",
  "Databases & Data Engineering",
  "Security & Reverse Engineering",
  "Educational & Roadmaps",
  "Inspiration & Creative Ideas",
];

// Curated high-precision repository metadata
const CURATED_REPO_METADATA = {
  "affaan-m/ECC": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "High-performance agent harness providing skills, instincts, memory, and security optimizations for Claude Code, Codex, and Cursor.",
    tags: ["ai-agents", "claude-code", "mcp", "developer-tools"],
  },
  "logicrw/awesome-jev-projects": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Open-source ecosystem radar tracking System-1 agent architectures, plain-language discovery, and decision models.",
    tags: ["ai-agents", "system-1", "radar", "awesome-list"],
  },
  "miantiao-me/github-stars": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Cloudflare-powered Model Context Protocol server enabling natural language search and semantic querying over starred GitHub repositories.",
    tags: ["mcp", "github-stars", "cloudflare", "ai-agents"],
  },
  "github/github-mcp-server": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Official Model Context Protocol server connecting AI assistants directly to GitHub's platform for issues, PRs, and repository management.",
    tags: ["mcp", "github", "ai-agents", "developer-tools"],
  },
  "mnemox-ai/idea-reality-mcp": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Automated competitive reality check for AI coding agents scanning GitHub, Hacker News, npm, and PyPI before writing code.",
    tags: ["mcp", "market-research", "ai-agents", "idea-validation"],
  },
  "codetesla51/nine-fives": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Systems-design survival simulation and tower defense game powered by a headless Go engine with 23 components and AWS-measured pricing.",
    tags: ["system-design", "golang", "simulation", "architecture"],
  },
  "codetesla51/screentime": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Lightweight per-app screen-time tracking daemon in Go that monitors focused desktop windows to calculate daily productivity scores.",
    tags: ["productivity", "golang", "cli", "time-tracking"],
  },
  "kazdenc/regen-icons": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Clean, open-source SVG icon system tailored specifically for agent-built user interfaces and modern web applications.",
    tags: ["icons", "svg", "ui-library", "frontend"],
  },
  "donlon/cloudflare-error-page": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Interactive generator for crafting branded, informative, and user-friendly custom Cloudflare 5xx and maintenance error pages.",
    tags: ["cloudflare", "error-pages", "generator", "web-dev"],
  },
  "nilbuild/developer-roadmap": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Community-driven interactive roadmaps, guides, and career learning paths covering frontend, backend, DevOps, and computer science fundamentals.",
    tags: ["developer-roadmap", "career", "education", "learning-path"],
  },
  "debpalash/VoiceStudio": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Open-source, fully local ElevenLabs alternative delivering voice cloning, video dubbing, dictation, and speech synthesis across 646 languages.",
    tags: ["voice-ai", "tts", "local-first", "speech-synthesis"],
  },
  "receiptline/receiptline": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Specialized markdown language and command generator for thermal receipt printers, kiosks, and point-of-sale ticket rendering.",
    tags: ["markdown", "receipt-printer", "escpos", "creative-tool"],
  },
  "amaancoderx/npxskillui": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Static analysis tool that reverse-engineers production design systems into structured, prompt-ready agent skills for Claude Code.",
    tags: ["claude-code", "design-systems", "agent-skills", "static-analysis"],
  },
  "shadcn-labs/pdfcn": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Copy-paste React components powered by Takumi, Forme, and WASM for generating beautiful server-side and client-side PDF documents.",
    tags: ["react", "pdf-generation", "shadcn", "ui-components"],
  },
  "Leonxlnx/taste-skill": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Anti-slop frontend design framework equipping AI coding agents with typography, layout, and motion rules to avoid generic interfaces.",
    tags: ["ai-agents", "design-system", "claude-code", "anti-slop"],
  },
  "pbakaus/impeccable": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Design language and skill pack featuring 24 actionable commands that elevate AI coding agents into proficient UI designers.",
    tags: ["design-language", "ai-agents", "claude-code", "ui-design"],
  },
  "droidrun/mobilerun": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "LLM-agnostic mobile automation framework that translates natural language commands into device actions on Android and iOS.",
    tags: ["mobile-automation", "android", "ai-agents", "llm"],
  },
  "lukapiskorec/craftbot": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Autonomous architectural AI agent that ingests design briefs and documents to generate procedural Python code for 3D building generation.",
    tags: ["ai-agents", "architecture", "procedural-generation", "python"],
  },
  "ashemag/human-atlas": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Interactive 3D human anatomy explorer featuring 2,234 selectable anatomical meshes, body system layers, and exploded views in Three.js.",
    tags: ["threejs", "3d", "anatomy", "react"],
  },
  "mindcrypt/libros": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Curated research library containing textbooks, whitepapers, and technical documentation developed across cryptography and security investigations.",
    tags: ["cryptography", "security-research", "documentation", "books"],
  },
  "lnkiai/m3e-canvas": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Visual browser canvas for assembling Material 3 Expressive UI layouts that exports directly into prompt-ready specs for coding agents.",
    tags: ["material-design", "prototyping", "vibe-coding", "ui-canvas"],
  },
  "ddoemonn/interior": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Polished React animation primitives crafted specifically for tactile micro-interactions in the half-second following user clicks.",
    tags: ["react", "micro-interactions", "animations", "ui-components"],
  },
  "MBA329/Backend-from-first-Principle": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Comprehensive engineering handbook explaining backend systems, networking, concurrency, and persistence fundamentals from first principles.",
    tags: ["backend", "first-principles", "systems-engineering", "networking"],
  },
  "systemdesign42/system-design-academy": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Practical curriculum and newsletter covering large-scale distributed architectures, scalability patterns, and AI systems engineering.",
    tags: ["system-design", "distributed-systems", "scalability", "architecture"],
  },
  "kacperkapusciak/goldie": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Automated App Store and Google Play screenshot generator built to integrate seamlessly into agentic release and build pipelines.",
    tags: ["app-store", "screenshots", "developer-tools", "automation"],
  },
  "tt-a1i/archify": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Agent skill generating self-contained, interactive HTML architecture and sequence diagrams with animated data flows.",
    tags: ["diagram-as-code", "architecture-diagram", "developer-tools", "visualization"],
  },
  "diffusionstudio/editor": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Open-source, agent-first video editing engine where edits are expressed as code and rendered programmatically.",
    tags: ["video-editing", "ai-agents", "multimodal", "video-editor"],
  },
  "multica-ai/andrej-karpathy-skills": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Karpathy-inspired CLAUDE.md guidelines that optimize agent coding behavior and eliminate common LLM coding pitfalls.",
    tags: ["claude-code", "prompts", "ai-agents", "best-practices"],
  },
  "The-XSS-Rat/SecurityTesting": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "Hands-on security testing scripts, payload collections, and automation modules for ethical hackers and penetration testers.",
    tags: ["security-testing", "pentesting", "python", "vulnerability-assessment"],
  },
  "Gowtham-Darkseid/AutoPentestX": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "Automated penetration testing and vulnerability reporting toolkit designed for fast reconnaissance and security assessments.",
    tags: ["penetration-testing", "cybersecurity", "vulnerability-scanner", "reporting"],
  },
  "Teycir/BurpAPISecuritySuite": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "Advanced Burp Suite extension providing intelligent fuzzing, BOLA/IDOR detection, and OWASP API Top 10 vulnerability scanning.",
    tags: ["burp-suite", "api-security", "idor", "fuzzing"],
  },
  "software-mansion/TypeGPU": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Type-safe toolkit for WebGPU enabling developers to write compute and render shaders directly in TypeScript with compile-time type inference.",
    tags: ["webgpu", "typescript", "graphics", "shaders"],
  },
  "harry0703/MoneyPrinterTurbo": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "One-stop automated video creation pipeline that generates scripts, synthesizes voiceovers, matches footage, and renders HD short videos.",
    tags: ["ai-video", "automation", "content-generation", "workflow"],
  },
  "CarterPerez-dev/Cybersecurity-Projects": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Hands-on cybersecurity learning repository with 70 tiered projects, certification roadmaps, and portfolio-building blueprints.",
    tags: ["cybersecurity", "projects", "education", "roadmaps"],
  },
  "liquidslr/system-design-notes": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Structured summary notes and architecture diagrams based on Alex Xu's System Design Interview guides.",
    tags: ["system-design", "distributed-systems", "interview-prep", "architecture"],
  },
  "DietrichGebert/ponytail": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Minimalist senior-dev prompt ruleset for AI coding agents that enforces strict YAGNI principles to reduce unnecessary code.",
    tags: ["ai-agents", "claude-code", "yagni", "developer-productivity"],
  },
  "VictorEijkhout/TheArtofHPC_pdfs": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Comprehensive collection of textbooks and course lecture PDFs covering parallel programming, scientific algorithms, and HPC architectures.",
    tags: ["hpc", "parallel-computing", "scientific-computing", "textbook"],
  },
  "github/spec-kit": {
    category: "Developer Tools & CLI",
    elevator_pitch: "GitHub's open-source toolkit for Spec-Driven Development, empowering coding agents to work against structured specifications and PRDs.",
    tags: ["spec-driven", "copilot", "developer-tools", "prd"],
  },
  "Developer-Y/cs-video-courses": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Curated index of computer science video lecture series from universities worldwide spanning algorithms, AI, systems, and security.",
    tags: ["computer-science", "video-lectures", "education", "curated-list"],
  },
  "BraveOPotato/FckSignups": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Curated directory of zero-friction, open-source web utilities that execute entirely in-browser without requiring accounts or signups.",
    tags: ["open-source", "web-tools", "privacy", "in-browser"],
  },
  "pctrade/end4-pC": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Customized Hyprland rice and Quickshell configuration featuring modern Material Design aesthetics and desktop fluid workflows.",
    tags: ["hyprland", "dotfiles", "linux", "rice"],
  },
  "alexeygrigorev/ai-engineering-field-guide": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Empirical field guide exploring AI engineering interview assignments, take-home challenges, and hiring standards for modern practitioners.",
    tags: ["ai-engineering", "interviews", "career-guide", "machine-learning"],
  },
  "firecrawl/pdf-inspector": {
    category: "Developer Tools & CLI",
    elevator_pitch: "High-performance Rust library for PDF classification and text extraction, routing scanned versus text-based documents intelligently.",
    tags: ["rust", "pdf-extraction", "ocr", "developer-tools"],
  },
  "labex-labs/kubernetes-practice-labs": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Interactive hands-on lab exercises for mastering container orchestration, Kubernetes manifests, services, and cluster networking.",
    tags: ["kubernetes", "devops", "hands-on", "labs"],
  },
  "practical-tutorials/project-based-learning": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Extensive compilation of project-based programming tutorials guiding developers through building end-to-end applications from scratch.",
    tags: ["project-based-learning", "tutorials", "programming", "education"],
  },
  "msradam/kassi": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Autonomous AI agent that runs Grafana k6 load tests, pinpoints performance regressions in Splunk logs, and generates remediation patches.",
    tags: ["ai-agents", "mcp", "load-testing", "observability"],
  },
  "human2-0/tofufu-kitchen": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Zero-configuration peer-to-peer virtual LAN and networking engine providing private gaming tunnels, voice communication, and file sharing.",
    tags: ["p2p", "networking", "lan-tunnel", "backend"],
  },
  "kepano/kepano-obsidian": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Minimalist personal Obsidian vault template implementing a bottom-up knowledge management workflow by Obsidian's CEO.",
    tags: ["obsidian", "pkm", "knowledge-management", "productivity"],
  },
  "panglesd/slipshow": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Next-generation presentation engine that trades static slides for continuous, smoothly animated slip disclosures.",
    tags: ["presentations", "slideshow", "frontend", "ui"],
  },
  "J-jaeyoung/bad-epoll": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "In-depth technical writeup and exploit demonstrating unprivileged local root escalation on Google kernelCTF via Linux epoll subsystems.",
    tags: ["kernel-exploit", "linux", "security-research", "privilege-escalation"],
  },
  "screem500/guardzoo-early-evidence": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "Threat intelligence dossier containing early field indicators, malware analysis, and C2 infrastructure mapping for the GuardZoo campaign.",
    tags: ["threat-intel", "malware-analysis", "android", "indicators-of-compromise"],
  },
  "liquidslr/leetcode-company-wise-problems": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Comprehensive question sets and frequency matrices for technical interviews grouped by company tags across FAANG and top tech firms.",
    tags: ["leetcode", "interview-prep", "algorithms", "data-structures"],
  },
  "mrdbourke/zero-to-mastery-ml": {
    category: "Educational & Roadmaps",
    elevator_pitch: "End-to-end machine learning course repository featuring practical code notebooks and exercises across PyTorch, TensorFlow, and Scikit-Learn.",
    tags: ["machine-learning", "deep-learning", "data-science", "education"],
  },
  "thecmdguy/Ducky": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Open-source cross-platform desktop toolkit built in Python and PySide6 combining essential diagnostics and calculators for network engineers.",
    tags: ["networking", "desktop-app", "python", "developer-tools"],
  },
  "justcallmekoko/ESP32Marauder": {
    category: "Security & Reverse Engineering",
    elevator_pitch: "Portable wireless offensive and defensive security suite for ESP32 devices supporting packet capture, wardriving, and beacon analysis.",
    tags: ["esp32", "wireless-security", "pentesting", "firmware"],
  },
  "google-labs-code/design.md": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Official Google Labs format specification enabling teams to describe visual identity and design tokens directly to coding agents.",
    tags: ["design-systems", "ai-agents", "specification", "vibe-coding"],
  },
  "codecrafters-io/build-your-own-x": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Definitive repository of step-by-step guides for mastering software engineering by recreating databases, Git, Docker, and kernels from scratch.",
    tags: ["build-from-scratch", "systems-programming", "education", "awesome-list"],
  },
  "h4ckf0r0day/obscura": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "High-performance, anti-detect headless browser built in Rust with native CDP bindings designed for AI web scraping agents.",
    tags: ["headless-browser", "ai-agents", "rust", "web-scraping"],
  },
  "capcom6/android-sms-gateway": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Lightweight Android gateway app that exposes HTTP REST endpoints for programmatically sending, receiving, and forwarding SMS messages.",
    tags: ["android", "sms-gateway", "backend", "api"],
  },
  "siddharthvaddem/openscreen": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Open-source screen recording studio built with Electron and PixiJS for capturing crisp product walkthroughs with dynamic zooms.",
    tags: ["screen-recording", "electron", "developer-tools", "open-source"],
  },
  "VoltAgent/awesome-design-md": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Curated library of DESIGN.md files reverse-engineered from popular brand design systems for plug-and-play UI generation with agents.",
    tags: ["design-systems", "ai-agents", "design-tokens", "vibe-coding"],
  },
  "magnum6actual/flipoff": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Nostalgic web-based emulator that transforms any connected television into an authentic mechanical split-flap departure board.",
    tags: ["display-simulator", "retro", "creative", "web-app"],
  },
  "Crosstalk-Solutions/project-nomad": {
    category: "Databases & Data Engineering",
    elevator_pitch: "Offline-first knowledge repository packaging Wikipedia, open books, maps, and local AI onto self-contained hardware without internet.",
    tags: ["offline-first", "knowledge-base", "data-engineering", "self-hosted"],
  },
  "AlexsJones/llmfit": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Fast CLI tool that inspects local CPU, GPU, and RAM to benchmark and recommend the highest-performing open LLMs your hardware can run.",
    tags: ["hardware-profiler", "local-llm", "cli", "benchmarking"],
  },
  "koala73/worldmonitor": {
    category: "Databases & Data Engineering",
    elevator_pitch: "Situational awareness intelligence dashboard aggregating real-time geopolitical news, infrastructure monitoring, and OSINT feeds.",
    tags: ["dashboard", "osint", "real-time-data", "data-engineering"],
  },
  "madd86/awesome-system-design": {
    category: "System Design & Backend Architecture",
    elevator_pitch: "Curated catalog of distributed systems literature, architecture blueprints, message queuing paradigms, and scalability interview prep.",
    tags: ["system-design", "distributed-systems", "microservices", "awesome-list"],
  },
  "keithschacht/taskmaster": {
    category: "Inspiration & Creative Ideas",
    elevator_pitch: "Voice-first interactive task manager that streams audio over LiveKit WebRTC and triggers real-time task updates via ActionCable websockets.",
    tags: ["voice-ai", "livekit", "webrtc", "productivity"],
  },
  "harvard-edge/cs249r_book": {
    category: "Educational & Roadmaps",
    elevator_pitch: "Open-access Harvard textbook series detailing the foundations, scaling laws, and engineering practices of ML systems and agentic AI.",
    tags: ["machine-learning", "textbook", "harvard", "ml-systems"],
  },
  "Cranot/claude-code-guide": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Living reference guide and workflow manual for Claude Code CLI detailing commands, MCP configuration, and agent development tips.",
    tags: ["claude-code", "cli", "cheatsheet", "developer-tools"],
  },
  "Zie619/n8n-workflows": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Massive collection of production n8n workflows covering webhook automations, third-party API orchestrations, and data ingestion pipelines.",
    tags: ["n8n", "automation", "workflows", "integrations"],
  },
  "DavidHDev/react-bits": {
    category: "Frontend & UI Libraries",
    elevator_pitch: "Comprehensive library of 200+ animated, interactive React UI components built with Tailwind CSS and modern CSS animations.",
    tags: ["react", "ui-components", "animations", "tailwind"],
  },
  "davila7/claude-code-templates": {
    category: "Developer Tools & CLI",
    elevator_pitch: "Command-line tool for configuring, provisioning, and monitoring Claude Code profiles and development environments.",
    tags: ["claude-code", "cli", "configuration", "developer-tools"],
  },
  "Doriandarko/sora-mcp": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Model Context Protocol server integrating OpenAI's Sora 2 API to enable autonomous text-to-video generation within AI agents.",
    tags: ["mcp", "sora", "video-generation", "ai-agents"],
  },
  "contains-studio/agents": {
    category: "AI & Agent Infrastructure",
    elevator_pitch: "Ready-to-use directory of specialized sub-agents configured for rapid application development workflows within Claude Code.",
    tags: ["claude-code", "sub-agents", "ai-agents", "developer-tools"],
  },
};

/**
 * Fallback classifier for new repositories fetched from worker chunks
 */
function classifyRepoFromReadme(repo) {
  const name = repo.full_name || repo.name || "Unknown";
  const url = repo.html_url || repo.url || `https://github.com/${name}`;
  const text = `${name} ${repo.description || ""} ${repo.readme_snippet || ""} ${(repo.topics || []).join(" ")}`.toLowerCase();

  let category = "Developer Tools & CLI";
  if (/\b(agent|llm|mcp|model context protocol|gpt|claude|prompt|openai|anthropic|langchain|rag|tts|speech|audio|embedding|diffusion|transformer)\b/i.test(text)) {
    category = "AI & Agent Infrastructure";
  } else if (/\b(reverse engineering|exploit|vulnerability|pentest|security|kernelctf|cve|burp|packet|malware|fuzzing|idor)\b/i.test(text)) {
    category = "Security & Reverse Engineering";
  } else if (/\b(database|sql|nosql|postgres|sqlite|duckdb|osint|feed|dataset|etl|pipeline|streaming|kafka)\b/i.test(text)) {
    category = "Databases & Data Engineering";
  } else if (/\b(react|vue|ui|css|tailwind|components|icons|svg|frontend|canvas|webgpu|shader|svelte)\b/i.test(text)) {
    category = "Frontend & UI Libraries";
  } else if (/\b(roadmap|course|tutorial|interview|learn|learning|guide|textbook|handbook|curriculum|education|cs-video)\b/i.test(text)) {
    category = "Educational & Roadmaps";
  } else if (/\b(creative|game|rice|dotfiles|hyprland|fun|experimental|kiosk|split-flap|simulator)\b/i.test(text)) {
    category = "Inspiration & Creative Ideas";
  } else if (/\b(distributed|architecture|backend|networking|p2p|scalability|microservices|golang|concurrency)\b/i.test(text)) {
    category = "System Design & Backend Architecture";
  }

  let pitch = repo.description || "";
  if (!pitch || pitch.length < 20) {
    const cleanReadme = (repo.readme_snippet || "")
      .replace(/#+ [^\n]+/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    const firstSentence = cleanReadme.split(/(?<=[.!?])\s+/)[0] || "";
    pitch = firstSentence.slice(0, 200).trim();
  }
  if (!pitch || pitch.length < 15) {
    pitch = `Open-source repository focusing on ${category.toLowerCase()}.`;
  }
  if (!/[.!?]$/.test(pitch)) {
    pitch += ".";
  }

  const tags = [];
  if (Array.isArray(repo.topics) && repo.topics.length > 0) {
    tags.push(...repo.topics.slice(0, 4));
  }
  if (tags.length < 3) {
    const defaultTagMap = {
      "AI & Agent Infrastructure": ["ai-agents", "mcp", "llm", "developer-tools"],
      "Developer Tools & CLI": ["cli", "developer-tools", "productivity", "automation"],
      "System Design & Backend Architecture": ["backend", "distributed-systems", "architecture", "system-design"],
      "Frontend & UI Libraries": ["frontend", "ui-components", "react", "design-system"],
      "Databases & Data Engineering": ["database", "data-engineering", "analytics", "storage"],
      "Security & Reverse Engineering": ["security", "reverse-engineering", "cybersecurity", "vulnerability"],
      "Educational & Roadmaps": ["education", "learning", "roadmaps", "tutorials"],
      "Inspiration & Creative Ideas": ["creative", "inspiration", "open-source", "projects"],
    };
    const defaults = defaultTagMap[category] || ["open-source", "developer-tools", "software"];
    for (const t of defaults) {
      if (!tags.includes(t) && tags.length < 4) {
        tags.push(t);
      }
    }
  }

  return {
    name,
    url,
    node_id: repo.node_id,
    category,
    elevator_pitch: pitch,
    tags: tags.slice(0, 5),
    archived: Boolean(repo.archived),
  };
}

async function main() {
  console.log("=== Launching End-to-End GitHub Stars Organization ===");

  // Connect to local github-stars-mcp server via StdioClientTransport
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_INDEX],
    cwd: WORKSPACE_DIR,
  });

  const client = new Client(
    { name: "catalog-orchestrator", version: "1.0.0" },
    { capabilities: {} }
  );

  console.log("1. Connecting to github-stars-mcp server...");
  await client.connect(transport);
  console.log("-> Connected successfully!");

  // Step 2: Initialize orchestration session
  console.log("2. Initializing orchestration session with 4 workers...");
  const orchRes = await client.callTool({
    name: "github_orchestrate_workers",
    arguments: {
      num_workers: 4,
      profile: "compact",
    },
  });
  const orchData = JSON.parse(orchRes.content[0].text);
  const sessionId = orchData.session_id;
  console.log(`-> Session ID: ${sessionId}, Total Stars Frozen: ${orchData.total_stars_frozen}`);

  // Step 3: Worker Map/Reduce - Fetch each chunk via github_get_worker_chunk and submit digests
  console.log("3. Fetching worker chunks and submitting digests...");
  for (const plan of orchData.worker_plans) {
    const workerId = plan.worker_id;
    console.log(`-> Fetching chunk for ${workerId} (indices ${plan.start_index}-${plan.end_index}, expected ${plan.repo_count} repos)...`);
    
    // Call github_get_worker_chunk to get repos with distilled READMEs
    const chunkRes = await client.callTool({
      name: "github_get_worker_chunk",
      arguments: {
        session_id: sessionId,
        worker_id: workerId,
        profile: "compact",
      },
    });
    const chunkData = JSON.parse(chunkRes.content[0].text);
    assert.ok(Array.isArray(chunkData.repos), "Chunk must contain repos array");
    console.log(`   Fetched ${chunkData.repos.length} repositories from snapshot.`);

    // Map each repo to curated digest or fallback analysis
    const analyzedRepos = chunkData.repos.map((repo) => {
      const repoFullName = repo.full_name || repo.name;
      const curated = CURATED_REPO_METADATA[repoFullName] || CURATED_REPO_METADATA[repo.name];
      if (curated) {
        return {
          name: repoFullName,
          url: repo.html_url || repo.url || `https://github.com/${repoFullName}`,
          node_id: repo.node_id,
          category: curated.category,
          elevator_pitch: curated.elevator_pitch,
          tags: curated.tags,
          archived: Boolean(repo.archived),
        };
      }
      return classifyRepoFromReadme(repo);
    });

    console.log(`-> Submitting ${workerId} digest (${analyzedRepos.length} repos)...`);
    const submitRes = await client.callTool({
      name: "github_submit_worker_digest",
      arguments: {
        session_id: sessionId,
        worker_id: workerId,
        analyzed_repos: analyzedRepos,
      },
    });
    const submitData = JSON.parse(submitRes.content[0].text);
    console.log(`   Result: status=${submitData.status}, total_unique_cataloged=${submitData.total_unique_repos_cataloged}`);
  }

  // Step 4: Check orchestration status
  console.log("4. Verifying orchestration status via github_get_orchestration_status...");
  const statusRes = await client.callTool({
    name: "github_get_orchestration_status",
    arguments: { session_id: sessionId },
  });
  const statusData = JSON.parse(statusRes.content[0].text);
  console.log(`-> Orchestration all_completed: ${statusData.all_completed}`);
  console.log(`-> Total repos cataloged: ${statusData.total_unique_repos_cataloged}`);
  console.log(`-> Compiled categories count: ${statusData.compiled_categories.length}`);
  assert.strictEqual(statusData.all_completed, true, "All workers should be completed");
  assert.strictEqual(statusData.total_unique_repos_cataloged, orchData.total_stars_frozen, "Must catalog all frozen repos");

  // Step 5: Export catalog via github_export_catalog
  console.log("5. Exporting catalog via github_export_catalog to GITHUB_STARS.md...");
  const exportRes = await client.callTool({
    name: "github_export_catalog",
    arguments: {
      file_path: "GITHUB_STARS.md",
      catalog_title: "Curated GitHub Starred Repositories",
      mode: "overwrite",
      compiled_categories: statusData.compiled_categories,
    },
  });
  const exportData = JSON.parse(exportRes.content[0].text);
  console.log("-> Export result:", exportData);
  assert.strictEqual(exportData.success, true, "Export tool must return success: true");

  await client.close();

  // Step 6: Direct filesystem verification
  console.log("\n6. Verifying generated GITHUB_STARS.md in workspace...");
  const catalogContent = await fs.readFile(CATALOG_PATH, "utf-8");
  console.log(`-> File size: ${catalogContent.length} bytes`);
  assert.ok(catalogContent.length > 5000, "Catalog file should be substantial");

  // Verify Table of Contents
  assert.ok(catalogContent.includes("## Table of Contents"), "Must include Table of Contents header");

  // Verify all 8 taxonomy categories exist in markdown and TOC
  for (const cat of BASELINE_TAXONOMY) {
    assert.ok(
      catalogContent.includes(`## ${cat}`),
      `Missing category section: ## ${cat}`
    );
    assert.ok(
      catalogContent.includes(`- [${cat}](`),
      `Missing TOC entry for category: ${cat}`
    );
  }

  // Verify archived repo tag
  assert.ok(
    catalogContent.includes("### [siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) [ARCHIVED]"),
    "Archived repository must have [ARCHIVED] tag"
  );

  // Verify all 74 repos are present by checking repo headings
  let repoMatches = 0;
  for (const repoName of Object.keys(CURATED_REPO_METADATA)) {
    const needle = `[${repoName}](https://github.com/${repoName})`;
    assert.ok(
      catalogContent.includes(needle),
      `Repo ${repoName} missing in catalog!`
    );
    repoMatches++;
  }
  console.log(`-> Successfully verified all ${repoMatches} repositories present in GITHUB_STARS.md!`);

  // Verify tags and pitches for each repo entry
  const repoSections = catalogContent.split(/\n### /).slice(1);
  assert.strictEqual(repoSections.length, 74, "Must have exactly 74 repo sections");
  for (const sec of repoSections) {
    const lines = sec.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0];
    const tagLine = lines.find((l) => l.startsWith("**Tags**:"));
    assert.ok(tagLine, `Missing **Tags** line in section: ${title}`);
    const rawTagStr = tagLine.replace(/^\*\*Tags\*\*:\s*/, "");
    const tags = rawTagStr.split(",").map((t) => t.trim().replace(/^`|`$/g, ""));
    assert.ok(tags.length >= 3 && tags.length <= 5, `Expected 3-5 tags in ${title}, got: ${tags.length}`);

    const tagIdx = lines.findIndex((l) => l.startsWith("**Tags**:"));
    const pitch = lines.slice(1, tagIdx).join(" ");
    assert.ok(pitch.length >= 15, `Elevator pitch too short in ${title}: ${pitch}`);
  }
  console.log("-> Successfully verified all 74 entries have valid 3-5 tags and elevator pitches!");

  // Print sample preview of Table of Contents
  const tocSnippet = catalogContent.split("---")[0];
  console.log("\n--- Generated Table of Contents Preview ---");
  console.log(tocSnippet.trim());
  console.log("-------------------------------------------\n");

  console.log("=== Catalog generation and verification complete with ZERO errors! ===");
}

main().catch((err) => {
  console.error("FATAL ERROR during catalog generation:", err);
  process.exit(1);
});

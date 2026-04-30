#!/usr/bin/env python3
"""
Build the inlined skills graph HTML from graphify output.

Reads:
  <workspace>/graphify-out/skills_graph.json
  <workspace>/graphify-out/.graphify_labels.json

Writes:
  src/ui/graph-html.ts  (a TS module: export const GRAPH_HTML = `...`)

The renderer is adapted from RUBRIC Skill Trees (Canvas force-directed).
Differences vs upstream:
  - No agent layer. Skills only.
  - Color = community label (graphify Louvain communities).
  - Edges = graphify cross-references between skill folders.
  - Data is inlined; no server calls.
  - RUBRIC attribution badge retained per MIT-with-attribution license.
"""
import json
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
GRAPHIFY_DIR = Path(
    os.environ.get(
        "GRAPHIFY_OUT",
        "./graphify-out",
    )
)

PALETTE = [
    "#58abf5",  # blue
    "#f5a623",  # orange
    "#b47aff",  # purple
    "#50e3c2",  # teal
    "#ff6b6b",  # red
    "#ffd60a",  # yellow
    "#30d158",  # green
    "#ff2d55",  # pink
    "#5ac8fa",  # cyan
    "#af52de",  # magenta
    "#ff9500",  # tangerine
    "#00c7be",  # mint
]

# Agent routing table , derived from CLAUDE.md.
# A skill is mapped to an agent if any keyword fragment matches the skill's
# folder name or description (case-insensitive).
AGENTS = [
    {
        "id": "alex",
        "name": "Alex",
        "role": "Head of Sales",
        "color": "#58abf5",
        "keywords": [
            "sales", "pipeline", "lead", "outreach", "cold-email", "coldiq",
            "proposal", "prospect", "crm", "deal", "qualif",
        ],
    },
    {
        "id": "peter",
        "name": "Peter",
        "role": "CTO",
        "color": "#f5a623",
        "keywords": [
            "code", "infrastructure", "security", "deploy", "git", "ci-cd",
            "monitor", "test", "debug", "vercel", "supabase", "docker", "api",
            "paperclip", "hyperframe", "kubernetes", "auth", "mcp", "sdk",
        ],
    },
    {
        "id": "tony",
        "name": "Tony",
        "role": "Chief Life Officer",
        "color": "#b47aff",
        "keywords": [
            "health", "family", "boxing", "meal", "sleep", "fitness", "wellness",
            "nutrition", "recovery", "back-pain", "training",
        ],
    },
    {
        "id": "vale",
        "name": "Vale",
        "role": "Chief Relocation Officer",
        "color": "#50e3c2",
        "keywords": [
            "spain", "visa", "relocation", "housing", "move", "immigration",
            "passport", "expat",
        ],
    },
    {
        "id": "nemo",
        "name": "Nemo",
        "role": "Chief Research Officer",
        "color": "#ff6b6b",
        "keywords": [
            "research", "methodology", "data-analysis", "market", "competitive",
            "study", "scrape", "crawler", "ingest", "perplexity", "autoresearch",
            "search-engine", "scholar",
        ],
    },
    {
        "id": "atlas",
        "name": "Atlas",
        "role": "Chief Opportunity Officer",
        "color": "#ffd60a",
        "keywords": [
            "opportunit", "partnership", "monetiz", "growth", "investor",
            "fundraising", "vc", "deck", "pitch",
        ],
    },
    {
        "id": "marly",
        "name": "Marly",
        "role": "Media Manager",
        "color": "#30d158",
        "keywords": [
            "social", "content", "post", "brand", "pr", "instagram", "linkedin",
            "twitter", "tiktok", "youtube", "blog", "newsletter", "funnel",
            "perspective",
        ],
    },
    {
        "id": "martin",
        "name": "Martin",
        "role": "Chief Hustle Officer",
        "color": "#ff2d55",
        "keywords": [
            "revenue", "sla", "stale-lead", "deal-velocity", "follow-up",
            "hustle", "closer",
        ],
    },
    {
        "id": "pei-ling",
        "name": "Pei-Ling",
        "role": "Creative Strategist",
        "color": "#5ac8fa",
        "keywords": [
            "creative", "video", "imagery", "image", "audio", "music",
            "production", "ad-creative", "asset", "render", "model-card",
            "audiocraft", "blip", "clip", "diffusion",
        ],
    },
    {
        "id": "emil",
        "name": "Emil",
        "role": "Design Engineer",
        "color": "#af52de",
        "keywords": [
            "ux", "ui-design", "usability", "design-system", "hig", "design-sprint",
            "spacing", "typography", "wcag", "a11y", "accessibility", "tailwind",
            "figma", "design-token",
        ],
    },
    {
        "id": "chef",
        "name": "Chef",
        "role": "Ecommerce Ops",
        "color": "#ff9500",
        "keywords": [
            "shopify", "checkout", "cart", "capi", "atc", "store-config",
            "ecommerce", "merch", "pixel", "klaviyo",
        ],
    },
    {
        "id": "hunter",
        "name": "Hunter",
        "role": "Career Ops",
        "color": "#00c7be",
        "keywords": [
            "job", "jd-", "offer-eval", "cv-", "recruiter", "hiring", "ats",
            "resume", "salary",
        ],
    },
]


def _match_keyword(text: str, kw: str) -> bool:
    """Word-boundary match. Treats hyphens/underscores as boundaries so 'ci-cd'
    matches 'ci-cd' but 'pr' does not match 'process' or 'product'."""
    import re

    pattern = r"(?:^|[^a-z0-9])" + re.escape(kw.lower()) + r"(?:[^a-z0-9]|$)"
    return bool(re.search(pattern, text))


def map_skills_to_agents(nodes: list) -> dict:
    mapping: dict[str, list[str]] = {}
    for n in nodes:
        text = (
            (n.get("folder") or "").lower()
            + " "
            + (n.get("label") or "").lower()
            + " "
            + (n.get("description") or "").lower()
        )
        matched = []
        for agent in AGENTS:
            for kw in agent["keywords"]:
                if _match_keyword(text, kw):
                    matched.append(agent["id"])
                    break
        if matched:
            mapping[n["id"]] = matched
    return mapping


def load_graph() -> tuple[list, list, dict]:
    graph = json.loads((GRAPHIFY_DIR / "skills_graph.json").read_text())
    labels_path = GRAPHIFY_DIR / ".graphify_labels.json"
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    return graph["nodes"], graph["links"], labels


def slim_node(n: dict) -> dict:
    desc = n.get("description") or ""
    if len(desc) > 280:
        desc = desc[:277] + "..."
    return {
        "id": n["id"],
        "label": n.get("folder") or n.get("label") or n["id"],
        "description": desc,
        "community": n.get("community", 0),
        "sourceFile": n.get("source_file"),
    }


def slim_link(l: dict) -> dict:
    return {
        "source": l["source"],
        "target": l["target"],
        "weight": l.get("weight", 1.0),
    }


def build_payload() -> dict:
    nodes, links, labels = load_graph()
    # Filter to skill nodes only (graphify sometimes adds non-skill nodes)
    skill_nodes = [n for n in nodes if n.get("source_file", "").startswith("skills/")]
    valid_ids = {n["id"] for n in skill_nodes}
    skill_links = [l for l in links if l["source"] in valid_ids and l["target"] in valid_ids]

    communities = {}
    for n in skill_nodes:
        communities.setdefault(n.get("community", 0), 0)
        communities[n.get("community", 0)] += 1

    palette_map = {}
    for idx, comm_id in enumerate(sorted(communities.keys())):
        palette_map[str(comm_id)] = PALETTE[idx % len(PALETTE)]

    skill_agent_map = map_skills_to_agents(skill_nodes)
    agent_skill_count = {a["id"]: 0 for a in AGENTS}
    for sid, agents in skill_agent_map.items():
        for aid in agents:
            agent_skill_count[aid] = agent_skill_count.get(aid, 0) + 1

    return {
        "nodes": [slim_node(n) for n in skill_nodes],
        "links": [slim_link(l) for l in skill_links],
        "communities": [
            {
                "id": int(comm_id),
                "label": labels.get(str(comm_id), f"Community {comm_id}"),
                "color": palette_map[str(comm_id)],
                "size": communities[comm_id],
            }
            for comm_id in sorted(communities.keys())
        ],
        "agents": [
            {
                "id": a["id"],
                "name": a["name"],
                "role": a["role"],
                "color": a["color"],
                "skillCount": agent_skill_count.get(a["id"], 0),
            }
            for a in AGENTS
        ],
        "skillAgents": skill_agent_map,
    }


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skills Graph</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050505;
    --text: #e0e0e0;
    --text-secondary: #999;
    --text-muted: #666;
    --accent: #58abf5;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif; }

  canvas { display: block; }

  .tooltip {
    position: absolute; background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
    padding: 10px 14px; font-size: 13px; color: var(--text); max-width: 320px;
    pointer-events: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  .tip-name { font-weight: 600; margin-bottom: 4px; }
  .tip-desc { color: #aaa; font-size: 12px; line-height: 1.4; }
  .tip-comm { color: #666; font-size: 11px; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.4px; }

  .detail {
    position: absolute; top: 16px; right: 16px; width: 380px; max-height: calc(100% - 32px);
    background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 12px; padding: 20px;
    overflow-y: auto; z-index: 50; font-family: 'Outfit', sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6); transition: width 0.2s ease;
  }
  .detail h3 { margin: 0 0 8px; font-size: 16px; color: var(--text); }
  .detail p { margin: 6px 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
  .d-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px; margin-top: 14px; }
  .d-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .d-tag { font-size: 12px; padding: 3px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); color: var(--text-secondary); }
  .d-source { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #555; margin-top: 12px; word-break: break-all; }
  .detail-close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: #666; font-size: 20px; cursor: pointer; padding: 4px 8px; }
  .detail-close:hover { color: var(--text); }

  .legend {
    position: absolute; top: 16px; left: 20px; z-index: 30; font-family: 'Outfit', sans-serif;
    background: rgba(10,10,10,0.85); border: 1px solid #1a1a1a; border-radius: 10px;
    padding: 12px 14px; max-width: 280px; max-height: calc(100% - 200px); overflow-y: auto;
  }
  .toolbar {
    position: absolute; top: 16px; right: 16px; z-index: 40; display: flex; gap: 8px;
    font-family: 'Outfit', sans-serif;
  }
  .toolbar input {
    background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 8px;
    padding: 8px 12px; font-size: 13px; color: var(--text); width: 220px;
    font-family: 'Outfit', sans-serif; outline: none; transition: border-color 0.15s;
  }
  .toolbar input:focus { border-color: #333; }
  .toolbar input::placeholder { color: #555; }
  .toolbar button {
    background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 8px;
    padding: 8px 14px; font-size: 12px; color: var(--text-secondary);
    cursor: pointer; font-family: 'Outfit', sans-serif; transition: all 0.15s;
  }
  .toolbar button:hover { color: var(--text); border-color: #333; }
  .toolbar button.active { color: #050505; background: var(--accent); border-color: var(--accent); }
  .search-stats { font-size: 11px; color: #555; align-self: center; padding: 0 4px; }
  .legend-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }
  .legend-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; font-size: 12px; color: var(--text-secondary); }
  .legend-row:hover { color: var(--text); }
  .legend-row.dim { opacity: 0.4; }
  .legend-swatch { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .legend-count { color: #555; font-size: 11px; margin-left: auto; }

  .wf-rubric-brand { position: absolute; bottom: 16px; left: 20px; z-index: 30; font-family: 'Outfit', sans-serif; }
  .wf-rubric-name { font-size: 18px; font-weight: 700; letter-spacing: 3px; color: #c8c8c8; -webkit-font-smoothing: antialiased; }
  .wf-rubric-product { font-weight: 400; color: #555; font-size: 14px; letter-spacing: 1px; }
  .wf-rubric-attribution { font-size: 10px; color: #444; margin-top: 4px; }
  .wf-rubric-link { color: #ff6b1a; text-decoration: none; transition: color 0.15s; }
  .wf-rubric-link:hover { color: #ff8c4a; text-decoration: underline; }

  .stats {
    position: absolute; bottom: 16px; right: 20px; z-index: 30;
    font-size: 11px; color: #555; font-family: 'JetBrains Mono', monospace;
    text-align: right;
  }
  .stats span { color: #888; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>

<div id="tooltip" class="tooltip" style="display:none;">
  <div class="tip-name"></div>
  <div class="tip-desc"></div>
  <div class="tip-comm"></div>
</div>

<div id="detail" class="detail" style="display:none;">
  <button class="detail-close" id="detail-close">&times;</button>
  <div id="detail-content"></div>
</div>

<div id="legend" class="legend">
  <div class="legend-title">Communities</div>
  <div id="legend-rows"></div>
</div>

<div class="toolbar">
  <input id="search" type="search" placeholder="Search skills..." autocomplete="off" />
  <span id="search-stats" class="search-stats"></span>
  <button id="toggle-agents" title="Show agent overlay">Agents</button>
</div>

<div class="wf-rubric-brand">
  <div class="wf-rubric-name">RUBRIC <span class="wf-rubric-product">Skill Trees</span></div>
  <div class="wf-rubric-attribution">
    Renderer adapted from
    <a href="https://robolabs.so/" target="_blank" class="wf-rubric-link">RoboLabs</a>.
    Learn more at <a href="https://robonuggets.com" target="_blank" class="wf-rubric-link">RoboNuggets</a>.
  </div>
</div>

<div id="stats" class="stats"></div>

<script>
const DATA = __DATA_PAYLOAD__;

(function() {
  const REPULSION = 1400;
  const ATTRACTION = 0.004;
  const COMMUNITY_GRAVITY = 0.012;
  const CENTER_GRAVITY = 0.001;
  const DAMPING = 0.65;
  const EDGE_LENGTH = 90;
  const SKILL_RADIUS_MIN = 4;
  const SKILL_RADIUS_MAX = 12;

  let nodes = [], edges = [];
  let communityCenters = {};
  let agentSlots = [];           // {id, x, y, color, name, skillIds:Set}
  let hovered = null, selected = null, dragging = null;
  let animId = null;
  let panX = 0, panY = 0, zoom = 1;
  let panning = false, spaceHeld = false;
  let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
  let dimmedCommunities = new Set();
  let agentLayerOn = false;
  let activeAgent = null;        // when set, only that agent's skills are highlighted
  let searchQuery = "";
  let searchMatchIds = null;     // Set of node ids matching search; null = no search

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const detail = document.getElementById('detail');

  function hexToRgba(hex, alpha) {
    if (!hex || hex.length < 7) return 'rgba(128,128,128,' + alpha + ')';
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function buildGraph() {
    nodes = [];
    edges = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = W / 2, cy = H / 2;

    const commColor = {};
    DATA.communities.forEach((c) => { commColor[c.id] = c.color; });

    // Place each community center on a ring around the canvas
    const commCount = DATA.communities.length;
    DATA.communities.forEach((c, i) => {
      const angle = (i / commCount) * Math.PI * 2 - Math.PI / 2;
      const dist = Math.min(W, H) * 0.32;
      communityCenters[c.id] = {
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        color: c.color,
        label: c.label,
      };
    });

    // Compute degree for sizing
    const degree = {};
    DATA.links.forEach((l) => {
      degree[l.source] = (degree[l.source] || 0) + 1;
      degree[l.target] = (degree[l.target] || 0) + 1;
    });
    const degVals = Object.values(degree);
    const minDeg = degVals.length ? Math.min.apply(null, degVals) : 0;
    const maxDeg = degVals.length ? Math.max.apply(null, degVals) : 1;
    function degToRadius(d) {
      if (!d || maxDeg === minDeg) return SKILL_RADIUS_MIN;
      const t = (d - minDeg) / (maxDeg - minDeg);
      return SKILL_RADIUS_MIN + t * (SKILL_RADIUS_MAX - SKILL_RADIUS_MIN);
    }

    DATA.nodes.forEach((n) => {
      const center = communityCenters[n.community] || { x: cx, y: cy };
      const jitter = () => (Math.random() - 0.5) * 100;
      nodes.push({
        id: n.id,
        label: n.label,
        description: n.description,
        sourceFile: n.sourceFile,
        community: n.community,
        color: commColor[n.community] || '#888',
        x: center.x + jitter(),
        y: center.y + jitter(),
        vx: 0, vy: 0,
        radius: degToRadius(degree[n.id] || 0),
        degree: degree[n.id] || 0,
      });
    });

    DATA.links.forEach((l) => {
      const sNode = nodes.find(n => n.id === l.source);
      if (!sNode) return;
      edges.push({
        source: l.source,
        target: l.target,
        weight: l.weight || 1,
        color: sNode.color,
      });
    });
  }

  function physics() {
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const cx = W / 2, cy = H / 2;

    // Repulsion (only same-community + neighbors to keep cost manageable)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (a.community !== b.community) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = a.radius + b.radius + 4;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
        if (dist < minDist) {
          const overlap = (minDist - dist) / 2;
          a.x -= (dx / dist) * overlap;
          a.y -= (dy / dist) * overlap;
          b.x += (dx / dist) * overlap;
          b.y += (dy / dist) * overlap;
        }
      }
    }

    // Edge attraction
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source);
      const b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - EDGE_LENGTH) * ATTRACTION * (e.weight || 1);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Gravity toward community center
    for (const n of nodes) {
      const center = communityCenters[n.community];
      if (center) {
        n.vx += (center.x - n.x) * COMMUNITY_GRAVITY;
        n.vy += (center.y - n.y) * COMMUNITY_GRAVITY;
      }
      n.vx += (cx - n.x) * CENTER_GRAVITY;
      n.vy += (cy - n.y) * CENTER_GRAVITY;
    }

    for (const n of nodes) {
      if (n === dragging) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(n.radius, Math.min(W - n.radius, n.x));
      n.y = Math.max(n.radius, Math.min(H - n.radius, n.y));
    }
  }

  function layoutAgents() {
    const W = window.innerWidth;
    const PAD = 320;            // leave room on the sides for legend + side panel
    const usable = Math.max(400, W - PAD * 2);
    const spacing = usable / (DATA.agents.length + 1);
    agentSlots = DATA.agents.map((a, i) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      color: a.color,
      skillCount: a.skillCount,
      x: PAD + spacing * (i + 1),
      y: 70,
      skillIds: new Set(
        Object.entries(DATA.skillAgents)
          .filter(([_, agents]) => agents.indexOf(a.id) !== -1)
          .map(([sid]) => sid)
      ),
    }));
  }

  function nodeIsDimmed(n) {
    if (dimmedCommunities.has(n.community)) return true;
    if (searchMatchIds && !searchMatchIds.has(n.id)) return true;
    if (activeAgent) {
      const slot = agentSlots.find(a => a.id === activeAgent);
      if (slot && !slot.skillIds.has(n.id)) return true;
    }
    if (focusNodeId() && !hovNodeIds().has(n.id)) return true;
    return false;
  }
  function focusNodeId() {
    const f = selected || hovered;
    return f ? f.id : null;
  }
  function hovNodeIds() {
    const ids = new Set();
    const fid = focusNodeId();
    if (!fid) return ids;
    ids.add(fid);
    edges.forEach(e => {
      if (e.source === fid) ids.add(e.target);
      if (e.target === fid) ids.add(e.source);
    });
    return ids;
  }

  function render() {
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.save();
    ctx.translate(panX, panY);

    const fid = focusNodeId();
    const hovIds = hovNodeIds();
    const focusedEdges = new Set();
    if (fid) {
      edges.forEach(e => {
        if (e.source === fid || e.target === fid) focusedEdges.add(e);
      });
    }

    // Edges
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source);
      const b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      const aDim = dimmedCommunities.has(a.community);
      const bDim = dimmedCommunities.has(b.community);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if ((fid && !focusedEdges.has(e)) || aDim || bDim) {
        ctx.strokeStyle = 'rgba(40,40,40,0.25)';
        ctx.lineWidth = 0.4;
      } else {
        ctx.strokeStyle = hexToRgba(e.color, fid ? 0.55 : 0.18);
        ctx.lineWidth = focusedEdges.has(e) ? 1.5 : 0.7;
      }
      ctx.stroke();
    }

    // Nodes
    for (const n of nodes) {
      const dimmed = nodeIsDimmed(n);
      const highlighted = !dimmed && hovIds.has(n.id);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      if (dimmed) {
        ctx.fillStyle = '#0c0c0c';
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 0.4;
      } else if (highlighted) {
        ctx.fillStyle = hexToRgba(n.color, 0.32);
        ctx.strokeStyle = n.color;
        ctx.lineWidth = 1.6;
      } else {
        ctx.fillStyle = hexToRgba(n.color, 0.14);
        ctx.strokeStyle = hexToRgba(n.color, 0.45);
        ctx.lineWidth = 0.8;
      }
      ctx.fill();
      ctx.stroke();

      if (highlighted && (n === (selected || hovered))) {
        ctx.font = '11px Outfit, sans-serif';
        ctx.fillStyle = '#e8e8e8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(n.label, n.x, n.y - n.radius - 4);
      }
    }

    // Community labels (faint, at center)
    ctx.font = '11px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const cid in communityCenters) {
      if (dimmedCommunities.has(parseInt(cid))) continue;
      const c = communityCenters[cid];
      ctx.fillStyle = hexToRgba(c.color, 0.55);
      ctx.fillText(c.label.toUpperCase(), c.x, c.y - 4);
    }

    // Agent overlay: edges from each agent slot down to its skills, plus pill nodes
    if (agentLayerOn) {
      // Edges first
      for (const slot of agentSlots) {
        const isDimmedAgent = activeAgent && activeAgent !== slot.id;
        if (isDimmedAgent) continue;
        slot.skillIds.forEach((sid) => {
          const s = nodes.find(n => n.id === sid);
          if (!s) return;
          if (searchMatchIds && !searchMatchIds.has(sid)) return;
          if (dimmedCommunities.has(s.community)) return;
          ctx.beginPath();
          ctx.moveTo(slot.x, slot.y);
          ctx.lineTo(s.x, s.y);
          ctx.strokeStyle = hexToRgba(slot.color, activeAgent === slot.id ? 0.55 : 0.18);
          ctx.lineWidth = activeAgent === slot.id ? 1.2 : 0.5;
          ctx.stroke();
        });
      }
      // Agent pills
      for (const slot of agentSlots) {
        const dim = activeAgent && activeAgent !== slot.id;
        const isActive = activeAgent === slot.id;
        const r = 18;
        ctx.beginPath();
        ctx.arc(slot.x, slot.y, r, 0, Math.PI * 2);
        ctx.fillStyle = dim ? '#0a0a0a' : (isActive ? hexToRgba(slot.color, 0.35) : hexToRgba(slot.color, 0.18));
        ctx.strokeStyle = dim ? '#222' : slot.color;
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.fill();
        ctx.stroke();
        ctx.font = '11px Outfit, sans-serif';
        ctx.fillStyle = dim ? '#444' : slot.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(slot.name, slot.x, slot.y);
        ctx.font = '9px Outfit, sans-serif';
        ctx.fillStyle = dim ? '#333' : '#888';
        ctx.fillText(slot.skillCount + ' skills', slot.x, slot.y + r + 8);
      }
    }

    ctx.restore();
  }

  function animate() {
    physics();
    render();
    animId = requestAnimationFrame(animate);
  }
  function startAnim() { if (!animId) animate(); }

  function getAgentAt(mx, my) {
    if (!agentLayerOn) return null;
    for (const slot of agentSlots) {
      const dx = mx - slot.x, dy = my - slot.y;
      if (dx * dx + dy * dy <= 20 * 20) return slot;
    }
    return null;
  }

  function getNodeAt(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (dimmedCommunities.has(n.community)) continue;
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= (n.radius + 3) * (n.radius + 3)) return n;
    }
    return null;
  }

  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left - panX, y: e.clientY - rect.top - panY };
  }
  function getRawMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); spaceHeld = true; if (!panning) canvas.style.cursor = 'grab'; }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); spaceHeld = false; panning = false; canvas.style.cursor = hovered ? 'pointer' : 'default'; }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (panning) {
      const raw = getRawMousePos(e);
      panX = panOriginX + (raw.x - panStartX);
      panY = panOriginY + (raw.y - panStartY);
      return;
    }
    const pos = getMousePos(e);
    if (dragging) { dragging.x = pos.x; dragging.y = pos.y; return; }

    const agent = getAgentAt(pos.x, pos.y);
    if (agent) {
      hovered = null;
      canvas.style.cursor = 'pointer';
      tooltip.style.display = 'block';
      tooltip.querySelector('.tip-name').textContent = agent.name + ' , ' + agent.role;
      tooltip.querySelector('.tip-desc').textContent = agent.skillCount + ' skills mapped';
      tooltip.querySelector('.tip-comm').textContent = activeAgent === agent.id ? 'click to clear filter' : 'click to filter to this agent';
      const rawPos = getRawMousePos(e);
      tooltip.style.left = Math.min(rawPos.x + 16, window.innerWidth - 340) + 'px';
      tooltip.style.top = (rawPos.y - 10) + 'px';
      return;
    }

    const node = getNodeAt(pos.x, pos.y);
    hovered = node;
    canvas.style.cursor = node ? 'pointer' : 'default';

    if (node) {
      const commLabel = (DATA.communities.find(c => c.id === node.community) || {}).label || '';
      const agents = (DATA.skillAgents[node.id] || [])
        .map(aid => (DATA.agents.find(a => a.id === aid) || {}).name)
        .filter(Boolean)
        .join(', ');
      tooltip.style.display = 'block';
      tooltip.querySelector('.tip-name').textContent = node.label;
      tooltip.querySelector('.tip-desc').textContent = node.description || '';
      const meta = commLabel + ' \u00b7 ' + node.degree + ' connections' + (agents ? ' \u00b7 ' + agents : '');
      tooltip.querySelector('.tip-comm').textContent = meta;
      const rawPos = getRawMousePos(e);
      tooltip.style.left = Math.min(rawPos.x + 16, window.innerWidth - 340) + 'px';
      tooltip.style.top = (rawPos.y - 10) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (spaceHeld) {
      panning = true;
      const raw = getRawMousePos(e);
      panStartX = raw.x; panStartY = raw.y;
      panOriginX = panX; panOriginY = panY;
      canvas.style.cursor = 'grabbing';
      return;
    }
    const pos = getMousePos(e);
    const node = getNodeAt(pos.x, pos.y);
    if (node) { dragging = node; node.vx = 0; node.vy = 0; }
  });

  canvas.addEventListener('mouseup', () => {
    dragging = null;
    if (panning) { panning = false; canvas.style.cursor = spaceHeld ? 'grab' : 'default'; }
  });

  canvas.addEventListener('mouseleave', () => {
    dragging = null; panning = false; hovered = null; tooltip.style.display = 'none';
  });

  canvas.addEventListener('click', (e) => {
    const pos = getMousePos(e);

    const agent = getAgentAt(pos.x, pos.y);
    if (agent) {
      activeAgent = activeAgent === agent.id ? null : agent.id;
      return;
    }

    const node = getNodeAt(pos.x, pos.y);
    selected = node || null;
    if (!node) { detail.style.display = 'none'; return; }

    const commLabel = (DATA.communities.find(c => c.id === node.community) || {}).label || '';
    const neighbors = edges
      .filter(e => e.source === node.id || e.target === node.id)
      .map(e => e.source === node.id ? e.target : e.source)
      .map(id => nodes.find(n => n.id === id))
      .filter(Boolean);

    const neighborTags = neighbors
      .slice(0, 24)
      .map(n => '<span class="d-tag">' + esc(n.label) + '</span>')
      .join('');
    const moreCount = Math.max(0, neighbors.length - 24);

    const skillAgents = DATA.skillAgents[node.id] || [];
    const agentTags = skillAgents
      .map(aid => DATA.agents.find(a => a.id === aid))
      .filter(Boolean)
      .map(a => '<span class="d-tag" style="color:' + a.color + ';border:1px solid ' + a.color + '33;">' + esc(a.name) + '</span>')
      .join('');

    document.getElementById('detail-content').innerHTML =
      '<h3>' + esc(node.label) + '</h3>' +
      '<p>' + esc(node.description || 'No description') + '</p>' +
      '<div class="d-label">Community</div>' +
      '<div class="d-tags"><span class="d-tag" style="color:' + node.color + ';">' + esc(commLabel) + '</span></div>' +
      (agentTags
        ? '<div class="d-label">Agents</div><div class="d-tags">' + agentTags + '</div>'
        : '') +
      '<div class="d-label">Connections (' + neighbors.length + ')</div>' +
      '<div class="d-tags">' + (neighborTags || '<span style="color:#555;">None</span>') +
        (moreCount > 0 ? '<span class="d-tag" style="color:#555;">+' + moreCount + ' more</span>' : '') +
      '</div>' +
      (node.sourceFile ? '<div class="d-source">' + esc(node.sourceFile) + '</div>' : '');
    detail.style.display = 'block';
  });

  document.getElementById('detail-close').addEventListener('click', () => {
    detail.style.display = 'none';
    selected = null;
  });

  // Build legend
  function buildLegend() {
    const rows = document.getElementById('legend-rows');
    rows.innerHTML = '';
    DATA.communities.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML =
        '<span class="legend-swatch" style="background:' + c.color + ';"></span>' +
        '<span>' + esc(c.label) + '</span>' +
        '<span class="legend-count">' + c.size + '</span>';
      row.addEventListener('click', () => {
        if (dimmedCommunities.has(c.id)) {
          dimmedCommunities.delete(c.id);
          row.classList.remove('dim');
        } else {
          dimmedCommunities.add(c.id);
          row.classList.add('dim');
        }
      });
      rows.appendChild(row);
    });
  }

  function buildStats() {
    document.getElementById('stats').innerHTML =
      '<span>' + DATA.nodes.length + '</span> skills \u00b7 ' +
      '<span>' + DATA.links.length + '</span> edges \u00b7 ' +
      '<span>' + DATA.communities.length + '</span> communities \u00b7 ' +
      '<span>' + DATA.agents.length + '</span> agents';
  }

  function applySearch(query) {
    searchQuery = (query || '').trim().toLowerCase();
    const stats = document.getElementById('search-stats');
    if (!searchQuery) {
      searchMatchIds = null;
      stats.textContent = '';
      return;
    }
    searchMatchIds = new Set();
    DATA.nodes.forEach(n => {
      const hay = (n.label + ' ' + (n.description || '')).toLowerCase();
      if (hay.indexOf(searchQuery) !== -1) searchMatchIds.add(n.id);
    });
    stats.textContent = searchMatchIds.size + ' match' + (searchMatchIds.size === 1 ? '' : 'es');
  }

  document.getElementById('search').addEventListener('input', (e) => {
    applySearch(e.target.value);
  });
  document.getElementById('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; applySearch(''); }
  });

  document.getElementById('toggle-agents').addEventListener('click', (e) => {
    agentLayerOn = !agentLayerOn;
    e.target.classList.toggle('active', agentLayerOn);
    if (!agentLayerOn) activeAgent = null;
  });

  window.addEventListener('resize', () => { resize(); layoutAgents(); });

  resize();
  buildGraph();
  layoutAgents();
  buildLegend();
  buildStats();
  startAnim();
})();
</script>
</body>
</html>
"""


def main():
    payload = build_payload()
    payload_json = json.dumps(payload, separators=(",", ":"))
    html = HTML_TEMPLATE.replace("__DATA_PAYLOAD__", payload_json)

    # Escape for TS template literal
    ts_escaped = (
        html.replace("\\", "\\\\")
        .replace("`", "\\`")
        .replace("${", "\\${")
    )

    out_path = PLUGIN_DIR / "src" / "ui" / "graph-html.ts"
    out_path.write_text(
        "// Auto-generated by scripts/build-graph-html.py\n"
        "// Source: graphify-out/skills_graph.json\n"
        "// Renderer: adapted from RUBRIC Skill Trees (MIT-with-attribution)\n"
        "/* eslint-disable */\n"
        f"export const GRAPH_HTML = `{ts_escaped}`;\n"
    )

    print(f"Wrote {out_path}")
    print(f"  nodes: {len(payload['nodes'])}")
    print(f"  links: {len(payload['links'])}")
    print(f"  communities: {len(payload['communities'])}")
    print(f"  html size: {len(html):,} bytes")
    print(f"  ts size:   {out_path.stat().st_size:,} bytes")


if __name__ == "__main__":
    sys.exit(main() or 0)

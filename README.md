# compass

> A Claude Code plugin that keeps an architectural map of your MERN codebase next to the code itself.
> TypeScript. Slim. Zero API keys.

**See the architecture of your codebase before you review the diff.**

`compass` parses your JavaScript/TypeScript project, builds an import graph, asks Claude to group the graph into named components (in two passes — propose then critique), and writes Mermaid diagrams plus per-component Markdown into `.compass/`. On every re-run it does the smallest amount of work possible — only the components touched by your last commit get re-analyzed.

The shorthand: **Parse → Cluster → Propose → Critique → Render.** Re-runs are git-diff-driven, so the map stays cheap to keep in sync.

---

## The failure mode this exists to prevent

AI agents now write code faster than humans can read it. The pull-request diff shows *what* changed; it never shows *where in the system* it landed. Reviewers approve plausible-looking diffs against an architecture they can no longer hold in their head, and the second-order consequences — a leaky boundary here, a duplicate concept there, a circular dependency back — surface in production weeks later.

`compass` makes the architecture visible, machine-rendered, and cheap to keep current.

---

## Requirements

- **Claude Code** installed (`claude` on your PATH)
- **Node.js ≥ 20**
- A JavaScript or TypeScript project (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)

No `ANTHROPIC_API_KEY` needed — `compass` reuses your existing Claude Code session.

---

## Installation

```bash
claude plugin marketplace add AshokNaik009/compass
claude plugin install compass@compass
```

Or clone and install locally for development:

```bash
git clone https://github.com/AshokNaik009/compass
cd compass
npm install
```

---

## Quick start

Open Claude Code in your project root and run:

```
/compass-scan
```

That's it. Claude walks your repo, builds the import graph, groups files into named components, and writes the results to `.compass/`.

### First run output

```
.compass/
├── overview.md           ← top-level Mermaid diagram of all components
├── APILayer.md           ← per-component pages (one per component)
├── DomainServices.md
├── Repositories.md
├── analysis.json         ← machine-readable graph + components
└── state.json            ← manifest, hashes, phase tracking
```

Open `overview.md` to see your architecture as a Mermaid diagram. Each component page zooms in on that component's files, symbols, and edges.

---

## Commands

### `/compass-scan [--depth N]`

Full analysis from scratch. Walks the repo, parses all files with tree-sitter, builds the import graph, runs seeded Louvain pre-clustering, then calls Claude twice (propose + critique) to name and refine the components.

```
/compass-scan            # depth=1 (top-level only)
/compass-scan --depth 2  # also generates sub-diagrams inside each component
/compass-scan --force    # overwrite an existing analysis
```

**When to use:** first time on a repo, or after large structural changes where `/compass-refresh` would be too lossy.

**Cost:** 2 LLM calls at depth=1. At depth=2, adds 2 calls per component. The script prints an estimate and asks you to confirm before making any calls.

---

### `/compass-refresh`

Incremental update — re-analyzes only what changed since the last run. Much cheaper than a full scan.

```
/compass-refresh
```

`compass` classifies changes automatically:

| Change type | Path taken |
|---|---|
| Files edited within their existing component | **SAFE** — one LLM call (critique only) |
| New files, deleted files, or imports crossing component lines | **UNSAFE** — re-clusters and runs full propose+critique |
| Nothing changed | Prints "up to date" and exits |

**When to use:** after every commit, or before a code review. Keep it in your workflow like `git status`.

> **Auto-refresh via hook** — compass ships a `PostToolUse` hook that fires automatically whenever Claude Code runs a `git commit` via the Bash tool. The map stays current with zero discipline required. See [Auto-refresh hook](#auto-refresh-hook) below.

---

### `/compass-expand <component-id>`

Drill into a single component and generate a sub-diagram showing its internal structure.

```
/compass-expand C2
```

Find component IDs in `overview.md` or by running `/compass-status`. Costs 2 LLM calls.

---

### `/compass-status`

Read-only drift report — compares the current working tree against the last analysis. No LLM calls, instant.

```
/compass-status
```

Output example:

```
[compass] last run: 2026-05-12T10:30:00Z depth=1 phase=done
[compass] components: 5
changed: src/services/user.ts (component=C2)
STALE: 1 component affected by 1 changed file
suggestion: run /compass-refresh
```

---

### `/compass-recover`

Resume an interrupted scan or refresh from where it left off. No work is repeated.

```
/compass-recover
```

**When to use:** if a scan was interrupted mid-run (network blip, timeout, Ctrl-C). `compass` tracks which phase it was in and resumes from there.

---

### `/compass-help`

Print a summary of all commands.

```
/compass-help
```

---

## Auto-refresh hook

compass ships a `PostToolUse` Claude Code hook (`hooks/hooks.json`) that fires automatically after every `git commit` run via the Bash tool inside Claude Code.

**What it does:**

1. Reads the bash command from Claude Code's hook payload
2. Ignores anything that isn't a `git commit`
3. Skips silently if `.compass/state.json` doesn't exist (repo not yet scanned)
4. Classifies the diff as SAFE or UNSAFE (same logic as `/compass-refresh`)
5. Runs only the minimum work needed — one critique call for SAFE, full re-cluster for UNSAFE

**What this means for diagram rot:**

The map updates itself. No `/compass-refresh` command, no post-commit git hook to configure, no CI job to wire up. Every commit Claude Code makes keeps `.compass/overview.md` current automatically.

**Limitation:** the hook only fires for `git commit` commands run *through Claude Code's Bash tool*. Manual terminal commits outside Claude Code won't trigger it — run `/compass-refresh` manually for those.

---

## Keeping the map in sync

The recommended workflow:

```
# Once per repo
/compass-scan

# After each meaningful commit
/compass-refresh

# Before a design discussion or PR review
# open .compass/overview.md
```

Commit `.compass/` to git. Diagrams are text (Markdown + Mermaid), so diffs are readable and reviews catch architectural drift.

---

## Ignoring files

Create a `.compassignore` at your project root (same syntax as `.gitignore`):

```
node_modules/
dist/
*.test.ts
*.spec.ts
generated/
```

`.compassignore` is layered on top of `.gitignore`. Use `!pattern` to re-include something that `.gitignore` excludes:

```
vendor/
!vendor/my-local-package/   # keep this one
```

---

## What lives on disk

```
.compass/
├── analysis.json           # full graph + components (machine-readable)
├── state.json              # file manifest, hashes, phase, token costs
├── overview.md             # top-level Mermaid diagram
└── <ComponentName>.md      # one page per component
.compassignore              # at project root, alongside .gitignore
```

`analysis.json` is designed to be read by Claude. You can tell Claude Code to consult it before making edits:

> "Read `.compass/analysis.json` first, then make your changes."

---

## How it works

1. **Walk** — respects `.gitignore` + `.compassignore`, hashes every file for incremental tracking.
2. **Parse** — tree-sitter extracts imports, exports, and top-level declarations from every `.ts/.tsx/.js/.jsx` file.
3. **Resolve** — import specifiers are resolved to absolute paths (handles tsconfig paths, `.js`→`.ts` remapping, monorepos).
4. **Build graph** — files are nodes; imports are directed edges weighted by how many imported symbols are actually used.
5. **Pre-cluster** — seeded Louvain community detection groups tightly-connected files (reproducible across runs).
6. **Propose** — `claude -p` call 1: "here are the clusters and edges — propose names, descriptions, and any regroupings."
7. **Critique** — `claude -p` call 2: "here is your proposal — revise shallow names, merge sparse clusters, strengthen rationale."
8. **Render** — writes `overview.md` + one Markdown page per component, each with an embedded Mermaid diagram.

On re-runs, only the changed files are re-parsed and only the affected components go through the LLM passes.

---

## What ships in v1

| # | Feature |
|---|---|
| 1 | Full analysis (walk → parse → cluster → propose → critique → render) |
| 2 | Mermaid diagrams (`graph LR`) in every page |
| 3 | Incremental refresh via git diff |
| 4 | `.compassignore` with re-include support |
| 5 | Two-pass LLM grouping (propose + critique) |
| 6 | Depth levels (`--depth 2` for sub-diagrams) |

Everything else from upstream [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) is deliberately cut for v1. Full list in [SPEC §2.1](./SPEC.md#21-explicitly-out-of-scope-for-v1).

---

## Inspired by

[CodeBoarding/CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (Python). `compass` is a deliberately-slim TypeScript port focused on the load-bearing features for JavaScript/TypeScript codebases running inside Claude Code.

---

## License

MIT. See [LICENSE](./LICENSE).

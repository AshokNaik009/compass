# compass

> A Claude Code plugin that keeps an architectural map of your MERN codebase next to the code itself.
> TypeScript. Slim. Zero API keys.

**See the architecture of your codebase before you review the diff.**

`compass` parses your JavaScript/TypeScript project, builds an import-and-call graph, asks Claude to group the graph into named components, and writes Mermaid diagrams plus per-component Markdown into `.compass/`. On every re-run it does the smallest amount of work possible — only the components touched by your last commit get re-analyzed.

The shorthand: **Parse → Cluster → Name → Render.** Re-runs are git-diff-driven, so the map stays cheap to keep in sync.

---

## Status

**Draft 0** — the [SPEC](./SPEC.md) is the contract. Implementation has not started. Read SPEC.md first; everything else flows from it.

## The failure mode this exists to prevent

AI agents now write code faster than humans can read it. The pull-request diff shows *what* changed; it never shows *where in the system* it landed. Reviewers approve plausible-looking diffs against an architecture they can no longer hold in their head, and the second-order consequences — a leaky boundary here, a duplicate concept there, a circular dependency back — surface in production weeks later.

`compass` makes the architecture visible, machine-rendered, and cheap to keep current.

## What ships in v1 (six features)

1. **Full analysis** — walk the repo, parse with tree-sitter, build the call/import graph, group into components, render.
2. **Mermaid diagrams** — every overview + component page emits a `graph LR` block ready to paste into PRs/docs.
3. **Incremental analysis** — on re-run, only re-analyze files changed since the last run (git diff vs. cached manifest).
4. **`.compassignore`** — gitignore-style exclude file at the repo root.
5. **Cluster grouping (LLM)** — pre-cluster the call graph by co-call frequency, then a single `claude -p` call names and groups the clusters into components.
6. **Depth levels** — `--depth N` recursively expands each top-level component into its own sub-diagram.

Everything else from upstream [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) is **deliberately cut** for v1 (full list in [SPEC §2.1](./SPEC.md#21-explicitly-out-of-scope-for-v1)).

## What lives on disk

```
.compass/
├── analysis.json           # graph + components (output of the pipeline)
├── state.json              # manifest, file hashes, last-run metadata
├── overview.md             # top-level diagram
└── <ComponentName>.md      # one page per component, with its zoomed-in graph
.compassignore              # at project root, alongside .gitignore
```

## Commands

| Command | What it does |
|---|---|
| `/compass-scan [--depth N]` | Full analysis from scratch. |
| `/compass-refresh` | Incremental update via git diff. |
| `/compass-expand <component-id>` | Drill one component deeper. |
| `/compass-status` | Manifest vs. working-tree drift report. |
| `/compass-help` | Print the available commands. |

## Inspired by

[CodeBoarding/CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (Python). `compass` is a deliberately-slim TypeScript port focused on the load-bearing features for JavaScript/TypeScript codebases. The full out-of-scope list lives in [SPEC §2.1](./SPEC.md#21-explicitly-out-of-scope-for-v1).

## License

MIT. See [LICENSE](./LICENSE).

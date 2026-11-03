# Slidev Studio implementation plan

## 1. Product and scope

Create a standalone VS Code extension that makes Markdown-driven presentations
manageable like PowerPoint, without turning Slidev into a different format.

Primary workflow: choose a deck, browse rendered thumbnails, select a slide,
edit its Markdown alongside a live preview, reorder slides, and present/export.
Markdown stays the source of truth. No proprietary deck format or cloud service.

M0 through M5 have working initial implementations, including a read-only source
graph, trusted-workspace preview, local slide editing, notes, exports, layouts,
and asset insertion. Reference-workspace and remote validation, broader
Extension Host/UI tests, performance baselines, and release decisions remain
open; this plan tracks both shipped functionality and its acceptance gates.

### Why standalone?

The official `antfu.slidev` extension already provides slide navigation, preview,
and reordering. Validate its current functionality before duplicating internals.
Studio's differentiator is a cohesive presentation-first storyboard with robust
multi-deck and shared-slide workflows. Use namespaced commands/settings; avoid
taking over Markdown editors or depending on undocumented commands from it.

### Repository requirements observed

The reference presentation workspace has:

- Multiple entry decks named `slides*.md` and an index deck linking to them.
- Shared imports through `src:`, including workspace-root-relative paths.
- Environment placeholders such as `%SLIDEV_SPEAKER%`.
- A custom `setup/preparser.ts` that transforms source and speaker notes.
- Custom themes/addons, Vue components, global layers, assets, and styles.
- `_note:` references in addition to inline Markdown comments.

Therefore splitting source on every `---`, rendering plain Markdown as a
thumbnail, or flattening imports would not faithfully support these decks.

## 2. UX

Activity bar: **Slidev Studio**

```text
+-------------------------+-----------------------+----------------------+
| Deck selector           | Markdown editor       | Live slide preview   |
| Search / new slide      |                       |                      |
| 01 [rendered thumbnail]  | Source of selection   | Current theme, Vue,  |
| 02 [rendered thumbnail]  |                       | assets, and clicks   |
| 03 [shared badge]        |                       |                      |
| ...                     |                       |                      |
+-------------------------+-----------------------+----------------------+
| Storyboard grid (optional editor tab) | Notes for selected slide      |
+--------------------------------------+--------------------------------+
```

- Narrow sidebar uses a vertical filmstrip; wider editor tab supports a grid.
- Single click selects and navigates to source. Preview follows selection.
- Context menu: insert, duplicate, delete, move, reveal source, edit notes.
- Move Up/Move Down buttons, drag insertion markers, and keyboard shortcuts
  provide equivalent reordering actions.
- Shared/imported slides show source and usage badges, not misleading local copies.
- Toolbar exposes start/stop preview, present, export, and layout/asset actions.
- VS Code theme tokens, visible focus, screen-reader labels, reduced-motion support.
- No disabled pretend controls: unavailable features have explicit status text.

## 3. Architecture

### Extension host

TypeScript, stable VS Code API, workspace extension so processes run near files
(including Remote SSH/WSL, subject to later verification).

Responsibilities:

1. Discover deck entrypoints, maintain deck registry and selected deck.
2. Own the source/import graph and map rendered positions to editable source.
3. Apply version-checked edits through `WorkspaceEdit`, never file overwrites.
4. Start and stop only extension-owned Slidev/rendering processes.
5. Manage preview sessions, thumbnail cache, diagnostics, and cancellation.
6. Validate every webview message against a typed protocol and current state.

### Webviews

Sidebar filmstrip plus optional storyboard and preview editor panels.
Start with plain TypeScript/DOM; add a framework only if UI complexity justifies
it. Never put filesystem or process control in the webview.

Use CSP, nonces, minimal local resource roots, escaped/text-only metadata, and
extension-generated opaque deck/slide identifiers. Resolve identifiers against
the current model; never accept arbitrary file paths or commands from messages.

### Slidev adapter: required technical spike

Use the workspace-installed Slidev version as the rendering authority. Investigate
its parser/source mapping and supported preview/export APIs before committing to
an internal integration. Version-gate any non-public API behind a small adapter.
Do not silently substitute a simplified parser for unsupported syntax.

The source model needs two layers:

- **Authoring blocks:** exact source ranges, raw bytes, headmatter, frontmatter,
  notes, import references, document version, and owning URI.
- **Rendered occurrences:** deck position, click state, resolved source URI,
  authoring-block identity, effective frontmatter, and import-chain provenance.

One imported block can expand to several rendered slides; one source slide can
appear in several decks. Preserve both identities. Never use slide index alone
as a stable source-edit identifier.

Custom preparsers may synthesize or replace content without reversible mappings.
Such occurrences must be read-only for structural edits with a clear explanation.
An explicitly labeled source outline may instead navigate and edit original
Markdown authoring blocks using verified raw-source locations. It must not claim
rendered occurrence identities, synchronize selection with preview, or attach
rendered thumbnails to unverified source indexes.
Running preprocessors or themes requires workspace trust.

### Rendering and thumbnails

First spike: compare a managed Slidev dev server plus browser capture against the
workspace CLI's PNG export. Select based on fidelity, latency, API stability, and
support for deck imports/preparsers, not screenshot appearance alone.

Recommended direction: one selected-deck dev session plus a bounded screenshot
worker. Keep sessions on loopback; let the OS allocate ports, verify readiness,
and use VS Code external-URI mapping for remote previews.

Capture Slidev's actual output, not Markdown approximations. Wait for slide
readiness, fonts, assets, and supported async content; use a documented click
state (initial state by default). Surface missing themes/assets and timeouts.
Do not launch a browser per thumbnail.

Cache under extension workspace storage. Key by deck, source/import dependency
versions, theme/config/assets/preparser inputs, viewport, rendering version, and
click state. Invalidate conservatively when dependency tracking is uncertain.
Virtualize the list and prioritize visible thumbnails. Never embed hundreds of
live iframes. Show stale/loading/error states explicitly.

## 4. Editing semantics and safety decisions

### Reorder

- Keep deck headmatter anchored. The cover stays fixed in the initial release.
- Move local authoring blocks with their own frontmatter and notes as one unit.
- Imported groups move as import references, preserving overrides and selectors.
- Do not let a rendered child slide be dragged out of an imported group initially.
- Reject stale drags if document versions changed since the gesture began.
- One user action equals one undoable edit; preserve EOLs, whitespace, and comments.
- Multi-selection and cross-deck moves are later enhancements.

### Add / duplicate / delete

- Insert with explicit layout and valid delimiters using source-aware operations.
- Duplicate local blocks exactly; duplicate imports as references, with a warning
  that content remains shared. "Make local copy" is a separate later operation.
- Delete an import occurrence without deleting its source file.
- Confirm destructive actions and explain shared-source consequences.
- Do not support partial mutation of unresolved or generated slides.

### Notes

- Support Slidev's final-comment notes convention without changing other comments.
- For `_note`, resolve the effective workspace/preparser rules first.
- Show whether notes are inline or external; explain when edits affect other decks.
- Never evaluate arbitrary environment scripts to resolve a placeholder.
- Unresolved variables and inaccessible external notes are actionable errors.

### Layouts and assets

- Read available layouts from the active installed theme/addons, not a global list.
- Provide validated frontmatter changes, with previews where available.
- Browse workspace assets; write relative or Slidev-public paths correctly.
- Do not move assets, install themes, or fetch remote content implicitly.

## 5. Milestones and acceptance criteria

### M0 - Project foundation (this scaffold)

- Sidebar, commands, strict TypeScript build, local launch configuration.
- Discover configured filenames with YAML headmatter; switch and open deck source.
- Multi-root paths, persisted selection, errors and empty state.
- Metadata/protocol unit tests and a two-deck sample workspace.
- No source mutation, Slidev execution, fake thumbnails, or automatic installs.

### M1 - Compatibility and source graph

- Spike real Slidev parsing/rendering on the sample and reference workspace.
- Establish a tested Slidev version range rather than assuming universal support.
- Resolve imports, root-relative paths, selectors, shared occurrences, cycles,
  missing files, placeholders, and custom preparser limitations.
- Click-to-source maps every supported occurrence correctly.
- Display unsupported constructs with a diagnostic and read-only state.
- Test frontmatter fences versus separators inside code fences and comments.

Exit gate: all supported parsed occurrences map to the correct source; exact
source round-trips are byte-for-byte unchanged before editing is enabled.

**Implementation status:** the parser/source-map adapter is implemented for
Slidev 52.14.2 and 53.0.0, using the parser package pinned to each supported CLI
version. It resolves imports and selectors, records rendered-occurrence
provenance and original line locations, diagnoses missing/circular imports and
unresolved placeholders. Custom preparsers activate a labeled source outline:
original-source navigation and local edits remain available without running
workspace code, while thumbnails and per-slide preview synchronization are
disabled. Unsupported Slidev versions still disable navigation and editing. The included sample
fixtures are covered by parser-backed tests. Exact compatibility is gated to
the two exact versions above; the reference workspace and its private
dependencies were not available during this pass. Rendering comparisons and
any source mutation remain out of scope until the M2 and M3 gates.

### M2 - True rendered filmstrip and live preview

- Trusted-workspace managed session with start/stop/retry and explicit errors.
- Real thumbnails with themes, Vue components, imports, fonts, and assets.
- Selection synchronizes source and preview; optional follow-cursor mode.
- Visible-first thumbnail queue, cancellation, cache invalidation, and virtualization.
- Clean up owned processes after stop, failure, deck switch, and deactivation.

Provisional benchmark: on a documented Windows reference machine, a cached
100-slide filmstrip becomes interactive within 1 second; a selection updates
within 200 ms excluding uncached rendering. Record cold-render timings separately.
Choose final render budgets after the spike, not by promise.

**Implementation status:** the extension starts the workspace-local Slidev
52.14.2 or 53.0.0 CLI only after workspace trust and an explicit Start Preview
action. It allocates
a loopback port, waits for readiness, maps the server URL with `asExternalUri`,
embeds the live presentation, and stops its owned processes when preview stops,
the selected deck changes, the view closes, or the extension deactivates.

Thumbnail export now follows the filmstrip viewport: it requests bounded ranges
of up to 12 slides using Slidev's `--range`, prioritizes the latest requested
window, cancels stale exports, and caches images by slide number in extension
workspace storage. The sidebar renders only visible rows plus a small overscan
window and supports arrow, Home, and End navigation. Cache entries are
fingerprinted and invalidated on workspace file changes. CLI errors, missing
CLI/browser, and timeouts are surfaced without automatic installation.

The sidebar places a collapsible preview above a thumbnail-first filmstrip,
with a compact outline view and title/path/number search. Slide selection no
longer opens an editor; source navigation is explicit. Selected-slide Source
and Notes actions live in a compact editing dock, with less-used operations
and provenance in More. Reordering is disabled while filtering; thumbnail
requests use original deck indexes and skip cached images. Native disclosures
keep help, deck details, and diagnostics out of the primary workflow. Webview
state retains scroll, search, view mode, preview visibility, and disclosures.

The reference workspace and private theme/preparser could not be exercised here.
Browser/remote-host validation and the provisional 100-slide timing gate remain
open before M2 can be considered complete.

### M3 - Undo-safe slide organization

- Drag/drop and keyboard moves, add/duplicate/delete, layout templates.
- Provide single-pointer Move Up/Move Down controls as an alternative to dragging.
- Import groups remain intact; cover/headmatter protected.
- Document-version checks prevent overwriting concurrent edits.
- One undo restores every mutation, including dirty unsaved documents.
- No accidental source-file deletion or changes to another deck.

Exit gate: golden-file tests cover LF/CRLF, frontmatter, fences, comments, notes,
shared imports, consecutive imports, selectors, and first/last positions.

**Implementation status:** local slide reordering, add/duplicate/delete, and
layout frontmatter selection are implemented. The layout picker reads Vue
components from the active installed theme and workspace `layouts/` and
`setup/layouts/` folders; edits are version-checked, undoable, and preserve
existing layout comments and LF/CRLF line endings. Focus a local slide to add
after it, duplicate it, or delete it
(after confirmation); use Move up/Move down, Alt+Up/Down, or drag it within its
contiguous local group. Drag targets are validated
again in the extension host, and moves use the pinned Slidev parser's source
boundaries, keep the cover fixed and import blocks intact, reject stale source
identities, and apply one `WorkspaceEdit` for a single undo step. LF/CRLF,
frontmatter, and note preservation are covered by golden-style unit tests.
Top-level imported groups can be moved as complete source blocks with buttons,
drag/drop, or keyboard commands, duplicated as shared references, and removed
from the current deck after confirmation. The shared Markdown remains untouched.
Extension Host tests verify dirty-buffer `WorkspaceEdit` and one-step Undo
semantics for local and imported-reference duplicate transforms, but do not
drive the sidebar handlers or version checks. Golden-style tests cover
first/final source positions, selectors, nested/consecutive imports,
frontmatter, comments, fenced separators, notes, shared references, and LF/CRLF.

### M4 - Notes and presentation workflow

- Inline notes and supported external `_note` files, with shared-source warnings.
- Start presentation/presenter view in browser.
- Export PDF/PNG/PPTX only where the workspace Slidev version supports it.
- Progress, cancellation, output path selection, and actionable missing-tool errors.
- Invoke local CLI using argument arrays/tasks, never interpolated shell commands.
- Never run `npx` in a way that silently downloads missing code.

**Implementation status:** the trusted-workspace sidebar and commands can open
Slidev's `/presenter` route in the browser. The workspace-local CLI can export
PDF, PNG, and PPTX through argument-array process spawning, VS Code's output-path
picker, notification progress, cancellation, and explicit CLI failure reporting.
These actions require a supported Slidev version (52.14.2 or 53.0.0);
dependencies and browsers are never installed automatically. Inline notes can
be opened or initialized at the end of a local
slide. A literal `_note` path is resolved from the workspace root, rejected if it
contains unresolved placeholders or escapes the workspace (including through a
symlink), and opened only after a shared-source warning. Custom preprocessors are
never executed by discovery or source editing. With a custom preparser, original
Markdown is available in source-outline mode without claiming rendered mapping.
Explicit trusted-workspace preview/export still runs Slidev and its preparser.
Remote output validation and manual browser smoke tests remain open.

### M5 - Layout and asset tools; release hardening

- Installed-theme layout picker, asset browser/insertion, optional storyboard grid.
- Keyboard, screen-reader, high-contrast, zoom, and reduced-motion checks.
- Windows/macOS/Linux validation; remote and multi-root verification.
- VSIX packaging, license/publisher/repository decisions, Marketplace metadata,
  integration CI, compatibility matrix, and documented limitations.

**Implementation status:** the layout picker uses the active installed theme and
workspace layout directories, and an image picker lists up to 500 workspace
images and inserts a Markdown image reference without copying the asset. Images
in the workspace root `public/` folder use Slidev public URLs; other images use
paths relative to the selected deck, with URL-encoded path segments. Symlinks
resolving outside the workspace are rejected. Broader asset types,
accessibility/platform review, and remaining release hardening are open. A
GitHub Actions workflow runs typecheck, unit tests, and VSIX packaging on
Windows, macOS, and Linux. The sidebar has keyboard focus indicators, live
status regions, labeled slide controls, single-pointer Move up/Move down
alternatives to dragging, and forced-colors indicators, but still needs manual
screen-reader, zoom, and high-contrast checks.

### Later, not release blockers

Cross-deck copy/move with dependency handling, multi-select, section grouping,
search/filter, reusable templates, editable theme controls, and collaboration.
Do not add AI generation, a visual freeform canvas, or cloud accounts to v1.

## 6. Verification strategy

- Unit: discovery metadata, message guards, URI/import resolution, source model.
- Golden files: exact structural editing outputs and undo behavior.
- VS Code integration: actual workspace edits, dirty/versioned docs, commands,
  persistence, multi-root, trust restrictions, and webview lifecycle. A focused
  host test currently covers dirty-buffer edits and Undo behavior.
- Browser/UI: selection, scroll virtualization, drag/drop, pointer and keyboard ordering,
  loading/error recovery, and absence of unsafe DOM injection.
- Rendering: real Slidev fixture decks covering themes, Vue, scoped CSS, code,
  Mermaid, imports, notes, click animations, and preprocessing.
- Process lifecycle: occupied ports, startup failure, missing packages, cancellation,
  editor reload, extension shutdown, and export errors.
- CI: typecheck, unit tests, and VSIX packaging on Windows, macOS, and Linux.
- Regression: read-only discovery against the existing presentation workspace,
  without committing changes or copying private assets/credentials into this project.

## 7. Risks and open decisions

| Risk | Mitigation / decision gate |
|------|----------------------------|
| Overlap with the official extension | Compare real workflows at M1; focus on the storyboard and shared-slide UX |
| Private or incompatible themes | Render through workspace dependencies; never embed their code |
| Slidev internal APIs change | Isolate/version-gate adapter and maintain compatibility fixtures |
| Preparser breaks source mapping | Explicit read-only fallback for affected occurrences, never guessed edits |
| Shared-source edits affect many decks | Provenance, usage warnings, reference-level operations first |
| Thumbnail cost on large decks | Bounded worker, cache, cancellation, visible-first scheduling |
| Workspace code execution | Trust gate and user-initiated rendering; no automatic dependency install |
| Embedded preview CSP/remote constraints | Verify in spike; external browser fallback with an explicit explanation |

Public preview preparation uses publisher `emanuelebartolesi`, the MIT license,
and `kasuken/vscode-slidev-studio`. Version-matched Slidev support remains limited
to 52.14.2 and 53.0.0. CI packages on Windows, macOS, and Linux; remote-host and
broader manual accessibility checks remain open. See [publishing](PUBLISHING.md)
for the credential-gated release workflow. Preparing a VSIX does not publish it.

## 8. References

- [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [Slidev VS Code extension](https://sli.dev/features/vscode-extension)
- [Slidev syntax](https://sli.dev/guide/syntax)
- [Slidev importing slides](https://sli.dev/guide/syntax#importing-slides)
- [Slidev exporting](https://sli.dev/guide/exporting)

# Changelog

## 0.0.2 - 2026-11-03

Initial public preview.

### Added

- Multi-deck discovery, switching, and workspace-local selection persistence.
- Theme-aware sidebar with live preview, virtualized thumbnails, outline view,
  slide search, and keyboard navigation.
- Version-matched source mapping for Slidev 52.14.2 and 53.0.0, including shared
  imports, selectors, provenance, and diagnostics.
- Undoable local slide insertion, duplication, deletion, and reordering;
  imported groups can be moved, duplicated as references, or removed safely.
- Presenter notes, installed-theme/workspace layout selection, and image insertion.
- Trusted-workspace preview, presenter mode, and cancellable PDF/PNG/PPTX exports
  through the workspace-local Slidev CLI.
- Source-outline fallback for custom preparsers and read-only unsupported versions.
- Marketplace metadata, MIT license, screenshot, and validated release packaging.
- Cross-platform CI and opt-in Marketplace publishing through tagged releases.

### Known limitations

- Only Slidev CLI 52.14.2 and 53.0.0 are supported for version-matched rendering.
- Custom preparsers disable rendered thumbnails and source-to-preview synchronization.
- Remote-host, screen-reader, zoom, and broad theme compatibility checks remain open.

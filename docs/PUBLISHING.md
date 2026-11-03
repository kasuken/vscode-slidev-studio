# Publishing Slidev Studio

Marketplace identity: **`emanuelebartolesi.vscode-slidev-studio`**.
The publisher follows the existing Copilot Insights extension.

## Validate and package

```powershell
npm ci
npm run check
npm test
npm run test:host
npm run package
```

The VSIX includes compiled runtime code, required parser dependencies, webview
assets, a PNG Marketplace icon, README, changelog, screenshot, and MIT license.
Tests, fixtures, demo dependencies, and development files are excluded.

Inspect its contents with `npx --no-install vsce ls` before distribution.
Install through **Extensions: Install from VSIX...** and smoke-test deck
discovery, source navigation, trusted preview, thumbnails, notes, edits/Undo,
presenter mode, and exports. Check light/dark/high-contrast themes and keyboard
navigation. Remote-host and broad screen-reader/zoom checks remain open.

## Configure Marketplace credentials

1. Confirm access to the `emanuelebartolesi` publisher in
   [Marketplace publisher management](https://marketplace.visualstudio.com/manage).
2. Create an Azure DevOps personal access token with **Marketplace: Manage**
   scope following the
   [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
3. Add it to this repository's Actions secrets as **`VSCE_PAT`**.
   Never put the token in a file, commit, or command argument.

No credential is included, and creating the repository does not publish the
extension. Existing secrets from another repository are not automatically shared.

## Release

Update `package.json`, synchronize `package-lock.json`, and add a dated changelog
entry. Commit and push the version before creating its matching tag:

```powershell
git tag -a v0.0.2 -m "Slidev Studio 0.0.2"
git push origin v0.0.2
```

Tag pushes run checks, unit and Extension Host tests, package the VSIX, publish it
to the Marketplace, and create a GitHub release with the VSIX attached.
The workflow rejects mismatched tags and missing publishing credentials.

For a packaging-only dry run, manually run **Release** in GitHub Actions and
leave **Publish to the Visual Studio Marketplace** unchecked. This uploads the
VSIX as a workflow artifact without publishing or creating a release/tag.

For a manual Marketplace release, run it on the intended version's commit with
the publish option checked. Manual runs do not create a GitHub release or tag.
A version already published to Marketplace cannot be published again; bump the
version for subsequent releases.

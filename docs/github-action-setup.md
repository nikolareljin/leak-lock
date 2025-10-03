# GitHub Action Setup for Extension Publishing

## Overview
This repository includes automated GitHub Actions to build and publish extensions for three IDEs:

- VS Code (Marketplace) — existing `publish.yml`
- Visual Studio (VSIX to Visual Studio Marketplace) — `publish-ides.yml`
- IntelliJ Platform (JetBrains Marketplace) — `publish-ides.yml`

## Setup Required

### 1. VS Code Marketplace Access Token
You need to create a Personal Access Token (PAT) for publishing to the VS Code Marketplace:

1. Go to [Visual Studio Marketplace Publisher Management](https://marketplace.visualstudio.com/manage)
2. Sign in with your Microsoft account
3. Create or select your publisher
4. Go to "Personal Access Tokens" 
5. Create a new token with:
   - **Organization**: All accessible organizations
   - **Scopes**: Marketplace (Publish)
   - **Expiration**: Set appropriate expiration date
6. Copy the generated token

### 2. Configure GitHub Repository Secret
Add the token as a repository secret:

1. Go to your GitHub repository settings
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `VSCE_PAT`
5. Value: Paste your VS Code Marketplace token
6. Click **Add secret**

---

### 3. Visual Studio Marketplace (VSIX) Token + Publisher

Publishing the Visual Studio extension (VSIX) requires a token and publisher ID for the Visual Studio Marketplace.

1. Create a Personal Access Token from Visual Studio Marketplace Publisher portal (with publish permissions)
2. Add these repository secrets:
   - `VS_MARKETPLACE_TOKEN` — your Visual Studio Marketplace PAT
   - `VS_PUBLISHER` — your Publisher ID (short name, not display name)

The workflow builds the VSIX with MSBuild on `windows-latest` and publishes using `VsixPublisher.exe`.

---

### 4. JetBrains Marketplace Token (IntelliJ)

To publish the IntelliJ plugin to JetBrains Marketplace:
1. Generate a JetBrains Marketplace token
2. Add these repository secrets:
   - `JETBRAINS_TOKEN` — publishing token
   - `JETBRAINS_CHANNEL` — optional channel name (defaults to `default`)

The workflow uses the Gradle IntelliJ Plugin `publishPlugin` task with the token and channel.

### 3. Publisher Configuration
Ensure your `package.json` includes the publisher field:

```json
{
  "publisher": "your-publisher-name",
  "name": "leak-lock",
  "version": "0.0.1"
  // ... other fields
}
```

Replace `your-publisher-name` with your actual VS Code Marketplace publisher ID.

## Workflow Features

### Automatic Publishing
- **Trigger**: Pushes to `main` branch
- **Testing**: Runs tests and linting before publishing
- **Version Management**: Auto-bumps version if current version already exists
- **Git Tags**: Creates version tags automatically
- **GitHub Releases**: Creates detailed release notes
- **Artifacts**: Uploads .vsix package for manual distribution

For Visual Studio and IntelliJ:
- Builds VSIX on Windows; uploads artifact and publishes if secrets are configured
- Builds IntelliJ distribution ZIP on Ubuntu; uploads artifact and publishes if secrets are configured

### Tags and Releases
- A single shared tag `v<version>` is used across all platforms (derived from `package.json`)
- Each workflow attaches its platform artifacts to the same GitHub Release for `v<version>`:
  - VS Code `.vsix` (from `publish.yml`)
  - Visual Studio `.vsix` (from `publish-ides.yml`)
  - IntelliJ distribution `.zip` (from `publish-ides.yml`)

### Centralized Release Notes
- Release notes are maintained in `.github/release-notes-template.md`
- All publish jobs reference the same template via `body_path`
- To update release text, edit the template once; all platforms will use the new content

### Version Handling
The workflow intelligently handles versioning:
- If the current version in `package.json` already exists as a git tag, it auto-bumps the patch version
- Creates git tags for version tracking
- Generates GitHub releases with changelog

### Testing Pipeline
Before publishing, the workflow:
- Installs dependencies with `npm ci`
- Runs `npm test` (ensure your tests pass)
- Runs `npm run lint` (continues even if linting has issues)

## Manual Publishing
If you need to publish manually or test the package:

```bash
# Install VSCE globally
npm install -g @vscode/vsce

# Package the extension
vsce package

# Publish to marketplace (requires PAT)
vsce publish --pat YOUR_PAT_TOKEN
```

## File Structure
```
.github/
└── workflows/
    ├── publish.yml           # VS Code publishing workflow
    └── publish-ides.yml      # Visual Studio + IntelliJ publishing
```

## Troubleshooting

### Common Issues
1. **Missing VSCE_PAT secret**: Ensure the secret is properly configured in repository settings
2. **Publisher not found**: Verify the publisher name in `package.json` matches your VS Code marketplace publisher
3. **VSIX publisher mismatch**: Ensure `VS_PUBLISHER` matches your Visual Studio Marketplace publisher ID
4. **JetBrains token missing**: Add `JETBRAINS_TOKEN` to enable IntelliJ publishing
3. **Version already exists**: The workflow handles this automatically by bumping the version
4. **Test failures**: Fix failing tests before merging to main

### Testing the Workflow
You can test the workflow by:
1. Creating a pull request to `main`
2. The test job will run on PR creation
3. Publishing only happens on merge to `main`

## Security Notes
- Keep tokens (`VSCE_PAT`, `VS_MARKETPLACE_TOKEN`, `JETBRAINS_TOKEN`) secure
- Workflows run on pushes to `main`; publishing steps execute only if corresponding secrets are present
- VS Code job runs tests before publishing; fix failures prior to merge

## Next Steps
1. Configure the VSCE_PAT secret in your repository
2. Update the publisher field in package.json
3. Merge your changes to main to trigger the first automated publish

The extension will now be automatically published whenever you merge updates to the main branch!

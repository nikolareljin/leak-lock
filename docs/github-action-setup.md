# GitHub Action Setup for Extension Publishing

## Overview
The extension now includes an automated GitHub Action workflow that will automatically publish the VS Code extension to the marketplace when code is merged to the `main` branch.

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

### 2. Open VSX Registry Access Token
You need a token from Open VSX to publish there:

1. Go to [Open VSX User Settings](https://open-vsx.org/user-settings/tokens)
2. Create a new token
3. Copy the generated token

### 3. Configure GitHub Repository Secrets
Add the tokens as repository secrets:

1. Go to your GitHub repository settings
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `VSCE_PAT`
5. Value: Paste your VS Code Marketplace token
6. Click **Add secret**
7. Repeat for Open VSX:
   - Name: `OVSX_PAT`
   - Value: Paste your Open VSX token

### 4. Publisher Configuration
Ensure your `package.json` includes the publisher field:

```json
{
  "publisher": "your-publisher-name",
  "name": "leak-lock",
  "version": "0.0.1"
  // ... other fields
}
```

Replace `your-publisher-name` with your actual VS Code Marketplace publisher ID (must match your Open VSX namespace).

## Workflow Features

### Automatic Publishing
- **Trigger**: Pushes to `main` branch
- **Testing**: Runs tests and linting before publishing
- **Version Management**: Auto-bumps version if current version already exists
- **Git Tags**: Creates version tags automatically
- **GitHub Releases**: Creates detailed release notes
- **Artifacts**: Uploads .vsix package for manual distribution

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
    └── publish.yml    # Main publishing workflow
```

## Troubleshooting

### Common Issues
1. **Missing VSCE_PAT secret**: Ensure the secret is properly configured in repository settings
2. **Publisher not found**: Verify the publisher name in `package.json` matches your marketplace publisher
3. **Version already exists**: The workflow handles this automatically by bumping the version
4. **Test failures**: Fix failing tests before merging to main

### Testing the Workflow
You can test the workflow by:
1. Creating a pull request to `main`
2. The test job will run on PR creation
3. Publishing only happens on merge to `main`

## Security Notes
- The VSCE_PAT token has publish permissions - keep it secure
- The workflow only runs on the main branch to prevent accidental publishing
- All tests must pass before publishing occurs

## Next Steps
1. Configure the VSCE_PAT secret in your repository
2. Update the publisher field in package.json
3. Merge your changes to main to trigger the first automated publish

The extension will now be automatically published whenever you merge updates to the main branch!

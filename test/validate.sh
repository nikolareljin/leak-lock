#!/bin/bash

# Simple validation script for the updated scan functionality
echo "🛡️  Testing Leak Lock Scan Functionality"
echo "========================================"

# Test 1: Check if required files exist
echo "📋 Checking core files..."
if [ -f "extension.js" ] && [ -f "leakLockSidebarProvider.js" ]; then
    echo "✅ Core extension files exist"
else
    echo "❌ Missing core extension files"
    exit 1
fi

# Test 2: Check Node.js syntax
echo "🔍 Checking syntax..."
if node -c extension.js && node -c leakLockSidebarProvider.js; then
    echo "✅ JavaScript syntax is valid"
else
    echo "❌ JavaScript syntax errors found"
    exit 1
fi

# Test 3: Install npm dependencies
echo "📦 Installing npm dependencies..."
if [ -f "package.json" ]; then
    if npm install; then
        echo "✅ npm dependencies installed"
    else
        echo "❌ npm install failed"
        exit 1
    fi
else
    echo "❌ package.json not found"
    exit 1
fi

# Test 4: Check if Docker is available
echo "🐳 Checking Docker availability..."
if docker --version > /dev/null 2>&1; then
    echo "✅ Docker is installed"
    if docker info > /dev/null 2>&1; then
        echo "✅ Docker daemon is running"
    else
        echo "⚠️  Docker daemon is not running"
    fi
else
    echo "❌ Docker is not installed"
fi

# Test 5: Test Docker image availability
echo "🔍 Checking TruffleHog Docker image..."
if docker image inspect trufflesecurity/trufflehog:latest > /dev/null 2>&1; then
    echo "✅ TruffleHog image is available locally"
else
    echo "⚠️  TruffleHog image not found locally"
    echo "🔄 Attempting to pull image..."
    if timeout 30 docker pull trufflesecurity/trufflehog:latest > /dev/null 2>&1; then
        echo "✅ Successfully pulled TruffleHog image"
    else
        echo "⚠️  Could not pull image (network/timeout issue)"
    fi
fi

# Test 6: Run TruffleHog scan and capture exact JSON output
echo "🧪 Testing scan functionality and capturing JSON output..."
if [ -f "test/test-secrets.js" ]; then
    echo "✅ Test file with secrets exists"

    # Create a simple test directory structure
    rm -rf test-scan-dir
    mkdir -p test-scan-dir
    cp test/test-secrets.js test-scan-dir/

    echo "🔍 Running TruffleHog scan (JSON output)..."
    output_file="test/trufflehog-test-output.jsonl"
    if docker run --rm -v "$(pwd)/test-scan-dir:/scan" trufflesecurity/trufflehog:latest filesystem /scan --json | tee "$output_file"; then
        echo "✅ TruffleHog scan complete. JSON output saved to $output_file"
    else
        echo "❌ TruffleHog scan failed"
        rm -rf test-scan-dir
        exit 1
    fi

    # Cleanup
    rm -rf test-scan-dir
else
    echo "⚠️  Test secrets file not found"
fi

# Test 7: Check package.json structure
echo "📦 Checking package.json..."
if [ -f "package.json" ]; then
    if grep -q '"leak-lock.scanRepository"' package.json; then
        echo "✅ Scan Repository command is registered"
    else
        echo "⚠️  Scan Repository command not found in package.json"
    fi
    
    if grep -q '"vscode"' package.json; then
        echo "✅ VS Code engine dependency found"
    else
        echo "❌ VS Code engine dependency missing"
    fi
else
    echo "❌ package.json not found"
fi

echo ""
echo "🎉 Basic validation complete!"
echo "The extension should be ready for testing in VS Code."
echo ""
echo "💡 To test in VS Code:"
echo "1. Press F5 to launch Extension Development Host"
echo "2. Open a folder with potential secrets"
echo "3. Look for the Leak Lock icon in the activity bar" 
echo "4. Click 'Scan Repository' to test the functionality"

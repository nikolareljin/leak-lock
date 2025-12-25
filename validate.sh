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
echo "🔍 Checking Nosey Parker Docker image..."
if docker image inspect ghcr.io/praetorian-inc/noseyparker:latest > /dev/null 2>&1; then
    echo "✅ Nosey Parker image is available locally"
else
    echo "⚠️  Nosey Parker image not found locally"
    echo "🔄 Attempting to pull image..."
    if timeout 30 docker pull ghcr.io/praetorian-inc/noseyparker:latest > /dev/null 2>&1; then
        echo "✅ Successfully pulled Nosey Parker image"
    else
        echo "⚠️  Could not pull image (network/timeout issue)"
    fi
fi

# Test 6: Test the scan functionality with a simple test
echo "🧪 Testing scan functionality..."
if [ -f "test-secrets.js" ]; then
    echo "✅ Test file with secrets exists"
    
    # Create a simple test directory structure
    mkdir -p test-scan-dir
    cp test-secrets.js test-scan-dir/
    
    echo "🔍 Running basic Nosey Parker scan..."
    # Test if we can run the scan command (without full execution)
    if docker run --rm -v "$(pwd)/test-scan-dir:/scan" ghcr.io/praetorian-inc/noseyparker:latest --help > /dev/null 2>&1; then
        echo "✅ Nosey Parker Docker command works"
    else
        echo "⚠️  Nosey Parker Docker command failed"
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

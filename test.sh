#!/bin/bash

# Test script for leak-lock VS Code extension
# This script tests the extension functionality and dependencies

set -e  # Exit on any error

echo "🛡️  Starting Leak Lock Extension Tests..."
echo "========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Function to print test results
print_test_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ PASS:${NC} $2"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}❌ FAIL:${NC} $2"
        ((TESTS_FAILED++))
    fi
}

# Function to print section headers
print_section() {
    echo -e "\n${BLUE}📋 $1${NC}"
    echo "----------------------------------------"
}

# Test 1: Check if Node.js is installed
print_section "Testing Prerequisites"

if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_test_result 0 "Node.js is installed (version: $NODE_VERSION)"
else
    print_test_result 1 "Node.js is not installed"
fi

# Test 2: Check if npm is installed
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    print_test_result 0 "npm is installed (version: $NPM_VERSION)"
else
    print_test_result 1 "npm is not installed"
fi

# Test 3: Check if Docker is installed
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    print_test_result 0 "Docker is installed ($DOCKER_VERSION)"
    
    # Test if Docker daemon is running
    if docker info &> /dev/null; then
        print_test_result 0 "Docker daemon is running"
    else
        print_test_result 1 "Docker daemon is not running"
    fi
else
    print_test_result 1 "Docker is not installed"
fi

# Test 4: Check package.json structure
print_section "Testing Package Configuration"

if [ -f "package.json" ]; then
    print_test_result 0 "package.json exists"
    
    # Check required fields
    if grep -q '"name": "leak-lock"' package.json; then
        print_test_result 0 "Package name is correct"
    else
        print_test_result 1 "Package name is incorrect"
    fi
    
    if grep -q '"main": "./extension.js"' package.json; then
        print_test_result 0 "Main entry point is correct"
    else
        print_test_result 1 "Main entry point is incorrect"
    fi
    
    # Check VS Code engine
    if grep -q '"vscode"' package.json; then
        print_test_result 0 "VS Code engine dependency found"
    else
        print_test_result 1 "VS Code engine dependency missing"
    fi
    
    # Check commands
    if grep -q '"leak-lock.helloWorld"' package.json; then
        print_test_result 0 "Hello World command registered"
    else
        print_test_result 1 "Hello World command not registered"
    fi
    
    if grep -q '"leak-lock.scanRepository"' package.json; then
        print_test_result 0 "Scan Repository command registered"
    else
        print_test_result 1 "Scan Repository command not registered"
    fi
    
else
    print_test_result 1 "package.json does not exist"
fi

# Test 5: Check extension files
print_section "Testing Extension Files"

if [ -f "extension.js" ]; then
    print_test_result 0 "extension.js exists"
    
    # Check for required functions
    if grep -q "function activate" extension.js; then
        print_test_result 0 "activate function found"
    else
        print_test_result 1 "activate function not found"
    fi
    
    if grep -q "function deactivate" extension.js; then
        print_test_result 0 "deactivate function found"
    else
        print_test_result 1 "deactivate function not found"
    fi
    
    # Check for Docker image reference
    if grep -q "ghcr.io/praetorian-inc/noseyparker" extension.js; then
        print_test_result 0 "Nosey Parker Docker image reference found"
    else
        print_test_result 1 "Nosey Parker Docker image reference not found"
    fi
    
else
    print_test_result 1 "extension.js does not exist"
fi

if [ -f "sidebarProvider.js" ]; then
    print_test_result 0 "sidebarProvider.js exists"
else
    print_test_result 1 "sidebarProvider.js does not exist"
fi

if [ -f "file-scan.js" ]; then
    print_test_result 0 "file-scan.js exists"
else
    print_test_result 1 "file-scan.js does not exist"
fi

if [ -f "project-scan.js" ]; then
    print_test_result 0 "project-scan.js exists"
else
    print_test_result 1 "project-scan.js does not exist"
fi

# Test 6: Check media files
print_section "Testing Media Assets"

if [ -d "media" ]; then
    print_test_result 0 "media directory exists"
    
    if [ -f "media/shield.svg" ]; then
        print_test_result 0 "shield.svg icon exists"
    else
        print_test_result 1 "shield.svg icon does not exist"
    fi
else
    print_test_result 1 "media directory does not exist"
fi

# Test 7: Install dependencies
print_section "Testing Dependency Installation"

if [ -f "package.json" ]; then
    echo -e "${YELLOW}Installing npm dependencies...${NC}"
    if npm install > /dev/null; then
        print_test_result 0 "npm dependencies installed successfully"
        
        # Check if node_modules exists
        if [ -d "node_modules" ]; then
            print_test_result 0 "node_modules directory created"
        else
            print_test_result 1 "node_modules directory not created"
        fi
    else
        print_test_result 1 "Failed to install npm dependencies"
    fi
fi

# Test 8: Check linting
print_section "Testing Code Quality"

if [ -f "eslint.config.mjs" ]; then
    print_test_result 0 "ESLint configuration file exists"
    
    echo -e "${YELLOW}Running ESLint...${NC}"
    if npm run lint &> /dev/null; then
        print_test_result 0 "Code passes linting"
    else
        print_test_result 1 "Code has linting errors"
        echo -e "${YELLOW}Running lint to show errors:${NC}"
        npm run lint || true
    fi
else
    print_test_result 1 "ESLint configuration file does not exist"
fi

# Test 9: Test VS Code extension packaging
print_section "Testing Extension Packaging"

if command -v vsce &> /dev/null; then
    echo -e "${YELLOW}Testing extension packaging...${NC}"
    if vsce package --no-dependencies &> /dev/null; then
        print_test_result 0 "Extension can be packaged successfully"
        # Clean up the generated .vsix file
        rm -f *.vsix
    else
        print_test_result 1 "Extension packaging failed"
    fi
else
    echo -e "${YELLOW}vsce not installed, skipping packaging test${NC}"
    echo -e "${YELLOW}Install with: npm install -g vsce${NC}"
fi

# Test 10: Test Docker functionality (if Docker is available)
print_section "Testing Docker Integration"

if command -v docker &> /dev/null && docker info &> /dev/null; then
    echo -e "${YELLOW}Testing Docker image availability...${NC}"
    
    # Check if Nosey Parker image exists locally or can be pulled
    if docker image inspect ghcr.io/praetorian-inc/noseyparker:latest &> /dev/null; then
        print_test_result 0 "Nosey Parker Docker image is available locally"
    else
        echo -e "${YELLOW}Attempting to pull Nosey Parker image...${NC}"
        if timeout 60 docker pull ghcr.io/praetorian-inc/noseyparker:latest &> /dev/null; then
            print_test_result 0 "Successfully pulled Nosey Parker Docker image"
        else
            print_test_result 1 "Failed to pull Nosey Parker Docker image (timeout or network issue)"
        fi
    fi
    
    # Test basic Docker functionality
    if docker run --rm hello-world &> /dev/null; then
        print_test_result 0 "Docker is working correctly"
    else
        print_test_result 1 "Docker basic functionality test failed"
    fi
else
    echo -e "${YELLOW}Docker not available, skipping Docker integration tests${NC}"
fi

# Test 11: Test file structure
print_section "Testing Project Structure"

REQUIRED_FILES=(
    "README.md"
    "LICENSE"
    "CHANGELOG.md"
    "extension.js"
    "package.json"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        print_test_result 0 "$file exists"
    else
        print_test_result 1 "$file is missing"
    fi
done

# Test 12: Run existing tests
print_section "Running Existing Test Suite"

if [ -f "test/extension.test.js" ]; then
    print_test_result 0 "Test file exists"
    
    echo -e "${YELLOW}Running VS Code extension tests...${NC}"
    if npm test &> /dev/null; then
        print_test_result 0 "All tests passed"
    else
        print_test_result 1 "Some tests failed"
        echo -e "${YELLOW}Test output:${NC}"
        npm test || true
    fi
else
    print_test_result 1 "Test file does not exist"
fi

# Final results
print_section "Test Summary"

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
echo -e "Total tests run: ${BLUE}$TOTAL_TESTS${NC}"
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "\n${GREEN}🎉 All tests passed! The extension is ready for use.${NC}"
    exit 0
else
    echo -e "\n${YELLOW}⚠️  Some tests failed. Please review the issues above.${NC}"
    exit 1
fi
#!/bin/bash
# CI Configuration Validation Test
# This script validates that the CI workflow is correctly configured

set -e

echo "=== CI Configuration Quality Assurance Test ==="
echo ""

FAILED=0

# Test 1: YAML Syntax
echo "Test 1: YAML Syntax Validation"
if python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null; then
    echo "  ✓ PASS: YAML syntax is valid"
else
    echo "  ✗ FAIL: YAML syntax error"
    FAILED=$((FAILED + 1))
fi
echo ""

# Test 2: Required jobs exist
echo "Test 2: Required CI Jobs"
for job in backend webui ci; do
    if grep -q "^  $job:" .github/workflows/ci.yml; then
        echo "  ✓ PASS: Job '$job' exists"
    else
        echo "  ✗ FAIL: Job '$job' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 3: Backend job steps
echo "Test 3: Backend Job Steps"
for step in "actions/checkout@v4" "actions/setup-python@v5" "pip install -r requirements-dev.txt" "python -m pytest" "codecov/codecov-action@v4" "pip-audit" "actions/upload-artifact@v4"; do
    if grep -q "$step" .github/workflows/ci.yml; then
        echo "  ✓ PASS: Backend step '$step' found"
    else
        echo "  ✗ FAIL: Backend step '$step' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 4: WebUI job steps
echo "Test 4: WebUI Job Steps"
for step in "actions/checkout@v4" "actions/setup-node@v4" "npm ci" "npm run typecheck" "npm run build" "npm run test" "npm run lint" "npm run gates" "npm run check:types" "npm audit" "actions/upload-artifact@v4"; do
    if grep -q "$step" .github/workflows/ci.yml; then
        echo "  ✓ PASS: WebUI step '$step' found"
    else
        echo "  ✗ FAIL: WebUI step '$step' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 5: Backend dependencies
echo "Test 5: Backend Dependencies"
for dep in pytest pytest-asyncio pytest-cov; do
    if grep -q "^$dep==" backend/requirements-dev.txt; then
        echo "  ✓ PASS: Backend dependency '$dep' available"
    else
        echo "  ✗ FAIL: Backend dependency '$dep' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 6: WebUI scripts exist
echo "Test 6: WebUI Scripts"
for script in gates.mjs check-types.mjs; do
    if [ -f "webui/scripts/$script" ]; then
        echo "  ✓ PASS: Script '$script' exists"
    else
        echo "  ✗ FAIL: Script '$script' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 7: Package.json scripts
echo "Test 7: Package.json Scripts"
for script in typecheck build test lint gates check:types; do
    if grep -q "\"$script\"" webui/package.json; then
        echo "  ✓ PASS: NPM script '$script' defined"
    else
        echo "  ✗ FAIL: NPM script '$script' missing"
        FAILED=$((FAILED + 1))
    fi
done
echo ""

# Test 8: Coverage flags
echo "Test 8: Coverage Configuration"
if grep -q "cov=app" .github/workflows/ci.yml && grep -q "cov-report=xml" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Backend coverage flags configured"
else
    echo "  ✗ FAIL: Backend coverage flags missing"
    FAILED=$((FAILED + 1))
fi

if grep -q "coverage" .github/workflows/ci.yml; then
    echo "  ✓ PASS: WebUI coverage configured"
else
    echo "  ✗ FAIL: WebUI coverage missing"
    FAILED=$((FAILED + 1))
fi
echo ""

# Test 9: Security scanning
echo "Test 9: Security Scanning"
if grep -q "pip-audit" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Backend security scan (pip-audit) configured"
else
    echo "  ✗ FAIL: Backend security scan missing"
    FAILED=$((FAILED + 1))
fi

if grep -q "npm audit" .github/workflows/ci.yml; then
    echo "  ✓ PASS: WebUI security scan (npm audit) configured"
else
    echo "  ✗ FAIL: WebUI security scan missing"
    FAILED=$((FAILED + 1))
fi
echo ""

# Test 10: Artifact uploads
echo "Test 10: Artifact Uploads"
if grep -q "actions/upload-artifact@v4" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Artifact uploads configured"
else
    echo "  ✗ FAIL: Artifact uploads missing"
    FAILED=$((FAILED + 1))
fi

if grep -q "retention-days: 30" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Artifact retention configured"
else
    echo "  ✗ FAIL: Artifact retention missing"
    FAILED=$((FAILED + 1))
fi
echo ""

# Test 11: Codecov integration
echo "Test 11: Codecov Integration"
if grep -q "codecov/codecov-action@v4" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Codecov integration configured"
else
    echo "  ✗ FAIL: Codecov integration missing"
    FAILED=$((FAILED + 1))
fi
echo ""

# Test 12: Non-blocking security scans
echo "Test 12: Non-blocking Security Scans"
if grep -q "continue-on-error: true" .github/workflows/ci.yml; then
    echo "  ✓ PASS: Security scans are non-blocking"
else
    echo "  ✗ FAIL: Security scans may block CI"
    FAILED=$((FAILED + 1))
fi
echo ""

# Summary
echo "=== Test Summary ==="
if [ $FAILED -eq 0 ]; then
    echo "✓ ALL TESTS PASSED ($FAILED failures)"
    echo ""
    echo "The CI configuration is correctly set up with:"
    echo "  • Backend: pytest with coverage, security scanning, artifact uploads"
    echo "  • WebUI: typecheck, build, tests, lint, design gates, type contract, security"
    echo "  • Quality gates: 10+ comprehensive checks"
    echo "  • Non-blocking security scans for visibility without blocking"
    exit 0
else
    echo "✗ TESTS FAILED ($FAILED failures)"
    echo ""
    echo "Please review the failures above and fix the CI configuration."
    exit 1
fi
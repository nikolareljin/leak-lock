import globals from "globals";

export default [{
    // Downloaded VS Code test fixtures and deps are not ours to lint. Without
    // this, `eslint .` after a test run scans thousands of vendored files.
    // test-secrets.js is scanner input, not code: it exists to hold plausible
    // credentials for the detectors to find, so its "unused" assignments are the
    // entire point of the file.
    ignores: ["node_modules/**", ".vscode-test/**", "dist/**", "out/**", "*.vsix", "test/test-secrets.js"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        // A parameter that exists only to document a callback signature imposed by
        // someone else - resolveWebviewView's context and token - is named with a
        // leading underscore rather than deleted, so the shape stays readable.
        "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}];
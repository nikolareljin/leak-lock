import globals from "globals";

export default [{
    // Downloaded VS Code test fixtures and deps are not ours to lint. Without
    // this, `eslint .` after a test run scans thousands of vendored files.
    ignores: ["node_modules/**", ".vscode-test/**", "dist/**", "out/**", "*.vsix"],
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
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}];
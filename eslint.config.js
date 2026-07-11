// @ts-check
import tseslint from "typescript-eslint"

export default tseslint.config(
  // Global ignores
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "**/coverage/**", "**/drizzle/**", "**/*.d.ts"],
  },

  // TypeScript files in all packages
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [...tseslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Code quality guards ---
      complexity: ["warn", 15],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      // 150 (not 80): Hono handlers + inline SQL queries naturally exceed 80.
      // The ceiling only catches genuinely large functions worth extracting.
      "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],

      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      // Allow _prefixed unused vars (destructuring rest, interface compliance)
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      // --- Drizzle ORM 0.x workarounds ---
      // Generics resolve as `any` in typescript-eslint (not in tsc).
      // Known bug: https://github.com/drizzle-team/drizzle-orm/issues/4432
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",

      // --- Practical relaxations ---
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      // Interface contracts may require async without await (e.g. WebhookAdapterPort.authenticate)
      "@typescript-eslint/require-await": "off",
    },
  },

  // TSX files (web) — quality guards without full type-checking (JSX inflates the
  // type-aware rules; the parser handles jsx from the .tsx extension automatically).
  {
    files: ["packages/*/src/**/*.tsx"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Test files — relax rules that conflict with test patterns
  {
    files: ["packages/*/src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
)

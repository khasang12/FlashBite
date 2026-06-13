/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "\\.e2e-spec\\.ts$",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@flashbite/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
    "^@flashbite/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@flashbite/tenant-context$":
      "<rootDir>/../../packages/tenant-context/src/index.ts",
  },
};

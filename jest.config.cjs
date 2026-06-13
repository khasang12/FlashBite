const { pathsToModuleNameMapper } = require("ts-jest");
const { existsSync } = require("fs");
const { join } = require("path");

const paths = {
  "@flashbite/contracts": ["packages/contracts/src/index.ts"],
  "@flashbite/shared": ["packages/shared/src/index.ts"],
  "@flashbite/tenant-context": ["packages/tenant-context/src/index.ts"],
};

const rootDir = __dirname;
const roots = ["<rootDir>/packages"];
if (existsSync(join(rootDir, "apps"))) {
  roots.push("<rootDir>/apps");
}

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  roots,
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: "<rootDir>/" }),
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          baseUrl: ".",
          paths,
        },
      },
    ],
  },
  testMatch: ["**/*.spec.ts", "**/*.e2e-spec.ts"],
  testTimeout: 20000,
};

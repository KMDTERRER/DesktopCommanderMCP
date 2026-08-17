import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMcpbPackageJson } = require('../scripts/mcpb-package-json.cjs');

const packageJson = {
    dependencies: { runtime: '^1.0.0', '@vscode/ripgrep': '^1.18.0' },
    optionalDependencies: { optional: '^2.0.0' },
    overrides: { runtime: { nested: '3.0.0' } },
    engines: { node: '>=24' },
    devDependencies: { buildOnly: '^4.0.0' },
};
const manifest = {
    name: 'bundle-test', version: '1.2.3', description: 'test',
    author: 'author', license: 'MIT', repository: 'repo',
};

const bundle = createMcpbPackageJson(packageJson, manifest);
assert.equal(bundle.dependencies.runtime, '^1.0.0');
assert.equal(bundle.dependencies['@vscode/ripgrep'], 'npm:@vscode/ripgrep-universal@^1.18.0');
assert.equal(packageJson.dependencies['@vscode/ripgrep'], '^1.18.0');
assert.deepEqual(bundle.optionalDependencies, packageJson.optionalDependencies);
assert.deepEqual(bundle.overrides, packageJson.overrides);
assert.deepEqual(bundle.engines, packageJson.engines);
assert.equal('devDependencies' in bundle, false);
assert.equal(bundle.main, 'dist/index.js');
assert.equal(bundle.type, 'module');
console.log('MCPB package metadata regression: PASS');

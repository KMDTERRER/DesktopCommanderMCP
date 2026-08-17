'use strict';

function createMcpbPackageJson(packageJson, manifest) {
    const dependencies = { ...packageJson.dependencies };
    const ripgrepRange = dependencies['@vscode/ripgrep'];
    if (ripgrepRange) {
        dependencies['@vscode/ripgrep'] = `npm:@vscode/ripgrep-universal@${ripgrepRange}`;
    }

    const bundlePackageJson = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        type: 'module',
        main: 'dist/index.js',
        author: manifest.author,
        license: manifest.license,
        repository: manifest.repository,
        dependencies,
    };

    for (const key of ['optionalDependencies', 'overrides', 'engines']) {
        if (packageJson[key] != null) {
            bundlePackageJson[key] = packageJson[key];
        }
    }

    return bundlePackageJson;
}

module.exports = { createMcpbPackageJson };

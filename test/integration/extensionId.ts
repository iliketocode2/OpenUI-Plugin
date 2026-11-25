import pkg from '../../package.json';

/** The extension's ID as VS Code knows it, so changing the publisher or name cannot silently break the suites. */
export const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

import { randomBytes } from 'node:crypto';

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    "connect-src 'none'",
    `img-src ${cspSource} data: blob:`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource}`,
    `font-src ${cspSource}`,
    "media-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function createNonce(): string {
  return randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

export function renderHtml(opts: { cspSource: string; scriptUri: string; styleUri: string; nonce: string }): string {
  const csp = contentSecurityPolicy(opts.cspSource, opts.nonce);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${opts.styleUri}">
<title>OWUI Agent</title>
</head>
<body>
<div id="root"></div>
<script nonce="${opts.nonce}" src="${opts.scriptUri}"></script>
</body>
</html>`;
}

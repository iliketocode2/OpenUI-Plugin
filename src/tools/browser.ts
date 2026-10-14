import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { truncateMiddle } from './shell/output';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types';

interface BrowserArgs {
  action: 'navigate' | 'screenshot' | 'read_text' | 'logs' | 'set_viewport' | 'set_color_scheme' | 'close';
  url?: string;
  full_page?: boolean;
  selector?: string;
  width?: number;
  height?: number;
  scheme?: 'light' | 'dark';
}

let shotSeq = 0;

async function screenshot(ctx: ToolContext, fullPage: boolean): Promise<ToolResult> {
  const shot = await ctx.browser().screenshot(fullPage);
  await mkdir(ctx.scratchpad, { recursive: true });
  const file = path.join(ctx.scratchpad, `screenshot-${Date.now()}-${++shotSeq}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`);
  await writeFile(file, shot.data);
  const base64 = shot.data.toString('base64');
  ctx.update({ image: `data:${shot.mime};base64,${base64}` });
  const where = `Saved to ${file} (${Math.round(shot.data.length / 1024)} KB).`;
  if (!ctx.modelVision) return ok(`${where} The selected model is not marked as vision-capable, so the image is not attached; describe what to check with read_text instead.`);
  return ok(`${where} The screenshot is attached to the next message.`, { images: [{ path: file, mime: shot.mime, base64 }] });
}

function withLogs(ctx: ToolContext, text: string): string {
  const logs = ctx.browser().drainLogs();
  return logs ? `${text}\n\n${truncateMiddle(logs, 6000).text}` : text;
}

export const browserTool: Tool<BrowserArgs> = {
  name: 'browser',
  category: 'read',
  description:
    'Headless browser for checking local web apps (localhost only). Actions: navigate (url), screenshot (full_page), read_text (rendered text after JavaScript, optional CSS selector), logs (console messages, uncaught errors, failed and blocked requests since the last call), set_viewport (width, height; e.g. 390x844 for mobile), set_color_scheme (light|dark), close. Start the dev server first with start_process.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['navigate', 'screenshot', 'read_text', 'logs', 'set_viewport', 'set_color_scheme', 'close'] },
      url: { type: 'string', description: 'For navigate: e.g. http://localhost:3000/' },
      full_page: { type: 'boolean' },
      selector: { type: 'string', description: 'For read_text: CSS selector; defaults to the whole page.' },
      width: { type: 'integer', minimum: 200, maximum: 4000 },
      height: { type: 'integer', minimum: 200, maximum: 4000 },
      scheme: { type: 'string', enum: ['light', 'dark'] },
    },
    required: ['action'],
  },
  title: (a) => (a.action === 'navigate' ? `Browser: open ${a.url ?? ''}` : `Browser: ${a.action.replace('_', ' ')}`),
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const b = ctx.browser();
        switch (args.action) {
          case 'navigate': {
            if (!args.url) return fail('navigate needs a url.');
            const r = await b.navigate(args.url);
            ctx.update({ title: `Browser: open ${r.url} — ${r.status ?? 'no status'}` });
            return ok(withLogs(ctx, `Loaded ${r.url} (HTTP ${r.status ?? 'unknown'}). Title: ${r.title || '(none)'}`));
          }
          case 'screenshot':
            return screenshot(ctx, !!args.full_page);
          case 'read_text': {
            const text = await b.text(args.selector);
            const t = truncateMiddle(text, 12_000);
            ctx.update({ output: t.text.slice(0, 4000) });
            return ok(withLogs(ctx, t.text || '(no visible text)'));
          }
          case 'logs': {
            const logs = b.drainLogs();
            ctx.update({ output: logs.slice(0, 4000) });
            return ok(logs || 'No console messages, errors or failed requests since the last check.');
          }
          case 'set_viewport':
            if (!args.width || !args.height) return fail('set_viewport needs width and height.');
            await b.setViewport(args.width, args.height);
            return ok(`Viewport set to ${args.width}x${args.height}. Take a screenshot to see the result.`);
          case 'set_color_scheme':
            if (!args.scheme) return fail('set_color_scheme needs scheme: light or dark.');
            await b.setColorScheme(args.scheme);
            return ok(`Colour scheme set to ${args.scheme}.`);
          case 'close':
            await b.close();
            return ok('Browser closed and its temporary profile deleted.');
        }
      },
    };
  },
};

interface InteractArgs {
  action: 'click' | 'type';
  selector: string;
  text?: string;
  submit?: boolean;
}

export const browserInteractTool: Tool<InteractArgs> = {
  name: 'browser_interact',
  category: 'command',
  description: 'Click an element or type into a field in the page opened with the browser tool (CSS selector, e.g. "#email", "button[type=submit]", "text=Sign in"). type replaces the field value; submit presses Enter afterwards.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'type'] },
      selector: { type: 'string' },
      text: { type: 'string' },
      submit: { type: 'boolean' },
    },
    required: ['action', 'selector'],
  },
  title: (a) => `Browser: ${a.action} ${a.selector}`,
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const b = ctx.browser();
        if (args.action === 'click') await b.click(args.selector);
        else {
          if (args.text === undefined) return fail('type needs text.');
          await b.type(args.selector, args.text, !!args.submit);
        }
        await new Promise((r) => setTimeout(r, 300));
        return ok(withLogs(ctx, `Done: ${args.action} ${args.selector}.`));
      },
    };
  },
};

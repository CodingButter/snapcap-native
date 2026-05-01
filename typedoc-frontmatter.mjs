// @ts-check
//
// Local typedoc-plugin-markdown plugin that adapts TypeDoc's output for
// Fumadocs. Two responsibilities:
//
//   1. Inject `title:` frontmatter into every generated page (Fumadocs'
//      MDX loader requires a string `title` per its `pageSchema` — without
//      it `next build` fails with "title: Invalid input".
//
//      Frontmatter SERIALIZATION is provided by `typedoc-plugin-frontmatter`
//      which must be loaded alongside this plugin. We just populate the
//      `page.frontmatter` object on `MarkdownPageEvent.BEGIN`.
//
//   2. Write Fumadocs `meta.json` files into the generated output dir
//      after rendering completes. TypeDoc clears its output dir on every
//      run (`cleanOutputDir: true` is the default), so meta.json files
//      committed to disk get wiped — they have to be regenerated alongside
//      the .mdx pages.
//
// The meta.json structure is hand-curated (logical ordering, not strict
// alpha) since neither TypeDoc nor the markdown plugin understands
// Fumadocs nav conventions.

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MarkdownPageEvent } from 'typedoc-plugin-markdown';

/**
 * Hand-curated Fumadocs meta.json layout. Order matters — top of each list
 * surfaces the most important members first. Items not present in the
 * generated output are silently skipped at write time.
 */
const META_LAYOUT = {
  '': {
    title: 'API Reference',
    defaultOpen: true,
    pages: ['index', 'classes', 'interfaces', 'functions', 'type-aliases', 'variables'],
  },
  classes: {
    title: 'Classes',
    pages: [
      'SnapcapClient',
      'Friends',
      'Messaging',
      'Inbox',
      'Stories',
      'Media',
      'Presence',
      'FileDataStore',
      'MemoryDataStore',
      'StorageShim',
      'CookieJarStore',
    ],
  },
  interfaces: {
    title: 'Interfaces',
    pages: [
      'ISnapcapClient',
      'IFriendsManager',
      'DataStore',
      'Friend',
      'FriendsUser',
      'FriendsSnapshot',
      'FriendRequest',
      'OutgoingRequest',
    ],
  },
  functions: {
    title: 'Functions',
    pages: [
      'setLogger',
      'createSharedThrottle',
      'activeIdentifier',
      'bytesToUuid',
      'uuidToBytes',
      'highLowToUuid',
      'uuidToHighLow',
      'idbGet',
      'idbPut',
      'idbDelete',
    ],
  },
  'type-aliases': {
    title: 'Type Aliases',
    pages: [
      'SnapcapClientOpts',
      'Credentials',
      'BrowserContext',
      'UserId',
      'FriendSource',
      'FriendLinkType',
      'Logger',
      'LogEvent',
      'ThrottleConfig',
      'ThrottleGate',
      'ThrottleRule',
    ],
  },
  variables: {
    title: 'Variables',
    pages: ['defaultTextLogger', 'FriendSource', 'RECOMMENDED_THROTTLE_RULES'],
  },
};

/**
 * @param {import('typedoc-plugin-markdown').MarkdownApplication} app
 */
export function load(app) {
  // 1. Frontmatter injection.
  app.renderer.on(
    MarkdownPageEvent.BEGIN,
    /** @param {import('typedoc-plugin-markdown').MarkdownPageEvent} page */
    (page) => {
      const title = page.model?.name ?? 'API Reference';
      page.frontmatter = {
        title,
        ...page.frontmatter,
      };
    },
  );

  // 2. Write Fumadocs meta.json files after rendering completes.
  app.renderer.postRenderAsyncJobs.push(async (renderer) => {
    const outDir = renderer.outputDirectory ?? app.options.getValue('out');
    if (!outDir) return;
    for (const [subdir, meta] of Object.entries(META_LAYOUT)) {
      const dir = subdir ? join(outDir, subdir) : outDir;
      // Skip subdirs TypeDoc didn't actually emit on this run (e.g. no
      // exported variables → no `variables/` directory).
      if (subdir && !existsSync(dir)) continue;
      const target = join(dir, 'meta.json');
      await writeFile(target, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
  });
}

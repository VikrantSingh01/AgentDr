import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Prefer npm's own CLI entry point over the `npm`/`npm.cmd` launcher so the
// child process needs no shell, which Node deprecates for unescaped-argument
// reasons. npm sets npm_execpath for anything it runs.
function npmCommand(): { command: string; prefix: string[]; shell: boolean } {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && execPath.endsWith('.js')) {
    return { command: process.execPath, prefix: [execPath], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

function packedFiles(): string[] {
  // --ignore-scripts keeps `prepack` from rebuilding dist/ underneath the tests
  // that execute it. The packed file list depends on what is on disk, not on
  // the build running, and `npm run check` builds before the suite starts.
  const npm = npmCommand();
  const output = execFileSync(
    npm.command,
    [...npm.prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: npm.shell,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0]?.files.map((file) => file.path) ?? [];
}

function ignoredByGit(paths: string[]): string[] {
  if (paths.length === 0) return [];
  try {
    const output = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: paths.join('\n'),
    });
    return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  } catch (error) {
    // git check-ignore exits 1 when nothing matches, which is the healthy case.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
}

describe('published package contents', () => {
  // Deliberately untracked working documents and locally generated measurement
  // output live beside the shipped files. The `files` allowlist in package.json
  // takes precedence over .gitignore, so a directory-level entry would publish
  // them. This asserts the invariant directly rather than trusting the
  // allowlist to stay correct.
  //
  // `dist/` is the one legitimate exception: it is gitignored because it is
  // build output, and published because it is what consumers run.
  it('never publishes a file that git is told to ignore', () => {
    const leaked = ignoredByGit(packedFiles()).filter((path) => !path.startsWith('dist/'));
    expect(leaked, `These files would be published despite being gitignored:\n${leaked.join('\n')}`)
      .toEqual([]);
  }, 120_000);

  it('publishes the documentation the README links to', () => {
    const packed = new Set(packedFiles());
    for (const document of [
      'docs/technical-reference.md',
      'docs/architecture-review.md',
      'docs/agentic-ai-developer-guide.md',
      'docs/pmf-validation.md',
    ]) {
      expect(packed.has(document), `${document} is linked from the README but would not ship`).toBe(
        true,
      );
    }
  }, 120_000);
});

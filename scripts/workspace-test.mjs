#!/usr/bin/env node
/**
 * Test the workspace directory resolver.
 *
 * MiniMax Code spawns plugin MCP servers with the *home* directory as their
 * working directory, so a relative path would land in the wrong place. These
 * tests pin the resolution order that fixes that.
 *
 *   node scripts/workspace-test.mjs
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveAgainst, resolveWorkspaceDir } from '../shared/workspace.mjs';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

const root = mkdtempSync(join(tmpdir(), 'mcode-workspace-test-'));
const workspace = join(root, 'project');
const other = join(root, 'other');
mkdirSync(workspace, { recursive: true });
mkdirSync(other, { recursive: true });

try {
  // 1. An explicit override wins over everything else.
  {
    const resolved = resolveWorkspaceDir({
      env: { MCODE_WORKSPACE: other, PWD: workspace },
      cwd: root,
    });
    check('MCODE_WORKSPACE wins over PWD', resolved === other, resolved);
  }

  // 2. PWD is used when there is no explicit override.
  {
    const resolved = resolveWorkspaceDir({ env: { PWD: workspace }, cwd: root });
    check('PWD is the fallback', resolved === workspace, resolved);
  }

  // 3. A PWD that is not a directory is ignored.
  {
    const resolved = resolveWorkspaceDir({
      env: { PWD: join(root, 'does-not-exist') },
      cwd: workspace,
    });
    check('a non-existent PWD is ignored', resolved === workspace, resolved);
  }

  // 4. A PWD pointing at a file is ignored.
  {
    const file = join(root, 'a-file');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'x');
    const resolved = resolveWorkspaceDir({ env: { PWD: file }, cwd: workspace });
    check('a PWD that is a file is ignored', resolved === workspace, resolved);
  }

  // 5. With nothing usable, the working directory is the answer.
  {
    const resolved = resolveWorkspaceDir({ env: {}, cwd: workspace });
    check('falls back to cwd', resolved === workspace, resolved);
  }

  // 6. A relative path resolves against the base directory.
  {
    const resolved = resolveAgainst('assets/hero.png', workspace);
    check(
      'a relative path resolves against the base',
      resolved === join(workspace, 'assets/hero.png'),
      resolved,
    );
  }

  // 7. An absolute path is left alone.
  {
    const absolute = join(workspace, 'assets/hero.png');
    const resolved = resolveAgainst(absolute, other);
    check('an absolute path ignores the base', resolved === absolute, resolved);
  }

  // 8. A relative path with a base that is itself relative still lands somewhere sane.
  {
    const resolved = resolveAgainst('hero.png', 'project');
    check(
      'a relative base is resolved too',
      resolved === resolve('project/hero.png'),
      resolved,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);

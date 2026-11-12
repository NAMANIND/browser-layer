import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim()

// A build is a packed and installed copy of the ref, kept per commit so arms and later runs share it.
export function build(ref) {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim()
  const root = join(tmpdir(), 'bl-bench', 'builds', sha)
  if (!existsSync(join(root, 'prefix/bin/browser-layer'))) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    execFileSync('sh', ['-c', `git -C '${repo}' archive ${sha} | tar -x -C '${join(root, 'src')}'`])
    symlinkSync(join(repo, 'node_modules'), join(root, 'src/node_modules'))
    const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', root], { cwd: join(root, 'src'), encoding: 'utf8' }).trim().split('\n').pop()
    execFileSync('npm', ['install', '-g', '--silent', '--prefix', join(root, 'prefix'), join(root, tgz)])
  }
  return { sha, root }
}


import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Append all stdout/stderr to this file. */
  logFile?: string;
  /** Bus to emit log chunks for SSE. Event name: 'log'. */
  emitter?: EventEmitter;
  /** Optional label prefixed onto emitted log events. */
  label?: string;
  /** Force shell mode (needed for .cmd/.bat on Windows). */
  shell?: boolean;
}

export interface RunResult {
  exitCode: number;
  ok: boolean;
  /** Captured combined stdout+stderr (also written to logFile if set). */
  output: string;
}

/** Spawn a child process; tee output to log file + emitter; resolve when done. */
export function runProcess(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const { cmd, args, cwd, env, logFile, emitter, label, shell } = opts;
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `\n$ ${cmd} ${args.join(' ')}\n  (cwd=${cwd || process.cwd()})\n`);
    }
    let buf = '';
    // On Windows, .cmd/.bat shims require shell:true.
    const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      shell: shell || isWindowsShim,
      windowsHide: true,
    });
    const onChunk = (chunk: Buffer) => {
      const txt = chunk.toString('utf-8');
      buf += txt;
      if (logFile) fs.appendFileSync(logFile, txt);
      if (emitter) emitter.emit('log', { label, text: txt });
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      const txt = `\n[spawn error] ${err.message}\n`;
      if (logFile) fs.appendFileSync(logFile, txt);
      if (emitter) emitter.emit('log', { label, text: txt });
      resolve({ exitCode: -1, ok: false, output: buf + txt });
    });
    child.on('close', (code) => {
      const exitCode = code ?? 0;
      const tail = `\n[exit ${exitCode}]\n`;
      if (logFile) fs.appendFileSync(logFile, tail);
      if (emitter) emitter.emit('log', { label, text: tail });
      resolve({ exitCode, ok: exitCode === 0, output: buf });
    });
  });
}

/** Parse a "py -3" style invocation into [cmd, ...prefixArgs]. */
export function splitInvocation(invocation: string): [string, string[]] {
  const parts = invocation.split(' ').filter(Boolean);
  return [parts[0], parts.slice(1)];
}

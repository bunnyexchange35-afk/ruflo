/**
 * Shared helpers for the MUDREXX deployment pipeline scripts.
 *
 * Every script in this directory reports ONLY what it actually observed.
 * There is no path through this code that marks a stage PASS without a
 * matching observation, and no stage is ever "assumed" to have succeeded.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Stage outcomes. NOT_AUTOMATED is a first-class, honest result — not a pass. */
export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const NOT_AUTOMATED = 'NOT_AUTOMATED';
export const SKIPPED = 'SKIPPED';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

/**
 * Reads a JSONC file (wrangler.jsonc uses `//` comments).
 * Strips line/block comments outside of string literals only.
 */
export function readJsonc(path) {
  const raw = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Tolerate trailing commas.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

/** A single observation inside a stage. */
export function check(name, ok, detail = '') {
  return { name, status: ok ? PASS : FAIL, detail: String(detail) };
}

export function checkStatus(name, status, detail = '') {
  return { name, status, detail: String(detail) };
}

export class StageReport {
  constructor(stage, title) {
    this.stage = stage;
    this.title = title ?? stage;
    this.checks = [];
    this.startedAt = new Date().toISOString();
  }

  add(entry) {
    this.checks.push(entry);
    const icon =
      entry.status === PASS
        ? 'PASS'
        : entry.status === FAIL
          ? 'FAIL'
          : entry.status === NOT_AUTOMATED
            ? 'NOT AUTOMATED'
            : 'SKIPPED';
    console.log(`  [${icon}] ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
    return entry;
  }

  ok(name, condition, detail) {
    return this.add(check(name, condition, detail));
  }

  note(name, status, detail) {
    return this.add(checkStatus(name, status, detail));
  }

  /**
   * Stage status:
   *   FAIL           if any check failed
   *   NOT_AUTOMATED  if nothing failed but the stage could not be automated
   *   SKIPPED        if there is nothing to report at all
   *   PASS           only when at least one check ran and none failed
   */
  get status() {
    if (this.checks.some((c) => c.status === FAIL)) return FAIL;
    if (this.checks.some((c) => c.status === PASS)) {
      return this.checks.some((c) => c.status === NOT_AUTOMATED) ? NOT_AUTOMATED : PASS;
    }
    if (this.checks.some((c) => c.status === NOT_AUTOMATED)) return NOT_AUTOMATED;
    return SKIPPED;
  }

  toJSON() {
    return {
      stage: this.stage,
      title: this.title,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      checks: this.checks,
    };
  }

  /** Writes the stage result WITHOUT exiting. Use when a script emits several stages. */
  save(out) {
    const payload = this.toJSON();
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    }
    console.log(`\n${this.title}: ${payload.status}`);
    return payload;
  }

  /**
   * Terminal: writes the stage result and ENDS the process.
   * Exit 1 on FAIL so CI stops the pipeline; exit 0 otherwise.
   */
  finish({ out, failOnNotAutomated = false } = {}) {
    const payload = this.save(out);
    if (payload.status === FAIL) process.exit(1);
    if (failOnNotAutomated && payload.status === NOT_AUTOMATED) process.exit(1);
    process.exit(0);
  }
}

export function loadStages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Appends markdown to the GitHub Actions job summary when running in CI. */
export function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    /* the runner already created it */
  }
  writeFileSync(file, markdown, { flag: 'a' });
}

/** fetch with a timeout and retries — used for post-deploy propagation delay. */
export async function fetchWithRetry(url, options = {}, { retries = 5, delayMs = 4000, timeoutMs = 15000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // 5xx right after a deploy is usually propagation; retry those.
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(delayMs);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError ?? new Error('request failed');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a response body as JSON without throwing. */
export async function readJsonBody(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/**
 * Redacts anything that looks like a credential before it can reach a log.
 * Applied to every detail string the smoke tests emit (§10: never log keys).
 */
export function redact(value) {
  let s = String(value ?? '');
  const patterns = [
    /sk-[A-Za-z0-9_-]{12,}/g,
    /sk-ant-[A-Za-z0-9_-]{12,}/g,
    /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
    /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,}/g,
    /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
  ];
  for (const p of patterns) s = s.replace(p, '[REDACTED]');
  return s;
}

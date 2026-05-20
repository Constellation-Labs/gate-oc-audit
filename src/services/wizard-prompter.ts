import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

import type {
  WizardMultiSelectParams,
  WizardPrompter,
  WizardSelectParams,
  WizardProgress,
} from "openclaw/plugin-sdk/setup";

// `setup` doesn't re-export the param types for text/confirm, so derive
// them from the WizardPrompter method signatures to stay in sync with
// the SDK.
type WizardTextParams = Parameters<WizardPrompter["text"]>[0];
type WizardConfirmParams = Parameters<WizardPrompter["confirm"]>[0];

/**
 * Minimal readline-backed `WizardPrompter`. The openclaw SDK's wizard
 * flows (notably `loginOpenAICodexOAuth`) expect this contract; the
 * SDK ships its own polished implementation for the main `openclaw`
 * binary but doesn't expose it for third-party plugins.
 *
 * This implementation is deliberately bare: line-based prompts, no
 * terminal repainting, no cancel-key handling beyond Ctrl-C (which
 * propagates as a `WizardCancelledError` from the caller). It's
 * enough to drive `audit gate provider add openai --oauth` end-to-end.
 *
 * Out of scope: a TUI version of `select` / `multiselect`. The OpenAI
 * Codex flow we currently target only calls `intro`, `note`, `text`,
 * `confirm`, and `progress`; if a future flow we adopt calls `select`,
 * it will get a numbered list + readline parser.
 */

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

function trimEnd(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export function createReadlineWizardPrompter(): WizardPrompter {
  let rl: ReadlineInterface | undefined;
  function ensureRl(): ReadlineInterface {
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stderr });
    return rl;
  }
  function closeRl(): void {
    rl?.close();
    rl = undefined;
  }

  return {
    intro: async (title) => { out(""); out(`=== ${title} ===`); },
    outro: async (message) => { out(message); out(""); closeRl(); },
    note: async (message, title) => {
      if (title) out(`[${title}]`);
      out(message);
    },
    select: async <T>(params: WizardSelectParams<T>): Promise<T> => {
      const r = ensureRl();
      out(params.message);
      params.options.forEach((opt, i) => {
        out(`  ${i + 1}. ${opt.label}${opt.hint ? ` — ${opt.hint}` : ""}`);
      });
      while (true) {
        const raw = trimEnd(await r.question("Select (number): "));
        const idx = Number(raw) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < params.options.length) {
          return params.options[idx].value;
        }
        out("Invalid selection; try again.");
      }
    },
    multiselect: async <T>(params: WizardMultiSelectParams<T>): Promise<T[]> => {
      const r = ensureRl();
      out(params.message);
      params.options.forEach((opt, i) => {
        out(`  ${i + 1}. ${opt.label}${opt.hint ? ` — ${opt.hint}` : ""}`);
      });
      const raw = trimEnd(await r.question("Select (comma-separated numbers, blank for none): "));
      if (!raw.trim()) return [];
      const out2: T[] = [];
      for (const token of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = Number(token) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < params.options.length) {
          out2.push(params.options[idx].value);
        }
      }
      return out2;
    },
    text: async (params: WizardTextParams): Promise<string> => {
      // The SDK no longer exposes a `sensitive` flag on text params;
      // the dedicated secret-prompt path is gone. If a future SDK
      // version brings it back, branch here on the new field name.
      const r = ensureRl();
      const placeholder = params.placeholder ? ` [${params.placeholder}]` : "";
      while (true) {
        const raw = trimEnd(await r.question(`${params.message}${placeholder}: `));
        const value = raw === "" && params.initialValue !== undefined ? params.initialValue : raw;
        if (params.validate) {
          const err = params.validate(value);
          if (err) { out(err); continue; }
        }
        return value;
      }
    },
    confirm: async (params: WizardConfirmParams): Promise<boolean> => {
      const r = ensureRl();
      const def = params.initialValue === true ? "Y/n" : "y/N";
      const raw = trimEnd(await r.question(`${params.message} [${def}]: `)).toLowerCase();
      if (raw === "") return params.initialValue === true;
      return raw === "y" || raw === "yes";
    },
    progress: (label: string): WizardProgress => {
      out(label);
      return {
        update: (message) => out(`  ${message}`),
        stop: (message) => { if (message) out(`  ${message}`); },
      };
    },
  };
}


import * as readline from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {mutateConfigFile} from "openclaw/plugin-sdk/config-mutation";
import {DE_EXPLORER_URLS, type DeEnv} from "../services/de-anchor.js";
import {resolveAuditUiUrl} from "../util/gateway-url.js";

export interface SetupWizardOptions {
 yes: boolean;
}

const PLUGIN_ID = "openclaw-audit-plugin";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DE_ENV: DeEnv = "mainnet";
const SIGNUP_URL = `${DE_EXPLORER_URLS[DE_ENV]}/get-started/sign-up`;

const DEFAULT_EVENT_THRESHOLD = 100;
const DEFAULT_TIMER_MIN_EVENTS = 1;
const DEFAULT_INTERVAL_MS = 300_000;

interface DeIdentity {
 deApiKey: string;
 deOrgId: string;
 deTenantId: string;
 deEnv: DeEnv;
 deEventThreshold: number;
 deTimerMinEvents: number;
 deIntervalMs: number;
}

interface OptIns {
 addToAllowList: boolean;
 enableConversationAccess: boolean;
}

// openclaw's CLI mode patches console.log to stderr (see cli.ts). Use stdout
// directly so wizard narration sits on the same stream as readline prompts.
function out(s = ""): void {
 output.write(`${s}\n`);
}

export async function runSetupWizard(opts: SetupWizardOptions): Promise<void> {
 const rl = readline.createInterface({input, output});
 let rlClosed = false;
 try {
 banner();

 await promptContinue(rl, "Press Enter to begin, or Ctrl+C to abort. ");

 // Step 1: opt-ins (one question per opt-in)
 section("Step 1 / 3 — Operator opt-ins");
 out("The plugin needs two opt-ins on the openclaw host. You can accept or skip each.");
 out("");
 const addToAllowList = await promptYesNo(
 rl,
 `Add "${PLUGIN_ID}" to plugins.allow?`,
 true,
 );
 const enableConversationAccess = await promptYesNo(
 rl,
 `Set plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess to true?`,
 true,
 );

 // Step 2: DE signup guidance + credentials (mainnet only)
 section("Step 2 / 3 — Digital Evidence credentials");
 out(
 [
 "Digital Evidence anchors audit checkpoints to Constellation for tamper-evident",
 "verification. You'll need three values from your DE dashboard:",
 ` 1. API key — generated under "API Keys" on ${SIGNUP_URL}`,
 " 2. Organization ID — UUID, visible on your org settings page",
 " 3. Tenant ID — UUID, visible on your tenant settings page",
 "",
 `If you don't have an account yet, sign up at ${SIGNUP_URL} and come back.`,
 "",
 ].join("\n"),
 );
 await promptContinue(rl, "Press Enter once you have your API key, org ID, and tenant ID. ");

 const deApiKey = await promptNonEmpty(
 rl,
 "Paste your DE API key (input will be shown; clear scrollback after if sensitive)",
 );
 const deOrgId = await promptUuid(rl, "DE organization ID (UUID)");
 const deTenantId = await promptUuid(rl, "DE tenant ID (UUID)");

 let deEventThreshold = DEFAULT_EVENT_THRESHOLD;
 let deTimerMinEvents = DEFAULT_TIMER_MIN_EVENTS;
 let deIntervalMs = DEFAULT_INTERVAL_MS;
 if (!opts.yes) {
 const customize = await promptYesNo(
 rl,
 "Customize anchoring tuning (event threshold, timer minimum, interval)?",
 false,
 );
 if (customize) {
 deEventThreshold = await promptPositiveInt(
 rl,
 "Events to accumulate before anchoring",
 DEFAULT_EVENT_THRESHOLD,
 );
 deTimerMinEvents = await promptPositiveInt(
 rl,
 "Minimum events to anchor on a timer tick",
 DEFAULT_TIMER_MIN_EVENTS,
 );
 deIntervalMs = await promptPositiveInt(
 rl,
 "Maximum interval between anchor attempts (ms)",
 DEFAULT_INTERVAL_MS,
 );
 }
 }

 const identity: DeIdentity = {
 deApiKey,
 deOrgId,
 deTenantId,
 deEnv: DE_ENV,
 deEventThreshold,
 deTimerMinEvents,
 deIntervalMs,
 };

 const optIns: OptIns = {addToAllowList, enableConversationAccess};

 // Step 3: confirm + apply
 section("Step 3 / 3 — Review and apply");
 printSummary(identity, optIns);
 const confirm = await promptYesNo(rl, "Apply these settings now?", true);
 if (!confirm) {
 out("Aborted. Nothing was written.");
 return;
 }

 rl.close();
 rlClosed = true;
 await applyAll(identity, optIns);

 out("");
 out("Settings written to openclaw config.");
 if (optIns.enableConversationAccess) {
 out("");
 out("Note: `hooks.allowConversationAccess` only takes effect after the next openclaw restart.");
 }
 out("");
 out("Once openclaw is restarted, run `openclaw audit status` to verify anchoring is reachable,");
 out(`or open the audit UI at ${resolveAuditUiUrl()}`);
 } finally {
 if (!rlClosed) rl.close();
 }
}

function banner(): void {
 out();
 out("openclaw-audit-plugin setup wizard");
 out("──────────────────────────────────");
 out("Walks you through openclaw opt-ins and Digital Evidence anchoring config.");
 out();
}

function section(title: string): void {
 out();
 out(title);
 out("─".repeat(title.length));
}

async function promptContinue(rl: readline.Interface, msg: string): Promise<void> {
 await rl.question(msg);
}

async function promptYesNo(
 rl: readline.Interface,
 msg: string,
 defaultYes: boolean,
): Promise<boolean> {
 const hint = defaultYes ? "[Y/n]" : "[y/N]";
 while (true) {
 const raw = (await rl.question(`${msg} ${hint} `)).trim().toLowerCase();
 if (raw === "") return defaultYes;
 if (raw === "y" || raw === "yes") return true;
 if (raw === "n" || raw === "no") return false;
 out("Please answer y or n.");
 }
}

async function promptNonEmpty(rl: readline.Interface, msg: string): Promise<string> {
 while (true) {
 const raw = (await rl.question(`${msg}: `)).trim();
 if (raw.length > 0) return raw;
 out("Value cannot be empty.");
 }
}

async function promptUuid(rl: readline.Interface, msg: string): Promise<string> {
 while (true) {
 const raw = (await rl.question(`${msg}: `)).trim();
 if (UUID_RE.test(raw)) return raw.toLowerCase();
 out(
 "Not a valid UUID (expected 8-4-4-4-12 hex, e.g. 11111111-1111-1111-1111-111111111111).",
 );
 }
}

async function promptPositiveInt(
 rl: readline.Interface,
 msg: string,
 defaultValue: number,
): Promise<number> {
 while (true) {
 const raw = (await rl.question(`${msg} [${defaultValue}]: `)).trim();
 if (raw === "") return defaultValue;
 const n = Number(raw);
 if (Number.isInteger(n) && n >= 1) return n;
 out("Please enter a positive integer.");
 }
}

function printSummary(id: DeIdentity, optIns: OptIns): void {
 const masked = maskKey(id.deApiKey);
 out();
 out("About to write:");
 if (optIns.addToAllowList) {
 out(` plugins.allow ⊇ ["${PLUGIN_ID}"]`);
 }
 if (optIns.enableConversationAccess) {
 out(` plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess = true`);
 }
 out(` plugins.entries.${PLUGIN_ID}.config.deApiKey = ${masked}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deOrgId = ${id.deOrgId}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deTenantId = ${id.deTenantId}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deEnv = ${id.deEnv}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deEventThreshold = ${id.deEventThreshold}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deTimerMinEvents = ${id.deTimerMinEvents}`);
 out(` plugins.entries.${PLUGIN_ID}.config.deIntervalMs = ${id.deIntervalMs}`);
 out();
}

function maskKey(key: string): string {
 if (key.length <= 8) return "*".repeat(key.length);
 return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

async function applyAll(id: DeIdentity, optIns: OptIns): Promise<void> {
 await mutateConfigFile({
 base: "source",
 mutate: (draft) => {
 draft.plugins ??= {};
 const plugins = draft.plugins;

 if (optIns.addToAllowList) {
 const existing = Array.isArray(plugins.allow) ? plugins.allow : [];
 if (!existing.includes(PLUGIN_ID)) {
 plugins.allow = [...existing, PLUGIN_ID];
 }
 }

 plugins.entries ??= {};
 const entry = (plugins.entries[PLUGIN_ID] ??= {});

 if (optIns.enableConversationAccess) {
 entry.hooks ??= {};
 entry.hooks.allowConversationAccess = true;
 }

 entry.config ??= {};
 Object.assign(entry.config, {
 deApiKey: id.deApiKey,
 deOrgId: id.deOrgId,
 deTenantId: id.deTenantId,
 deEnv: id.deEnv,
 deEventThreshold: id.deEventThreshold,
 deTimerMinEvents: id.deTimerMinEvents,
 deIntervalMs: id.deIntervalMs,
 });
 },
 });
}

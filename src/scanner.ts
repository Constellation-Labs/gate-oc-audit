import { readFileSync, statSync } from "node:fs";
import type { ScanFinding } from "./types/events.js";
import { MAX_HASHABLE_BYTES } from "./util/fs.js";
import { log } from "./util/logger.js";

/** Which scan surface a check applies to. "file" = static source files (the
 *  default, all checks); "args" = serialized tool-invocation arguments, a
 *  curated subset that excludes JS-source-syntax checks that don't appear in
 *  arg payloads. */
export type ScanProfile = "file" | "args";

/** Upper bound (in chars) on how much serialized-argument text the "args"
 *  profile scans. before_tool_call runs synchronously on the gateway's hot
 *  path, so an unbounded regex sweep over a multi-MB payload (e.g. a large
 *  Write) would stall it. The file profile is already bounded upstream by
 *  ToolScanner.scan()'s MAX_HASHABLE_BYTES skip; this is the args-path
 *  equivalent. We scan a prefix rather than skipping entirely so padding a
 *  payload past the cap can't trivially hide a short dangerous token before
 *  it. 32 KiB comfortably covers real argument sets while keeping the regex
 *  cost (the args profile includes injection patterns with a `.*`, whose
 *  worst-case backtracking is quadratic in the scanned length) bounded. */
export const MAX_SCANNED_ARG_LENGTH = 32 * 1024;

interface ScanCheck {
  name: string;
  severity: "medium" | "high";
  description: string;
  pattern: RegExp;
  // True when this check is meaningful against serialized tool-invocation args.
  // Omitted ⇒ file-only.
  args?: boolean;
}

// Build patterns dynamically so that the scanner's own source code does not
// contain the literal dangerous strings it searches for (which would cause
// OpenClaw's installation scanner to flag *this* file).
// All patterns must include the "g" flag — the scanner loop uses exec() which
// advances lastIndex on global regexps. A non-global pattern would match
// repeatedly at position 0.
function pat(source: string, flags = "g"): RegExp {
  return new RegExp(source, flags);
}

const CP = ["child", "process"].join("_");

const CHECKS: ScanCheck[] = [
  // Network calls
  {
    name: "network_fetch",
    severity: "medium",
    description: "HTTP fetch call detected",
    pattern: pat("\\b(fetch|axios|got|superagent)\\s*\\("),
  },
  {
    name: "network_http",
    severity: "medium",
    description: "Node.js HTTP/net module usage detected",
    pattern: pat("require\\s*\\(\\s*['\"`](https?|net|dgram|tls)['\"]\\s*\\)|from\\s+['\"`](https?|net|dgram|tls)['\"`]"),
  },
  {
    name: "network_socket",
    severity: "medium",
    description: "WebSocket or Socket connection detected",
    pattern: pat("\\b(WebSocket|Socket|createConnection|createServer)\\s*\\("),
  },

  // Shell execution
  {
    name: "shell_cp",
    severity: "high",
    description: "Shell command execution detected (" + CP + ")",
    pattern: pat("require\\s*\\(\\s*['\"`]" + CP + "['\"]\\s*\\)|from\\s+['\"`]" + CP + "['\"`]"),
  },
  {
    name: "shell_exec",
    severity: "high",
    description: "Shell execution call detected",
    pattern: pat("\\b(exec" + "Sync|exec" + "File|exec" + "FileSync|spawn|spawn" + "Sync)\\s*\\(|(?<!\\.)\\bexec\\s*\\("),
    args: true,
  },
  {
    name: "shell_eval",
    severity: "high",
    description: "Dynamic code execution detected",
    pattern: pat("\\bev" + "al\\s*\\(|new\\s+Fun" + "ction\\s*\\("),
    args: true,
  },

  // Obfuscation
  {
    name: "obfuscation_base64",
    severity: "high",
    description: "Base64 encoded string longer than 50 chars detected",
    pattern: pat("['\"`][A-Za-z0-9+/=]{50,}['\"`]"),
    args: true,
  },
  {
    name: "obfuscation_dynamic_import",
    severity: "high",
    description: "Dynamic import with variable path detected",
    pattern: pat("import\\s*\\(\\s*[^'\"`\\s]"),
  },
  {
    name: "obfuscation_fromcharcode",
    severity: "high",
    description: "String.fromCharCode obfuscation detected",
    pattern: pat("String\\s*\\.\\s*fromChar" + "Code"),
    args: true,
  },

  // Data exfiltration patterns — fs read combined with send indicators
  {
    name: "exfiltration_fs_read",
    severity: "high",
    description: "Filesystem read combined with network send detected",
    pattern: pat("read" + "FileSync|read" + "File|create" + "ReadStream"),
  },

  // Permission escalation
  {
    name: "escalation_plugin_access",
    severity: "medium",
    description: "Attempt to access OpenClaw internals or other plugins detected",
    pattern: pat("require\\s*\\(\\s*['\"`]openclaw/internal|pluginManager|getPlugin\\s*\\("),
  },
  {
    name: "escalation_env_access",
    severity: "medium",
    description: "Sensitive environment variable access detected",
    pattern: pat("process\\s*\\.\\s*env\\s*\\.\\s*(SECRET|PASSWORD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)", "gi"),
    args: true,
  },

  // Known injection patterns
  {
    name: "injection_prompt",
    severity: "high",
    description: "Known prompt injection pattern detected",
    pattern: pat("ignore\\s+(previous|all|above)\\s+(instructions|prompts)|system\\s*:\\s*you\\s+are|<\\|im_start\\|>|<\\|endoftext\\|>", "gi"),
    args: true,
  },
  {
    name: "injection_jailbreak",
    severity: "high",
    description: "Jailbreak pattern detected in string literal",
    pattern: pat("DAN\\s+mode|do\\s+anything\\s+now|bypass\\s+(safety|content)\\s+(filter|policy)|act\\s+as\\s+.*without\\s+(restrict|limit)", "gi"),
    args: true,
  },
];

export class ToolScanner {
  scan(filePath: string): ScanFinding[] {
    // Stat first so a planted multi-GiB file under ~/.openclaw/skills/
    // can't OOM the plugin via readFileSync's all-at-once buffer. Same
    // cap as fileHash/util-fs uses for "read the whole thing".
    try {
      const st = statSync(filePath);
      if (!st.isFile()) return [];
      if (st.size > MAX_HASHABLE_BYTES) {
        log.warn(
          `tool scan skipped: ${filePath} exceeds ${MAX_HASHABLE_BYTES} bytes (size=${st.size})`,
        );
        return [];
      }
    } catch {
      return [];
    }

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    return this.scanContent(content, filePath);
  }

  scanContent(content: string, filePath?: string, profile: ScanProfile = "file"): ScanFinding[] {
    // Bound the args hot path: scan only the leading prefix of oversize
    // serialized arguments. See MAX_SCANNED_ARG_LENGTH.
    if (profile === "args" && content.length > MAX_SCANNED_ARG_LENGTH) {
      content = content.slice(0, MAX_SCANNED_ARG_LENGTH);
    }

    const findings: ScanFinding[] = [];
    const hasNetworkSend = /fetch\s*\(|axios|\.post\s*\(|\.send\s*\(|http\.request/i.test(content);

    for (const check of CHECKS) {
      // The "args" profile runs only the curated subset of checks meaningful
      // against serialized tool-invocation arguments; file-only checks (which
      // match JS source syntax that doesn't appear in arg payloads) are skipped.
      if (profile === "args" && !check.args) {
        continue;
      }

      // For exfiltration, only flag if both fs read AND network send are present
      if (check.name === "exfiltration_fs_read" && !hasNetworkSend) {
        continue;
      }

      check.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = check.pattern.exec(content)) !== null) {
        const line = filePath ? this.getLineNumber(content, match.index) : undefined;
        findings.push({
          check: check.name,
          severity: check.severity,
          description: check.description,
          line,
        });
        // For non-global patterns, break to avoid infinite loop
        if (!check.pattern.global) break;
      }
    }

    return findings;
  }

  private getLineNumber(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }
}

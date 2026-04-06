import { readFileSync } from "node:fs";
import type { ScanFinding } from "./types/events.js";

interface ScanCheck {
  name: string;
  severity: "medium" | "high";
  description: string;
  pattern: RegExp;
}

const CHECKS: ScanCheck[] = [
  // Network calls
  {
    name: "network_fetch",
    severity: "medium",
    description: "HTTP fetch call detected",
    pattern: /\b(fetch|axios|got|superagent)\s*\(/g,
  },
  {
    name: "network_http",
    severity: "medium",
    description: "Node.js HTTP/net module usage detected",
    pattern: /require\s*\(\s*['"`](https?|net|dgram|tls)['"]\s*\)|from\s+['"`](https?|net|dgram|tls)['"`]/g,
  },
  {
    name: "network_socket",
    severity: "medium",
    description: "WebSocket or Socket connection detected",
    pattern: /\b(WebSocket|Socket|createConnection|createServer)\s*\(/g,
  },

  // Shell execution
  {
    name: "shell_child_process",
    severity: "high",
    description: "child_process module usage detected",
    pattern: /require\s*\(\s*['"`]child_process['"]\s*\)|from\s+['"`]child_process['"`]/g,
  },
  {
    name: "shell_exec",
    severity: "high",
    description: "Shell execution call detected",
    pattern: /\b(execSync|execFile|execFileSync|spawn|spawnSync)\s*\(|(?<!\.)\bexec\s*\(/g,
  },
  {
    name: "shell_eval",
    severity: "high",
    description: "Dynamic code evaluation detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/g,
  },

  // Obfuscation
  {
    name: "obfuscation_base64",
    severity: "high",
    description: "Base64 encoded string longer than 50 chars detected",
    pattern: /['"`][A-Za-z0-9+/=]{50,}['"`]/g,
  },
  {
    name: "obfuscation_dynamic_import",
    severity: "high",
    description: "Dynamic import with variable path detected",
    pattern: /import\s*\(\s*[^'"`\s]/g,
  },
  {
    name: "obfuscation_fromcharcode",
    severity: "high",
    description: "String.fromCharCode obfuscation detected",
    pattern: /String\s*\.\s*fromCharCode/g,
  },

  // Data exfiltration patterns — fs read combined with send indicators
  {
    name: "exfiltration_fs_read",
    severity: "high",
    description: "Filesystem read combined with network send detected",
    pattern: /readFileSync|readFile|createReadStream/g,
  },

  // Permission escalation
  {
    name: "escalation_plugin_access",
    severity: "medium",
    description: "Attempt to access OpenClaw internals or other plugins detected",
    pattern: /require\s*\(\s*['"`]openclaw\/internal|pluginManager|getPlugin\s*\(/g,
  },
  {
    name: "escalation_env_access",
    severity: "medium",
    description: "Sensitive environment variable access detected",
    pattern: /process\s*\.\s*env\s*\.\s*(SECRET|PASSWORD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/gi,
  },

  // Known injection patterns
  {
    name: "injection_prompt",
    severity: "high",
    description: "Known prompt injection pattern detected",
    pattern: /ignore\s+(previous|all|above)\s+(instructions|prompts)|system\s*:\s*you\s+are|<\|im_start\|>|<\|endoftext\|>/gi,
  },
  {
    name: "injection_jailbreak",
    severity: "high",
    description: "Jailbreak pattern detected in string literal",
    pattern: /DAN\s+mode|do\s+anything\s+now|bypass\s+(safety|content)\s+(filter|policy)|act\s+as\s+.*without\s+(restrict|limit)/gi,
  },
];

export class ToolScanner {
  scan(filePath: string): ScanFinding[] {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    return this.scanContent(content, filePath);
  }

  scanContent(content: string, filePath?: string): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const hasNetworkSend = /fetch\s*\(|axios|\.post\s*\(|\.send\s*\(|http\.request/i.test(content);

    for (const check of CHECKS) {
      // For exfiltration, only flag if both fs read AND network send are present
      if (check.name === "exfiltration_fs_read" && !hasNetworkSend) {
        continue;
      }

      check.pattern.lastIndex = 0;
      const match = check.pattern.exec(content);
      if (match) {
        const line = filePath ? this.getLineNumber(content, match.index) : undefined;
        findings.push({
          check: check.name,
          severity: check.severity,
          description: check.description,
          line,
        });
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

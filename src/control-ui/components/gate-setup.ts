import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getGateStatus,
  installGate,
  testGate,
  type GateInstallResponse,
  type GateProbeResult,
  type GateStatus,
} from "../api.ts";
import { STAGING_GATE_URL, STAGING_GATE_KEYS_URL } from "../../services/gate-endpoints.js";

@customElement("gate-setup")
export class GateSetup extends LitElement {
  static styles = css`
    :host { display: block; }
    h2 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--fg-dim);
    }
    section {
      padding: 16px 20px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .row { display: grid; grid-template-columns: 200px 1fr; gap: 8px; font-size: 13px; margin: 4px 0; }
    .row .k { color: var(--fg-dim); }
    .row .v { font-family: var(--mono); word-break: break-all; }
    .pill {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-family: var(--mono);
      background: var(--bg-elev2);
    }
    .pill.ok { color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 60%, transparent); }
    .pill.warn { color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent); }
    .pill.bad { color: var(--err); border: 1px solid color-mix(in srgb, var(--err) 60%, transparent); }

    form { display: grid; gap: 12px; }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--fg-dim);
    }
    input[type="text"], input[type="password"] {
      font-family: var(--mono);
      font-size: 13px;
      padding: 6px 8px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .checks {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 12px;
      color: var(--fg-dim);
    }
    .checks label {
      flex-direction: row;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .hint { font-size: 12px; color: var(--fg-dim); }

    .result {
      padding: 12px 16px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-size: 13px;
      margin-top: 12px;
    }
    .result.ok {
      border-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, var(--bg-elev));
    }
    .result.bad {
      border-color: var(--err);
      background: color-mix(in srgb, var(--err) 12%, var(--bg-elev));
    }
    .err {
      color: var(--err);
      padding: 10px 14px;
      border: 1px solid var(--err);
      border-radius: 6px;
      font-size: 13px;
      margin-top: 12px;
    }
    ul.changes {
      margin: 6px 0 0;
      padding-left: 18px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.6;
    }
    .help {
      margin-top: 16px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
    .help code, .result code {
      font-family: var(--mono);
      background: var(--bg-elev2);
      padding: 1px 4px;
      border-radius: 3px;
    }
  `;

  @state() private status?: GateStatus;
  @state() private statusError?: string;
  @state() private loadingStatus = false;

  @state() private url = STAGING_GATE_URL;
  @state() private apiKey = "";
  @state() private registerBroker = true;
  @state() private allowPrivateHost = false;
  @state() private skipProbe = false;
  @state() private installing = false;
  @state() private installResult?: GateInstallResponse;
  @state() private installError?: string;

  @state() private testing = false;
  @state() private testResult?: { url: string; result: GateProbeResult };
  @state() private testError?: string;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadStatus();
  }

  private async loadStatus(opts: { syncUrlField?: boolean } = {}) {
    this.loadingStatus = true;
    this.statusError = undefined;
    try {
      this.status = await getGateStatus();
      // Normal load: only pre-fill if the URL field is empty.
      // syncUrlField (post-install): pull the canonical saved value so
      // a trimmed/normalized URL is reflected back in the form.
      if (this.status.url && (!this.url || opts.syncUrlField)) {
        this.url = this.status.url;
      }
    } catch (err) {
      this.statusError = err instanceof Error ? err.message : String(err);
    } finally {
      this.loadingStatus = false;
    }
  }

  private async runTest() {
    this.testing = true;
    this.testError = undefined;
    this.testResult = undefined;
    try {
      // Status not loaded yet — refuse to act rather than fall into the
      // "any typed URL is an override" branch, which would produce a
      // misleading error message.
      if (!this.status && !this.statusError) {
        this.testError = "Status not loaded yet — wait a moment and try again";
        return;
      }
      // Test the saved config by default. If the operator has typed an
      // override URL into the form, require an explicit API key (same
      // policy as the CLI's --url-without-key guard).
      const overrideUrl = this.url.trim();
      const savedUrl = this.status?.url;
      const usingOverride = overrideUrl !== "" && overrideUrl !== savedUrl;
      const apiKey = this.apiKey.trim();
      if (usingOverride && !apiKey) {
        this.testError = "URL override requires an API key (saved key is never sent to a different URL)";
        return;
      }
      // Honor the same allowPrivateHost flag the install form sets, so
      // a Gate installed at an RFC1918 URL can be re-probed without
      // unchecking the box first.
      const payload = usingOverride
        ? { url: overrideUrl, apiKey, allowPrivateHost: this.allowPrivateHost }
        : { allowPrivateHost: this.allowPrivateHost };
      this.testResult = await testGate(payload);
    } catch (err) {
      this.testError = err instanceof Error ? err.message : String(err);
    } finally {
      this.testing = false;
    }
  }

  private async runInstall() {
    const url = this.url.trim() || STAGING_GATE_URL;
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      this.installError = "API key is required";
      return;
    }
    this.installing = true;
    this.installError = undefined;
    this.installResult = undefined;
    try {
      this.installResult = await installGate({
        url,
        apiKey,
        registerBroker: this.registerBroker,
        allowPrivateHost: this.allowPrivateHost,
        skipProbe: this.skipProbe,
      });
      this.apiKey = ""; // never leave the key on screen after success
      await this.loadStatus({ syncUrlField: true });
    } catch (err) {
      this.installError = err instanceof Error ? err.message : String(err);
    } finally {
      this.installing = false;
    }
  }

  render() {
    return html`
      <h2>Current configuration</h2>
      <section>${this.renderStatus()}</section>

      <h2>Install / update connection</h2>
      <section>
        <form @submit=${(e: Event) => { e.preventDefault(); void this.runInstall(); }}>
          <div class="row">
            <span class="k">Gate URL</span>
            <span class="v">${STAGING_GATE_URL}</span>
          </div>
          <p class="hint">
            Staging is the only supported Gate endpoint right now. Create an
            API key at
            <a href=${STAGING_GATE_KEYS_URL} target="_blank" rel="noopener noreferrer">${STAGING_GATE_KEYS_URL}</a>
            and paste it below.
          </p>
          <label>Gate API key
            <input type="password" placeholder="sk-gw-…"
              .value=${this.apiKey}
              autocomplete="off"
              @input=${(e: Event) => { this.apiKey = (e.target as HTMLInputElement).value; }} />
          </label>
          <div class="checks">
            <label>
              <input type="checkbox" .checked=${this.registerBroker}
                @change=${(e: Event) => { this.registerBroker = (e.target as HTMLInputElement).checked; }} />
              Register Gate as an LLM provider (models.providers.gate)
            </label>
            <label>
              <input type="checkbox" .checked=${this.allowPrivateHost}
                @change=${(e: Event) => { this.allowPrivateHost = (e.target as HTMLInputElement).checked; }} />
              Allow private/link-local URL
            </label>
            <label>
              <input type="checkbox" .checked=${this.skipProbe}
                @change=${(e: Event) => { this.skipProbe = (e.target as HTMLInputElement).checked; }} />
              Skip the live probe
            </label>
          </div>
          <div class="actions">
            <button class="primary" type="submit" ?disabled=${this.installing}>
              ${this.installing ? "Installing…" : "Install / update"}
            </button>
            <button type="button" ?disabled=${this.testing} @click=${() => void this.runTest()}>
              ${this.testing ? "Testing…" : "Test connection"}
            </button>
            <span class="hint">Restart openclaw to apply config changes.</span>
          </div>
        </form>

        ${this.installError ? html`<div class="err">${this.installError}</div>` : ""}
        ${this.installResult ? this.renderInstallResult(this.installResult) : ""}
        ${this.testError ? html`<div class="err">${this.testError}</div>` : ""}
        ${this.testResult ? this.renderTestResult(this.testResult) : ""}
      </section>

      <div class="help">
        Same flow as the CLI: <code>openclaw audit gate install</code>. The
        install writes <code>~/.openclaw/openclaw.json</code> atomically and
        a <code>.bak</code> snapshot of the prior file is kept (mode 0600).
        API key entry is never echoed back and the saved key is never
        included in <code>/api/gate/status</code> responses.
      </div>
    `;
  }

  private renderStatus() {
    if (this.loadingStatus && !this.status) return html`<p class="hint">Loading…</p>`;
    if (this.statusError) return html`<div class="err">${this.statusError}</div>`;
    const s = this.status;
    if (!s) return html`<p class="hint">No status available.</p>`;

    return html`
      <div class="row"><span class="k">Config file</span><span class="v">${s.configPath}</span></div>
      <div class="row"><span class="k">Configured</span><span class="v">${pill(s.configured, "ok", "bad")}</span></div>
      <div class="row"><span class="k">Gate URL</span><span class="v">${s.url ?? "(unset)"}</span></div>
      <div class="row"><span class="k">API key</span><span class="v">${pill(s.hasApiKey, "ok", "bad", s.hasApiKey ? "set" : "missing")}</span></div>
      <div class="row"><span class="k">In plugins.allow</span><span class="v">${pill(s.allowlisted, "ok", "warn", s.allowlisted ? "yes" : "no")}</span></div>
      <div class="row"><span class="k">Conversation access</span><span class="v">${pill(s.conversationAccess, "ok", "warn", s.conversationAccess ? "granted" : "missing")}</span></div>
      ${s.enabled === false ? html`<div class="row"><span class="k">Plugin enabled</span><span class="v">${pill(false, "ok", "bad", "NO (set to false)")}</span></div>` : ""}
      <div class="row"><span class="k">Broker provider</span><span class="v">${s.brokerProviderKey ?? "(none)"}</span></div>
    `;
  }

  private renderInstallResult(r: GateInstallResponse) {
    return html`
      <div class="result ok">
        <strong>Wrote ${r.configPath}</strong>
        ${r.changes.length === 0
          ? html`<p>Config already up to date — no changes.</p>`
          : html`<ul class="changes">${r.changes.map((c) => html`<li>+ ${c}</li>`)}</ul>`}
        <p style="margin-top:6px">Probe: ${r.probe}</p>
        <p style="margin-top:10px">
          Next: configure an OpenAI provider.
          <a href="#/providers">Open the Providers tab</a>
          to add an API key, or run
          <code>openclaw audit gate provider add openai --oauth</code>
          from a terminal for ChatGPT sign-in.
        </p>
      </div>
    `;
  }

  private renderTestResult(r: { url: string; result: GateProbeResult }) {
    const cls = r.result.kind === "ok" ? "ok" : "bad";
    return html`
      <div class="result ${cls}">
        <div class="row"><span class="k">URL</span><span class="v">${r.url}</span></div>
        <div class="row"><span class="k">Result</span><span class="v">${formatProbe(r.result)}</span></div>
      </div>
    `;
  }
}

function pill(value: boolean, okClass: "ok" | "warn", badClass: "warn" | "bad", labelOverride?: string): TemplateResult {
  const label = labelOverride ?? (value ? "yes" : "no");
  const cls = value ? okClass : badClass;
  return html`<span class="pill ${cls}">${label}</span>`;
}

function formatProbe(r: GateProbeResult): string {
  switch (r.kind) {
    case "ok": return `ok (HTTP ${r.status})`;
    case "unauthorized": return `unauthorized (HTTP ${r.status}) — ${r.body || "(no body)"}`;
    case "http-error": return `http-error (HTTP ${r.status}) — ${r.body || "(no body)"}`;
    case "network-error": return `network-error — ${r.message}`;
    default: {
      const _exhaustive: never = r;
      return `unknown probe result (${JSON.stringify(_exhaustive)})`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gate-setup": GateSetup;
  }
}

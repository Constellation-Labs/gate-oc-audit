import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  addOpenAIProvider,
  cancelOpenAIOAuth,
  getOpenAIOAuthStatus,
  listProviders,
  removeProvider,
  startOpenAIOAuth,
  type OAuthSessionStatus,
  type ProviderRow,
} from "../api.ts";

const POLL_INTERVAL_MS = 1500;
const POLL_BACKOFF_CAP_MS = 15_000;
const MAX_POLL_FAILURES = 5;

@customElement("provider-panel")
export class ProviderPanel extends LitElement {
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
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--fg-dim); font-weight: 500; font-size: 12px; }
    td.mono { font-family: var(--mono); word-break: break-all; }
    td.actions { text-align: right; }
    form { display: grid; gap: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-dim); }
    input[type="password"], input[type="text"] {
      font-family: var(--mono);
      font-size: 13px;
      padding: 6px 8px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hint { font-size: 12px; color: var(--fg-dim); }
    .err {
      color: var(--err);
      padding: 10px 14px;
      border: 1px solid var(--err);
      border-radius: 6px;
      font-size: 13px;
      margin-top: 12px;
    }
    .ok {
      color: var(--ok);
      padding: 10px 14px;
      border: 1px solid var(--ok);
      border-radius: 6px;
      background: color-mix(in srgb, var(--ok) 12%, var(--bg-elev));
      font-size: 13px;
      margin-top: 12px;
    }
    .oauth-status {
      padding: 12px 16px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--warn) 10%, var(--bg-elev));
      margin-top: 12px;
      font-size: 13px;
    }
    .oauth-status a { color: var(--fg); }
    .help {
      margin-top: 16px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
    .help code {
      font-family: var(--mono);
      background: var(--bg-elev2);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .danger { color: var(--err); cursor: pointer; background: none; border: none; padding: 4px 8px; font-size: 12px; }
    .danger:hover { background: color-mix(in srgb, var(--err) 20%, transparent); border-radius: 4px; }
  `;

  @state() private providers: ProviderRow[] = [];
  @state() private loadError?: string;
  @state() private loading = false;

  @state() private apiKey = "";
  @state() private submitting = false;
  @state() private submitError?: string;
  @state() private submitOk?: string;

  @state() private oauthSessionId?: string;
  @state() private oauthAuthUrl?: string;
  @state() private oauthStatus?: OAuthSessionStatus;
  @state() private oauthError?: string;
  private oauthPollTimer?: number;
  /** Count of consecutive `getOpenAIOAuthStatus` failures. Used to
   *  back off transient errors instead of giving up on the first one. */
  private oauthPollFailures = 0;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearOauthPoll();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.loadError = undefined;
    try {
      const { providers } = await listProviders();
      this.providers = providers;
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private async submitApiKey(): Promise<void> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) { this.submitError = "API key is required"; return; }
    this.submitting = true;
    this.submitError = undefined;
    this.submitOk = undefined;
    try {
      await addOpenAIProvider({ kind: "openai", apiKey });
      this.submitOk = "OpenAI provider configured.";
      this.apiKey = "";
      await this.refresh();
    } catch (err) {
      this.submitError = err instanceof Error ? err.message : String(err);
    } finally {
      this.submitting = false;
    }
  }

  private async startOauth(): Promise<void> {
    this.oauthError = undefined;
    this.submitOk = undefined;
    this.oauthPollFailures = 0;
    try {
      const start = await startOpenAIOAuth("openai");
      this.oauthSessionId = start.sessionId;
      this.oauthAuthUrl = start.authUrl;
      this.oauthStatus = { kind: "pending", authUrl: start.authUrl, startedAt: Date.now(), providerKey: "openai" };
      // Open the authorize URL in a new tab; the operator can also
      // copy-paste from the link below if pop-ups are blocked.
      window.open(start.authUrl, "_blank", "noopener,noreferrer");
      this.scheduleOauthPoll();
    } catch (err) {
      this.oauthError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Re-arm the OAuth status poll. We keep polling while the session is
   * `pending` (the only state the server-side flow can settle out of).
   * Transient network errors (plugin restart, brief CORS preflight
   * race, etc.) bump a failure counter with exponential backoff; we
   * only give up after MAX_POLL_FAILURES consecutive failures so a
   * single blip doesn't abandon the flow.
   */
  private scheduleOauthPoll(delayMs: number = POLL_INTERVAL_MS): void {
    this.clearOauthPoll();
    const sid = this.oauthSessionId;
    if (!sid) return;
    this.oauthPollTimer = window.setTimeout(async () => {
      try {
        const status = await getOpenAIOAuthStatus(sid);
        this.oauthPollFailures = 0;
        this.oauthError = undefined;
        this.oauthStatus = status;
        if (status.kind === "pending") {
          this.scheduleOauthPoll();
        } else if (status.kind === "complete") {
          this.submitOk = `OpenAI OAuth complete. Token expires ${status.expiresAt}.`;
          await this.refresh();
        }
        // kind === "error" → stop polling; UI shows the message.
      } catch (err) {
        this.oauthPollFailures += 1;
        if (this.oauthPollFailures >= MAX_POLL_FAILURES) {
          this.oauthError = `Lost contact with the OAuth status endpoint after ${MAX_POLL_FAILURES} attempts: ${err instanceof Error ? err.message : String(err)}`;
          return;
        }
        // Exponential backoff capped at POLL_BACKOFF_CAP_MS.
        const backoff = Math.min(POLL_INTERVAL_MS * 2 ** this.oauthPollFailures, POLL_BACKOFF_CAP_MS);
        this.scheduleOauthPoll(backoff);
      }
    }, delayMs);
  }

  private clearOauthPoll(): void {
    if (this.oauthPollTimer !== undefined) {
      window.clearTimeout(this.oauthPollTimer);
      this.oauthPollTimer = undefined;
    }
  }

  private async cancelOauth(): Promise<void> {
    const sid = this.oauthSessionId;
    if (!sid) return;
    this.clearOauthPoll();
    try { await cancelOpenAIOAuth(sid); }
    catch { /* best-effort */ }
    this.oauthSessionId = undefined;
    this.oauthAuthUrl = undefined;
    this.oauthStatus = undefined;
  }

  private async remove(key: string): Promise<void> {
    if (!confirm(`Remove provider '${key}'? This rewrites ~/.openclaw/config.json.`)) return;
    try {
      await removeProvider(key);
      await this.refresh();
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  render(): TemplateResult {
    return html`
      <h2>Configured providers</h2>
      <section>${this.renderList()}</section>

      <h2>Add / update OpenAI</h2>
      <section>
        ${this.renderOauthBlock()}
        <p class="hint" style="margin: 16px 0 8px">— or paste an existing API key —</p>
        <form @submit=${(e: Event) => { e.preventDefault(); void this.submitApiKey(); }}>
          <label>OpenAI API key
            <input type="password" placeholder="sk-…"
              .value=${this.apiKey}
              autocomplete="off"
              @input=${(e: Event) => { this.apiKey = (e.target as HTMLInputElement).value; }} />
          </label>
          <div class="actions">
            <button class="primary" type="submit" ?disabled=${this.submitting}>
              ${this.submitting ? "Saving…" : "Save API key"}
            </button>
            <span class="hint">Restart openclaw to apply.</span>
          </div>
        </form>
        ${this.submitError ? html`<div class="err">${this.submitError}</div>` : ""}
        ${this.submitOk ? html`<div class="ok">${this.submitOk}</div>` : ""}
      </section>

      <div class="help">
        OAuth uses the public <code>codex-cli</code> client_id by default. To
        bind this plugin to your own OpenAI application, set
        <code>OPENCLAW_OPENAI_OAUTH_CLIENT_ID</code> in the openclaw process
        environment before starting.
      </div>
    `;
  }

  private renderList(): TemplateResult {
    if (this.loading && this.providers.length === 0) return html`<p class="hint">Loading…</p>`;
    if (this.loadError) return html`<div class="err">${this.loadError}</div>`;
    if (this.providers.length === 0) return html`<p class="hint">No providers configured yet.</p>`;
    return html`
      <table>
        <thead><tr>
          <th>Key</th><th>Auth</th><th>Base URL</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${this.providers.map((p) => html`
          <tr>
            <td class="mono">${p.key}</td>
            <td>${p.auth ?? "—"}</td>
            <td class="mono">${p.baseUrl ?? "—"}</td>
            <td>${p.hasApiKey ? "key set" : "no key"}${p.oauthExpiresAt ? html` <span class="hint">— oauth expires ${p.oauthExpiresAt}</span>` : ""}</td>
            <td class="actions">
              ${p.key === "gate" ? html`<span class="hint">managed by Gate tab</span>`
                : html`<button class="danger" @click=${() => void this.remove(p.key)}>Remove</button>`}
            </td>
          </tr>`)}
        </tbody>
      </table>
    `;
  }

  private renderOauthBlock(): TemplateResult {
    if (!this.oauthSessionId) {
      return html`
        <div class="actions">
          <button @click=${() => void this.startOauth()}>Sign in with OpenAI (OAuth)</button>
          <span class="hint">Opens a browser tab; the loopback callback writes the token to ~/.openclaw/config.json.</span>
        </div>
        ${this.oauthError ? html`<div class="err">${this.oauthError}</div>` : ""}
      `;
    }
    const s = this.oauthStatus;
    if (!s || s.kind === "pending") {
      return html`
        <div class="oauth-status">
          <strong>Waiting for OpenAI sign-in…</strong>
          <p>If the browser tab did not open, <a href=${this.oauthAuthUrl ?? "#"} target="_blank" rel="noopener noreferrer">click here</a>.</p>
          <div class="actions">
            <button @click=${() => void this.cancelOauth()}>Cancel</button>
          </div>
        </div>
      `;
    }
    if (s.kind === "complete") {
      return html`
        <div class="ok">
          <strong>OpenAI OAuth complete.</strong>
          <p>Provider <code>${s.providerKey}</code> updated. Token expires ${s.expiresAt}.</p>
          <div class="actions">
            <button @click=${() => { this.oauthSessionId = undefined; this.oauthStatus = undefined; this.oauthAuthUrl = undefined; }}>Done</button>
          </div>
        </div>
      `;
    }
    return html`
      <div class="err">
        OAuth failed: ${s.message}
        <div class="actions">
          <button @click=${() => { this.oauthSessionId = undefined; this.oauthStatus = undefined; this.oauthAuthUrl = undefined; }}>Dismiss</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "provider-panel": ProviderPanel;
  }
}

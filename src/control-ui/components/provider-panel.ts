import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  addOpenAIProvider,
  listProviders,
  removeProvider,
  type ProviderRow,
} from "../api.ts";

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

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.loadError = undefined;
    try {
      const { profiles } = await listProviders();
      this.providers = profiles;
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
      this.submitOk = "OpenAI provider profile saved. Restart openclaw to apply.";
      this.apiKey = "";
      await this.refresh();
    } catch (err) {
      this.submitError = err instanceof Error ? err.message : String(err);
    } finally {
      this.submitting = false;
    }
  }

  private async remove(provider: string | undefined): Promise<void> {
    if (!provider) {
      this.loadError = "Cannot remove — provider id missing from listing";
      return;
    }
    if (!confirm(`Remove all profiles for provider '${provider}'? This is destructive.`)) return;
    try {
      await removeProvider(provider);
      await this.refresh();
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  render(): TemplateResult {
    return html`
      <h2>Configured profiles</h2>
      <section>${this.renderList()}</section>

      <h2>Add / update OpenAI (API key)</h2>
      <section>
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
        For OpenAI's ChatGPT-account OAuth sign-in (recommended over an
        API key for personal accounts), run this from a terminal on the
        same machine: <code>openclaw audit gate provider add openai --oauth</code>.
        The OAuth flow is a CLI wizard — the browser opens, you sign in,
        the credential is stored in the openclaw auth-profile store.
      </div>
    `;
  }

  private renderList(): TemplateResult {
    if (this.loading && this.providers.length === 0) return html`<p class="hint">Loading…</p>`;
    if (this.loadError) return html`<div class="err">${this.loadError}</div>`;
    if (this.providers.length === 0) return html`<p class="hint">No provider profiles configured yet.</p>`;
    return html`
      <table>
        <thead><tr>
          <th>Profile</th><th>Provider</th><th>Type</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${this.providers.map((p) => html`
          <tr>
            <td class="mono">${p.profileId}</td>
            <td>${p.provider}</td>
            <td>${p.type}</td>
            <td>${formatStatus(p)}</td>
            <td class="actions">
              <button class="danger" @click=${() => void this.remove(p.provider)}>Remove ${p.provider}</button>
            </td>
          </tr>`)}
        </tbody>
      </table>
    `;
  }
}

function formatStatus(p: ProviderRow): string {
  const parts: string[] = [];
  if (p.email) parts.push(p.email);
  if (p.displayName) parts.push(p.displayName);
  if (p.expiresAt) parts.push(`expires ${p.expiresAt}`);
  return parts.join("  ") || "—";
}

declare global {
  interface HTMLElementTagNameMap {
    "provider-panel": ProviderPanel;
  }
}

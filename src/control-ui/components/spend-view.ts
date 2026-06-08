import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getSpend, type SpendRollup, type SpendGroupBy } from "../api.ts";

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(4)}`;
}

function fmtTimestamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

@customElement("spend-view")
export class SpendView extends LitElement {
  static styles = css`
    :host { display: block; }
    .form {
      display: flex; flex-wrap: wrap; align-items: end; gap: 12px;
      padding: 16px; background: var(--bg-elev);
      border: 1px solid var(--border); border-radius: 8px;
      margin-bottom: 16px;
    }
    label {
      display: flex; flex-direction: column; gap: 4px;
      font-size: 12px; color: var(--fg-dim);
    }
    input, select { font-family: var(--mono); min-width: 120px; }
    .actions { margin-left: auto; }
    .err {
      color: var(--err); padding: 12px; border: 1px solid var(--err);
      border-radius: 6px; margin-bottom: 12px;
    }
    .meta { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
    .truncated { color: var(--warn); font-size: 12px; margin-top: 8px; }
    .totals {
      display: flex; gap: 16px; flex-wrap: wrap;
      padding: 12px 16px; margin-bottom: 12px;
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px;
    }
    .stat .v {
      font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .stat .l {
      font-size: 11px; color: var(--fg-dim);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden; font-size: 13px;
    }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
    th {
      background: var(--bg-elev2); font-weight: 600; font-size: 11px;
      color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: 0; }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .empty { padding: 24px; color: var(--fg-dim); text-align: center; }
  `;

  @state() private by: SpendGroupBy = "model";
  @state() private since = "24h";
  @state() private until = "";
  @state() private tz: "local" | "utc" = "utc";
  @state() private limit = "";
  @state() private rollup?: SpendRollup;
  @state() private error?: string;
  @state() private loading = false;

  connectedCallback(): void {
    super.connectedCallback();
    void this.run();
  }

  private async run(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      this.rollup = await getSpend({
        by: this.by,
        since: this.since || undefined,
        until: this.until || undefined,
        tz: this.tz,
        limit: this.limit ? Number(this.limit) : undefined,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  render(): TemplateResult {
    return html`
      <div class="form">
        <label>group by
          <select @change=${(e: Event) => { this.by = (e.target as HTMLSelectElement).value as SpendGroupBy; }}>
            <option value="provider" ?selected=${this.by === "provider"}>provider</option>
            <option value="model" ?selected=${this.by === "model"}>model</option>
            <option value="day" ?selected=${this.by === "day"}>day</option>
            <option value="session" ?selected=${this.by === "session"}>session</option>
          </select>
        </label>
        <label>since <input type="text" placeholder="24h" .value=${this.since}
          @change=${(e: Event) => { this.since = (e.target as HTMLInputElement).value; }} /></label>
        <label>until <input type="text" placeholder="now" .value=${this.until}
          @change=${(e: Event) => { this.until = (e.target as HTMLInputElement).value; }} /></label>
        <label>tz
          <select @change=${(e: Event) => { this.tz = (e.target as HTMLSelectElement).value as "local" | "utc"; }}>
            <option value="utc" ?selected=${this.tz === "utc"}>UTC</option>
            <option value="local" ?selected=${this.tz === "local"}>local</option>
          </select>
        </label>
        <label>limit <input type="number" min="1" max="100000" placeholder="1000" .value=${this.limit}
          @change=${(e: Event) => { this.limit = (e.target as HTMLInputElement).value; }} /></label>
        <div class="actions">
          <button class="primary" ?disabled=${this.loading} @click=${() => this.run()}>
            ${this.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.rollup ? this.renderRollup(this.rollup) : html`<div class="meta">Loading…</div>`}
    `;
  }

  private renderRollup(r: SpendRollup): TemplateResult {
    return html`
      <div class="meta">
        Window <strong>${r.window.label}</strong> (${r.window.fromIso} → ${r.window.toIso}, ${r.window.tz})
        · group by <strong>${r.groupBy}</strong>
        · generated ${fmtTimestamp(r.generatedAt)}
      </div>
      ${r.degraded ? html`<div class="truncated">Store is in degraded mode — some events may be missing.</div>` : ""}

      <div class="totals">
        <div class="stat"><div class="v">${fmtUsd(r.totals.costUsd)}</div><div class="l">Total cost</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.totals.callCount)}</div><div class="l">Calls</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.totals.inputTokens)}</div><div class="l">Input tokens</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.totals.outputTokens)}</div><div class="l">Output tokens</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.totals.cacheReadTokens)}</div><div class="l">Cache read</div></div>
        <div class="stat"><div class="v">${fmtNumber(r.totals.cacheWriteTokens)}</div><div class="l">Cache write</div></div>
      </div>

      ${r.rows.length === 0
        ? html`<div class="empty">No LLM activity in window.</div>`
        : html`<table>
            <thead>
              <tr>
                <th>${r.groupBy}</th>
                <th class="right">Calls</th>
                <th class="right">Input</th>
                <th class="right">Output</th>
                <th class="right">Cache read</th>
                <th class="right">Cache write</th>
                <th class="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              ${r.rows.map((row) => html`<tr>
                <td>${r.groupBy === "session"
                  ? html`<a href="#/reports/session/${encodeURIComponent(row.bucket)}">${row.bucket}</a>`
                  : row.bucket}</td>
                <td class="right">${fmtNumber(row.callCount)}</td>
                <td class="right">${fmtNumber(row.inputTokens)}</td>
                <td class="right">${fmtNumber(row.outputTokens)}</td>
                <td class="right">${fmtNumber(row.cacheReadTokens)}</td>
                <td class="right">${fmtNumber(row.cacheWriteTokens)}</td>
                <td class="right">${fmtUsd(row.costUsd)}</td>
              </tr>`)}
            </tbody>
          </table>`}

      ${r.truncated
        ? html`<div class="truncated">Rollup truncated at limit=${r.limit} — raise <code>limit</code> to include more buckets.</div>`
        : ""}
      ${r.groupBy === "day" && r.window.tz === "local"
        ? html`<div class="meta">Note: <code>--by day</code> buckets are always UTC dates, regardless of the timezone flag.</div>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "spend-view": SpendView;
  }
}

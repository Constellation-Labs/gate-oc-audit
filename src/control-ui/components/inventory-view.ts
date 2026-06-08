import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getInventory, INVENTORY_KINDS, type InventoryReport, type InventoryItem, type InventoryKind } from "../api.ts";

function fmtTimestamp(iso?: string): string {
  if (!iso) return "—";
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

type ViewKind = InventoryKind | "summary";

@customElement("inventory-view")
export class InventoryView extends LitElement {
  static styles = css`
    :host { display: block; }
    .tabs {
      display: flex; gap: 4px;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .tabs a {
      padding: 6px 14px; border-radius: 6px;
      color: var(--fg-dim); text-decoration: none;
      font-size: 13px; cursor: pointer;
      border: 1px solid transparent;
    }
    .tabs a.active {
      color: var(--fg);
      background: var(--bg-elev);
      border-color: var(--border);
    }
    .tabs a:hover { color: var(--fg); }
    .err {
      color: var(--err); padding: 12px; border: 1px solid var(--err);
      border-radius: 6px; margin-bottom: 12px;
    }
    .meta { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }
    .summary-card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; padding: 14px 16px;
    }
    .summary-card .n {
      font-size: 28px; font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .summary-card .l {
      font-size: 11px; color: var(--fg-dim);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .summary-card a { color: inherit; text-decoration: none; display: block; }
    .summary-card a:hover .n { color: var(--ok); }
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
    .mono { font-family: var(--mono); font-size: 11px; word-break: break-all; }
    .empty { padding: 24px; color: var(--fg-dim); text-align: center; }
    .badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--fg-dim); border: 1px solid var(--border);
    }
  `;

  @state() private kind: ViewKind = "summary";
  @state() private report?: InventoryReport;
  @state() private error?: string;
  @state() private loading = false;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.syncFromHash);
    this.applyHash();
    void this.run();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.syncFromHash);
    super.disconnectedCallback();
  }

  private syncFromHash = (): void => {
    this.applyHash();
    void this.run();
  };

  private applyHash(): void {
    const hash = window.location.hash;
    const qIdx = hash.indexOf("?");
    if (qIdx < 0) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const k = params.get("kind");
    if (k === "summary" || (INVENTORY_KINDS as ReadonlyArray<string>).includes(k ?? "")) {
      this.kind = k as ViewKind;
    }
  }

  private setKind(kind: ViewKind): void {
    this.kind = kind;
    const target = kind === "summary" ? "#/inventory" : `#/inventory?kind=${kind}`;
    if (window.location.hash !== target) window.location.hash = target;
    void this.run();
  }

  private async run(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      this.report = await getInventory(this.kind);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  render(): TemplateResult {
    return html`
      <div class="tabs">
        ${(["summary", ...INVENTORY_KINDS] as ViewKind[]).map((k) => html`
          <a class=${this.kind === k ? "active" : ""}
             @click=${() => this.setKind(k)}>${k}</a>
        `)}
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.loading && !this.report ? html`<div class="meta">Loading…</div>` : ""}
      ${this.report ? this.renderReport(this.report) : ""}
    `;
  }

  private renderReport(r: InventoryReport): TemplateResult {
    if (r.degraded) {
      return html`
        <div class="meta" style="color: var(--warn)">Store is in degraded mode — counts may be missing rows.</div>
        ${this.renderBody(r)}
      `;
    }
    return this.renderBody(r);
  }

  private renderBody(r: InventoryReport): TemplateResult {
    if (this.kind === "summary") {
      return html`
        <div class="summary-grid">
          ${INVENTORY_KINDS.map((k) => html`
            <div class="summary-card">
              <a @click=${() => this.setKind(k)}>
                <div class="n">${r.summary[k]}</div>
                <div class="l">${k}</div>
              </a>
            </div>
          `)}
        </div>
      `;
    }
    const items = (r as Record<string, unknown>)[this.kind] as InventoryItem[] | undefined;
    if (!items || items.length === 0) {
      return html`<div class="empty">No ${this.kind} discovered.</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Version</th>
            <th>Source</th>
            <th>Path</th>
            <th>In manifest</th>
            <th>Filesystem mtime</th>
            ${this.kind === "crons" ? html`<th></th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => html`<tr>
            <td>${item.name}</td>
            <td>${item.version ?? "—"}</td>
            <td><span class="badge">${item.source}</span></td>
            <td class="mono">${item.path}</td>
            <td>${item.capturedInManifests ? "yes" : "no"}</td>
            <td>${fmtTimestamp(item.filesystemMtime)}</td>
            ${this.kind === "crons"
              ? html`<td><a href="#/reports/cron?jobId=${encodeURIComponent(item.name)}">rollup →</a></td>`
              : ""}
          </tr>`)}
        </tbody>
      </table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inventory-view": InventoryView;
  }
}

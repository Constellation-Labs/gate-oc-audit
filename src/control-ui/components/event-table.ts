import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listEvents, type ApiEvent } from "../api.ts";
import "./event-filters.ts";
import "./event-detail.ts";
import type { FiltersValue } from "./event-filters.ts";

const PAGE_SIZE = 10;

@customElement("event-table")
export class EventTable extends LitElement {
  static styles = css`
    :host { display: block; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 4px;
    }
    .status {
      font-size: 13px;
      color: var(--fg-dim);
    }
    .err {
      color: var(--err);
      padding: 12px;
      border: 1px solid var(--err);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .degraded {
      color: var(--warn);
      padding: 8px 12px;
      border: 1px solid var(--warn);
      border-radius: 6px;
      margin-bottom: 12px;
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      background: var(--bg-elev2);
      font-weight: 600;
      font-size: 12px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: 0; }
    tr.row { cursor: pointer; }
    tr.row:hover td { background: var(--bg-elev2); }
    .seq { font-family: var(--mono); color: var(--fg-dim); width: 60px; }
    .status { width: 110px; }
    .time { font-family: var(--mono); white-space: nowrap; width: 175px; }
    .type { font-family: var(--mono); width: 200px; }
    .cat { width: 100px; color: var(--fg-dim); }
    .desc { color: var(--fg); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge.verified {
      color: var(--ok);
      border-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, transparent);
    }
    .badge.pending {
      color: var(--warn);
      border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }
    .badge.tampered {
      color: var(--err);
      border-color: var(--err);
      background: color-mix(in srgb, var(--err) 14%, transparent);
    }
    .badge.untracked {
      color: var(--fg-dim);
      border-color: var(--fg-dim);
      background: color-mix(in srgb, var(--fg-dim) 10%, transparent);
    }
    .badge.unknown { color: var(--fg-dim); }
    .preview {
      color: var(--fg-dim);
      font-family: var(--mono);
      font-size: 11px;
      margin-top: 4px;
      white-space: pre-wrap;
      max-height: 3.2em;
      overflow: hidden;
    }
    .paging {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      justify-content: flex-end;
    }
    .paging .info { color: var(--fg-dim); font-size: 13px; margin-right: auto; }
    .empty {
      padding: 48px 24px;
      text-align: center;
      color: var(--fg-dim);
    }
  `;

  @state() private events: ApiEvent[] = [];
  @state() private total = 0;
  @state() private offset = 0;
  @state() private loading = false;
  @state() private error?: string;
  @state() private degraded = false;
  @state() private filters: FiltersValue = { type: "", category: "", session: "" };
  @state() private detailId?: string;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.error = undefined;
    try {
      const res = await listEvents({
        limit: PAGE_SIZE,
        offset: this.offset,
        type: this.filters.type || undefined,
        category: this.filters.category || undefined,
        session: this.filters.session || undefined,
      });
      this.events = res.events;
      this.total = res.total;
      this.degraded = res.degraded;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private onFilters(e: CustomEvent<FiltersValue>) {
    this.filters = e.detail;
    this.offset = 0;
    void this.load();
  }

  private page(delta: number) {
    const next = Math.max(0, Math.min(this.offset + delta * PAGE_SIZE, Math.max(0, this.total - 1)));
    if (next === this.offset) return;
    this.offset = next;
    void this.load();
  }

  private fmtTime(iso: string): string {
    return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
  }

  private renderBadge(ev: ApiEvent) {
    const v = ev.verification;
    if (!v) return html`<span class="badge unknown" title="status unknown">—</span>`;
    if (v.status === "verified") {
      const title = v.treeKey
        ? `Leaf present in SMT "${v.treeKey}"; sequence covered by a DE-anchored checkpoint.`
        : "Leaf present in SMT; sequence covered by a DE-anchored checkpoint.";
      return html`<span class="badge verified" title=${title}>✓ verified</span>`;
    }
    if (v.status === "pending") {
      const title = v.treeKey
        ? `Leaf present in SMT "${v.treeKey}", but no DE anchor yet covers this sequence.`
        : "Leaf present in SMT, but no DE anchor yet covers this sequence.";
      return html`<span class="badge pending" title=${title}>⏳ pending</span>`;
    }
    if (v.status === "untracked") {
      return html`<span class="badge untracked" title="Row exists but the SMT has not processed this sequence yet — e.g. gateway.stop captured via SIGINT before the next plugin start replayed it into the tree.">◌ untracked</span>`;
    }
    return html`<span class="badge tampered" title="The SMT has processed this sequence but the current content no longer hashes to the stored leaf — row was modified after insertion.">⚠ tampered</span>`;
  }

  private openDetail(id: string) {
    this.detailId = id;
  }

  private closeDetail() {
    this.detailId = undefined;
  }

  render() {
    const start = this.events.length === 0 ? 0 : this.offset + 1;
    const end = this.offset + this.events.length;
    return html`
      <div class="toolbar">
        <event-filters .value=${this.filters} @filters-change=${this.onFilters}></event-filters>
        <span class="status">
          ${this.loading ? "Loading…" : `${start}–${end} of ${this.total}`}
        </span>
      </div>

      ${this.degraded
        ? html`<div class="degraded">Audit store is in degraded mode — some events may be missing.</div>`
        : ""}
      ${this.error ? html`<div class="err">${this.error}</div>` : ""}

      ${this.events.length === 0 && !this.loading
        ? html`<div class="empty">No audit events match the current filters.</div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                ${this.events.map((ev) => html`
                  <tr class="row" @click=${() => this.openDetail(ev.id)}>
                    <td class="seq">#${ev.sequence}</td>
                    <td class="status">${this.renderBadge(ev)}</td>
                    <td class="time">${this.fmtTime(ev.createdAt)}</td>
                    <td class="type">${ev.eventType}</td>
                    <td class="cat">${ev.category}</td>
                    <td class="desc">
                      ${ev.description}
                      ${ev.content ? html`<div class="preview">${ev.content}</div>` : ""}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}

      <div class="paging">
        <span class="info">page size ${PAGE_SIZE}</span>
        <button ?disabled=${this.offset === 0 || this.loading} @click=${() => this.page(-1)}>Prev</button>
        <button ?disabled=${end >= this.total || this.loading} @click=${() => this.page(1)}>Next</button>
      </div>

      ${this.detailId
        ? html`<event-detail .eventId=${this.detailId} @close=${this.closeDetail}></event-detail>`
        : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "event-table": EventTable;
  }
}

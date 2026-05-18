import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listEvents, type ApiEvent } from "../api.ts";
import "./event-filters.ts";
import "./event-detail.ts";
import type { FiltersValue } from "./event-filters.ts";

const PAGE_SIZE = 10;

interface FocusInfo {
  /** The sequence the initial page lands on. */
  seq: number;
  /** Optional inclusive range to highlight; defaults to [seq, seq]. */
  rangeStart: number;
  rangeEnd: number;
}

// Sequences are positive int32s; clamp anything else away so a crafted hash
// can't ferry a giant or negative value into the API call (the server clamps
// too, but keeping the client honest avoids a confusing empty-page render).
const MAX_SEQ = 0x7fffffff;
function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SEQ ? n : undefined;
}

function readFocusFromHash(): FocusInfo | undefined {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return undefined;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const seq = parsePositiveInt(params.get("focusSeq"));
  if (seq === undefined) return undefined;
  return {
    seq,
    rangeStart: parsePositiveInt(params.get("rangeStart")) ?? seq,
    rangeEnd: parsePositiveInt(params.get("rangeEnd")) ?? seq,
  };
}

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
    .seq-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px 6px 12px;
      margin-bottom: 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-elev2);
      font-size: 12px;
      color: var(--fg);
    }
    .seq-chip button {
      background: transparent;
      border: 0;
      color: var(--fg-dim);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: 999px;
    }
    .seq-chip button:hover { color: var(--fg); background: var(--bg-elev); }
    tr.row.focused td {
      background: color-mix(in srgb, var(--err) 12%, transparent);
    }
    tr.row.focused:hover td {
      background: color-mix(in srgb, var(--err) 18%, transparent);
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
  /** Sticky informational marker for a jumped-to event/range. Does NOT filter
   *  the result set — Prev/Next walk the full log. Cleared on dismiss, on a
   *  filter change, or when the URL hash drops the focusSeq param. */
  @state() private focus?: FocusInfo;
  /** Set when the next `load()` should ask the server to snap to the focused
   *  sequence's page. Cleared after that load; subsequent paginations leave
   *  the offset under client control. */
  private pendingFocus = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncFromHash();
    window.addEventListener("hashchange", this.onHashChange);
    void this.load();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHashChange);
    super.disconnectedCallback();
  }

  private onHashChange = (): void => {
    const before = this.focus;
    this.syncFromHash();
    const after = this.focus;
    const changed = before?.seq !== after?.seq
      || before?.rangeStart !== after?.rangeStart
      || before?.rangeEnd !== after?.rangeEnd;
    if (changed) {
      void this.load();
    }
  };

  private syncFromHash(): void {
    const info = readFocusFromHash();
    if (info) {
      this.focus = info;
      this.pendingFocus = true;
      // Clear existing filters so the focused row is guaranteed to be on the
      // page the server lands on — otherwise filter + focus combinations can
      // hide the targeted event. The server enforces the same invariant.
      this.filters = { type: "", category: "", session: "" };
    } else {
      this.focus = undefined;
      this.pendingFocus = false;
    }
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
        focusSeq: this.pendingFocus ? this.focus?.seq : undefined,
      });
      this.events = res.events;
      this.total = res.total;
      // When focusSeq is set the server computes the offset; adopt it so
      // Prev/Next continue from that page.
      this.offset = res.offset;
      this.degraded = res.degraded;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.pendingFocus = false;
    }
  }

  private onFilters(e: CustomEvent<FiltersValue>) {
    this.filters = e.detail;
    this.offset = 0;
    // An explicit filter change retires the focus marker; the targeted row
    // may not even match the new filters.
    this.clearFocus();
    void this.load();
  }

  private clearFocus = (): void => {
    if (!this.focus) return;
    this.focus = undefined;
    // Synchronously cleared before the hash write so the listener's
    // before/after comparison sees no change and skips a redundant reload.
    window.location.hash = "#/events";
  };

  private lastPageOffset(): number {
    if (this.total <= 0) return 0;
    return Math.floor((this.total - 1) / PAGE_SIZE) * PAGE_SIZE;
  }

  private jumpToOffset(target: number) {
    const next = Math.max(0, Math.min(target, this.lastPageOffset()));
    if (next === this.offset) return;
    this.offset = next;
    void this.load();
  }

  private page(delta: number) {
    this.jumpToOffset(this.offset + delta * PAGE_SIZE);
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
    const focus = this.focus;
    return html`
      ${focus
        ? html`
            <div class="seq-chip">
              <span>${focus.rangeStart === focus.rangeEnd
                ? `Jumped to event #${focus.seq} — Prev/Next walk the full log`
                : `Jumped to event #${focus.seq} (interval ${focus.rangeStart}–${focus.rangeEnd}) — Prev/Next walk the full log`}</span>
              <button title="Dismiss marker" aria-label="Dismiss marker" @click=${this.clearFocus}>×</button>
            </div>
          `
        : ""}
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
                  <tr class="row ${focus && ev.sequence >= focus.rangeStart && ev.sequence <= focus.rangeEnd ? "focused" : ""}" @click=${() => this.openDetail(ev.id)}>
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
        <button ?disabled=${this.offset === 0 || this.loading} @click=${() => this.jumpToOffset(0)}>First</button>
        <button ?disabled=${this.offset === 0 || this.loading} @click=${() => this.page(-1)}>Prev</button>
        <button ?disabled=${end >= this.total || this.loading} @click=${() => this.page(1)}>Next</button>
        <button ?disabled=${end >= this.total || this.loading} @click=${() => this.jumpToOffset(this.lastPageOffset())}>Last</button>
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

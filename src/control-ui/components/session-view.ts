import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getSessionRollup,
  type SessionProjection,
  type SessionTimelineEntry,
  type SessionToolUsage,
  type SessionLlmModelUsage,
  type SessionOutboundMessage,
} from "../api.ts";

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(4)}`;
}

function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function readSessionIdFromHash(): string | undefined {
  // #/reports/session/<id>?raw=…
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (!hash.startsWith("reports/session/")) return undefined;
  const rest = hash.slice("reports/session/".length);
  return rest ? decodeURIComponent(rest) : undefined;
}

function readHashParams(): { raw?: boolean; limit?: string } {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return {};
  const p = new URLSearchParams(hash.slice(qIdx + 1));
  return { raw: p.get("raw") === "true", limit: p.get("limit") ?? undefined };
}

@customElement("session-view")
export class SessionView extends LitElement {
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
    input { font-family: var(--mono); min-width: 280px; }
    .checkbox { flex-direction: row; align-items: center; gap: 6px; }
    .actions { margin-left: auto; }
    .err {
      color: var(--err); padding: 12px; border: 1px solid var(--err);
      border-radius: 6px; margin-bottom: 12px;
    }
    .meta { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; padding: 14px 16px;
    }
    .card.full { grid-column: 1 / -1; }
    .card h3 {
      margin: 0 0 8px; font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-dim);
    }
    .total { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
    th {
      color: var(--fg-dim); font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.04em; font-weight: 600;
    }
    tr:last-child td { border-bottom: 0; }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .empty { color: var(--fg-dim); font-style: italic; }
    .truncated { color: var(--warn); font-size: 12px; margin-top: 8px; }
    .preview {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--fg-dim);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .seq { font-family: var(--mono); color: var(--fg-dim); width: 60px; }
    .collapsed { color: var(--warn); font-size: 11px; }
  `;

  @state() private sessionId = "";
  @state() private raw = false;
  @state() private limit = "";
  @state() private projection?: SessionProjection;
  @state() private error?: string;
  @state() private loading = false;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.syncFromHash);
    this.applyHash();
    if (this.sessionId) void this.run();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.syncFromHash);
    super.disconnectedCallback();
  }

  private syncFromHash = (): void => {
    this.applyHash();
    if (this.sessionId) void this.run();
  };

  private applyHash(): void {
    const id = readSessionIdFromHash();
    if (id !== undefined) this.sessionId = id;
    const { raw, limit } = readHashParams();
    if (raw !== undefined) this.raw = raw;
    if (limit !== undefined) this.limit = limit;
  }

  private updateHash(): void {
    if (!this.sessionId) return;
    const params = new URLSearchParams();
    if (this.raw) params.set("raw", "true");
    if (this.limit) params.set("limit", this.limit);
    const qs = params.toString();
    window.location.hash = `#/reports/session/${encodeURIComponent(this.sessionId)}${qs ? "?" + qs : ""}`;
  }

  private async run(): Promise<void> {
    if (!this.sessionId) {
      this.error = "Enter a session ID to load the rollup.";
      return;
    }
    this.loading = true;
    this.error = undefined;
    try {
      this.projection = await getSessionRollup(this.sessionId, {
        raw: this.raw,
        limit: this.limit ? Number(this.limit) : undefined,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private submit(): void {
    this.updateHash();
    void this.run();
  }

  render(): TemplateResult {
    return html`
      <div class="form">
        <label>Session ID
          <input type="text" placeholder="sess-…" .value=${this.sessionId}
            @change=${(e: Event) => { this.sessionId = (e.target as HTMLInputElement).value; }} />
        </label>
        <label>Limit (last N)
          <input type="number" min="1" max="50000" placeholder="50000" .value=${this.limit}
            @change=${(e: Event) => { this.limit = (e.target as HTMLInputElement).value; }} />
        </label>
        <label class="checkbox">
          <input type="checkbox" .checked=${this.raw}
            @change=${(e: Event) => { this.raw = (e.target as HTMLInputElement).checked; }} />
          raw (no dedup)
        </label>
        <div class="actions">
          <button class="primary" ?disabled=${this.loading || !this.sessionId}
            @click=${() => this.submit()}>
            ${this.loading ? "Loading…" : "Load"}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.projection ? this.renderProjection(this.projection) : html`<div class="meta">Enter a session ID to view the rollup.</div>`}
    `;
  }

  private renderProjection(p: SessionProjection): TemplateResult {
    return html`
      <div class="meta">
        Session <strong>${p.sessionId}</strong>
        ${p.jobId ? html` · cron <a href="#/reports/cron?jobId=${encodeURIComponent(p.jobId)}">${p.jobId}</a>` : ""}
        ${p.startedAt && p.endedAt
          ? html` · ${fmtTimestamp(p.startedAt)} → ${fmtTimestamp(p.endedAt)} (${fmtDuration(p.durationMs)})`
          : html` · no session boundary events`}
        ${p.raw ? html` · <strong>raw mode</strong>` : ""}
      </div>
      ${p.degraded ? html`<div class="truncated">Store is in degraded mode — some events may be missing.</div>` : ""}
      ${p.truncated ? html`<div class="truncated">Event fetch truncated at the cap — older session rows are not in this rollup.</div>` : ""}

      <div class="grid">
        ${this.renderTools(p.toolsUsed)}
        ${this.renderLlmCost(p.llmCost)}
        ${this.renderIntegrity(p)}
        ${this.renderOutbound(p.outboundMessages)}
        ${this.renderTimeline(p.timeline)}
      </div>
    `;
  }

  private renderTools(tools: SessionToolUsage[]): TemplateResult {
    return html`
      <div class="card">
        <h3>Tools used</h3>
        ${tools.length === 0
          ? html`<div class="empty">No tool invocations</div>`
          : html`<table>
              <thead><tr><th>Tool</th><th class="right">Calls</th><th class="right">Errors</th><th class="right">Duration</th></tr></thead>
              <tbody>
                ${tools.map((t) => html`<tr>
                  <td>${t.toolName}</td>
                  <td class="right">${fmtNumber(t.calls)}</td>
                  <td class="right">${fmtNumber(t.errors)}</td>
                  <td class="right">${fmtDuration(t.totalDurationMs)}</td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderLlmCost(cost: { totalCalls: number; totalCostUsd: number; byModel: SessionLlmModelUsage[] }): TemplateResult {
    return html`
      <div class="card">
        <h3>LLM cost</h3>
        <div class="total">${fmtUsd(cost.totalCostUsd)} <span style="color: var(--fg-dim); font-size: 14px">· ${fmtNumber(cost.totalCalls)} calls</span></div>
        ${cost.byModel.length === 0
          ? html`<div class="empty">No LLM activity</div>`
          : html`<table>
              <thead><tr><th>Provider/Model</th><th class="right">Calls</th><th class="right">In</th><th class="right">Out</th><th class="right">Cost</th></tr></thead>
              <tbody>
                ${cost.byModel.map((m) => html`<tr>
                  <td>${m.provider ? `${m.provider}/${m.model}` : m.model}</td>
                  <td class="right">${fmtNumber(m.calls)}</td>
                  <td class="right">${fmtNumber(m.inputTokens)}</td>
                  <td class="right">${fmtNumber(m.outputTokens)}</td>
                  <td class="right">${fmtUsd(m.costUsd)}</td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderIntegrity(p: SessionProjection): TemplateResult {
    const i = p.integrity;
    return html`
      <div class="card">
        <h3>Integrity</h3>
        <table>
          <tbody>
            <tr><td>Events in session</td><td class="right">${fmtNumber(i.eventCount)}</td></tr>
            <tr><td>First sequence</td><td class="right">${i.firstSequence !== null ? html`<a href="#/events?focusSeq=${i.firstSequence}">#${i.firstSequence}</a>` : "—"}</td></tr>
            <tr><td>Last sequence</td><td class="right">${i.lastSequence !== null ? html`<a href="#/events?focusSeq=${i.lastSequence}">#${i.lastSequence}</a>` : "—"}</td></tr>
            <tr><td>Proofs verified</td><td class="right">${fmtNumber(i.proofsVerified)}</td></tr>
            <tr><td>Proofs failed</td><td class="right">${i.proofsFailed > 0 ? html`<span style="color: var(--err)">${i.proofsFailed}</span>` : "0"}</td></tr>
            <tr><td>Proofs unavailable</td><td class="right">${fmtNumber(i.proofsUnavailable)}</td></tr>
            <tr><td>SMT root</td><td style="font-family: var(--mono); font-size: 11px; word-break: break-all">${i.smtRoot ?? "—"}</td></tr>
          </tbody>
        </table>
      </div>
    `;
  }

  private renderOutbound(msgs: SessionOutboundMessage[]): TemplateResult {
    return html`
      <div class="card full">
        <h3>Outbound messages</h3>
        ${msgs.length === 0
          ? html`<div class="empty">No outbound messages in session</div>`
          : msgs.map((m) => html`
              <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border)">
                <div style="font-family: var(--mono); font-size: 11px; color: var(--fg-dim)">sha256 ${m.contentHash.slice(0, 16)}… · ${m.sends.length} send${m.sends.length === 1 ? "" : "s"}</div>
                ${m.bodyPreview ? html`<div class="preview" style="margin: 4px 0; white-space: pre-wrap; max-width: none">${m.bodyPreview}</div>` : ""}
                <table style="margin-top: 8px">
                  <thead><tr><th>Time</th><th>Channel</th><th>Recipient</th><th>Seq</th><th>Length</th><th>Success</th></tr></thead>
                  <tbody>
                    ${m.sends.map((s) => html`<tr>
                      <td>${fmtTimestamp(s.createdAt)}</td>
                      <td>${s.channel}</td>
                      <td>${s.recipient}</td>
                      <td><a href="#/events?focusSeq=${s.sequence}">#${s.sequence}</a></td>
                      <td class="right">${fmtNumber(s.contentLength)}</td>
                      <td>${s.success === null ? "—" : s.success ? "ok" : "fail"}</td>
                    </tr>`)}
                  </tbody>
                </table>
              </div>
            `)}
      </div>
    `;
  }

  private renderTimeline(timeline: SessionTimelineEntry[]): TemplateResult {
    return html`
      <div class="card full">
        <h3>Timeline (${timeline.length} entries)</h3>
        ${timeline.length === 0
          ? html`<div class="empty">No events for this session</div>`
          : html`<table>
              <thead><tr><th>Seq</th><th>Time</th><th>Type</th><th>Category</th><th>Description</th><th>Content hash</th></tr></thead>
              <tbody>
                ${timeline.map((e) => html`<tr>
                  <td class="seq"><a href="#/events?focusSeq=${e.sequence}">#${e.sequence}</a></td>
                  <td>${fmtTimestamp(e.createdAt)}</td>
                  <td>${e.eventType}</td>
                  <td>${e.category}</td>
                  <td>
                    ${e.description}
                    ${e.collapsedCount && e.collapsedCount > 1 ? html`<span class="collapsed"> · ×${e.collapsedCount}</span>` : ""}
                  </td>
                  <td style="font-family: var(--mono); font-size: 11px">${e.contentHash.slice(0, 16)}…</td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-view": SessionView;
  }
}

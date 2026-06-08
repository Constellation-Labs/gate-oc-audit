import { LitElement, html, css, type TemplateResult, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  getReport,
  type AuditProjection,
  type ConfiguredCron,
  type DuplicateOutboundFinding,
} from "../api.ts";

type Kind = "daily" | "weekly";

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoWeekString(d: Date): string {
  // ISO-8601 week date. Mirrors `thisWeekInTz` (src/reports/time-window.ts).
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target.valueOf()) / 604_800_000);
  const yearOfThursday = new Date(firstThursday).getUTCFullYear();
  return `${yearOfThursday}-W${String(weekNumber).padStart(2, "0")}`;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // 4-dp so per-call costs don't round to $0.00.
  return `$${n.toFixed(4)}`;
}

function fmtCronSchedule(c: ConfiguredCron): string {
  const s = c.schedule;
  switch (s.kind) {
    case "at": return `at ${s.at}`;
    case "every": return `every ${s.everyMs} ms`;
    case "cron": return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    case "unknown": return `unknown (${s.raw})`;
  }
}

@customElement("report-projection")
export class ReportProjection extends LitElement {
  static styles = css`
    :host { display: block; }
    .form {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 12px;
      padding: 16px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 16px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--fg-dim);
    }
    input, select {
      font-family: var(--mono);
      min-width: 140px;
    }
    .actions { margin-left: auto; }
    .err {
      color: var(--err);
      padding: 12px;
      border: 1px solid var(--err);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .meta {
      color: var(--fg-dim);
      font-size: 12px;
      margin-bottom: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .card h3 {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--fg-dim);
    }
    .card .total {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
    th { color: var(--fg-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .anomaly {
      margin: 8px 0;
      padding: 10px 12px;
      border-left: 3px solid var(--warn);
      background: color-mix(in srgb, var(--warn) 8%, var(--bg-elev));
      border-radius: 0 6px 6px 0;
    }
    .anomaly h4 { margin: 0 0 4px; font-size: 13px; overflow-wrap: anywhere; }
    .anomaly p { margin: 2px 0; font-size: 12px; overflow-wrap: anywhere; }
    .anomaly a { color: var(--fg); text-decoration: underline; }
    .empty { color: var(--fg-dim); font-style: italic; }
    .truncated { color: var(--warn); font-size: 12px; }
  `;

  /** Which period to render — sub-route literal. */
  @property({ type: String }) kind: Kind = "daily";

  @state() private date = todayIso();
  @state() private week = isoWeekString(new Date());
  @state() private tz: "local" | "utc" = "utc";
  @state() private dupWindowSec = "";
  @state() private lookbackDays = "";
  @state() private topTools = "";

  @state() private loading = false;
  @state() private error?: string;
  @state() private projection?: AuditProjection;

  connectedCallback(): void {
    super.connectedCallback();
    this.applyHashParams();
    window.addEventListener("hashchange", this.syncFromHash);
    void this.run();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.syncFromHash);
    super.disconnectedCallback();
  }

  willUpdate(changed: Map<string, unknown>) {
    if (changed.has("kind")) {
      // The hashchange handler will re-fetch, but trigger one immediately too
      // so the dashboard isn't stale between route flips in fast clicking.
      void this.run();
    }
  }

  private syncFromHash = (): void => {
    this.applyHashParams();
    void this.run();
  };

  private applyHashParams(): void {
    const hash = window.location.hash;
    const qIdx = hash.indexOf("?");
    if (qIdx < 0) return;
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const date = params.get("date");
    const week = params.get("week");
    const tz = params.get("tz");
    if (date) this.date = date;
    if (week) this.week = week;
    if (tz === "local" || tz === "utc") this.tz = tz;
  }

  private async run(): Promise<void> {
    this.loading = true;
    this.error = undefined;
    try {
      this.projection = await getReport({
        period: this.kind,
        date: this.kind === "daily" ? this.date : undefined,
        week: this.kind === "weekly" ? this.week : undefined,
        tz: this.tz,
        dupWindowSec: this.dupWindowSec ? Number(this.dupWindowSec) : undefined,
        lookbackDays: this.lookbackDays ? Number(this.lookbackDays) : undefined,
        topTools: this.topTools ? Number(this.topTools) : undefined,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  render(): TemplateResult {
    return html`
      ${this.renderForm()}
      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.projection ? this.renderProjection(this.projection) : html`<div class="meta">Loading…</div>`}
    `;
  }

  private renderForm(): TemplateResult {
    return html`
      <div class="form">
        ${this.kind === "daily"
          ? html`<label>Date
              <input type="date" .value=${this.date}
                @change=${(e: Event) => { this.date = (e.target as HTMLInputElement).value; }} />
            </label>`
          : html`<label>ISO week
              <input type="text" placeholder="2026-W19" .value=${this.week}
                @change=${(e: Event) => { this.week = (e.target as HTMLInputElement).value; }} />
            </label>`}
        <label>Timezone
          <select @change=${(e: Event) => { this.tz = (e.target as HTMLSelectElement).value as "local" | "utc"; }}>
            <option value="utc" ?selected=${this.tz === "utc"}>UTC</option>
            <option value="local" ?selected=${this.tz === "local"}>local</option>
          </select>
        </label>
        <label>dup window (s)
          <input type="number" min="1" placeholder="60" .value=${this.dupWindowSec}
            @change=${(e: Event) => { this.dupWindowSec = (e.target as HTMLInputElement).value; }} />
        </label>
        <label>lookback (d)
          <input type="number" min="1" placeholder="30" .value=${this.lookbackDays}
            @change=${(e: Event) => { this.lookbackDays = (e.target as HTMLInputElement).value; }} />
        </label>
        <label>top tools
          <input type="number" min="1" placeholder="10" .value=${this.topTools}
            @change=${(e: Event) => { this.topTools = (e.target as HTMLInputElement).value; }} />
        </label>
        <div class="actions">
          <button class="primary" ?disabled=${this.loading} @click=${() => this.run()}>
            ${this.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>
    `;
  }

  private renderProjection(p: AuditProjection): TemplateResult {
    return html`
      <div class="meta">
        Period <strong>${p.period.label}</strong> (${p.period.fromIso} → ${p.period.toIso}, ${p.period.tz})
        · generated ${p.generatedAt.replace(/\.\d+Z$/, "Z")}
      </div>
      <div class="grid">
        ${this.renderActivity(p)}
        ${this.renderCron(p)}
        ${this.renderTopTools(p)}
        ${this.renderSpend(p)}
        ${this.renderOutbound(p)}
        ${this.renderAnomalies(p)}
        ${this.renderIntegrity(p)}
      </div>
    `;
  }

  private renderActivity(p: AuditProjection): TemplateResult {
    return html`
      <div class="card">
        <h3>Activity</h3>
        <div class="total">${fmtNumber(p.activity.totalEvents)}</div>
        <table>
          <thead><tr><th>Category</th><th class="right">Count</th></tr></thead>
          <tbody>
            ${p.activity.byCategory.length === 0
              ? html`<tr><td colspan="2" class="empty">No events</td></tr>`
              : p.activity.byCategory.map((c) => html`<tr><td>${c.category}</td><td class="right">${fmtNumber(c.count)}</td></tr>`)}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderCron(p: AuditProjection): TemplateResult {
    return html`
      <div class="card">
        <h3>Cron</h3>
        <div class="total">${fmtNumber(p.cron.executed)} executed${p.cron.failed > 0 ? html` <span style="color: var(--err); font-size: 14px">· ${p.cron.failed} failed</span>` : nothing}</div>
        ${p.cron.byEventType.length > 0 ? html`
          <table>
            <thead><tr><th>Event</th><th class="right">Count</th></tr></thead>
            <tbody>
              ${p.cron.byEventType.map((c) => html`<tr><td>${c.eventType}</td><td class="right">${fmtNumber(c.count)}</td></tr>`)}
            </tbody>
          </table>` : ""}
        ${p.cron.configured.length > 0 ? html`
          <h3 style="margin-top: 12px">Configured</h3>
          <table>
            <thead><tr><th>Job</th><th>Schedule</th></tr></thead>
            <tbody>
              ${p.cron.configured.map((c) => html`<tr>
                <td><a href="#/reports/cron?jobId=${encodeURIComponent(c.name)}">${c.name}</a></td>
                <td>${fmtCronSchedule(c)}</td>
              </tr>`)}
            </tbody>
          </table>` : ""}
      </div>
    `;
  }

  private renderTopTools(p: AuditProjection): TemplateResult {
    return html`
      <div class="card">
        <h3>Top tools</h3>
        ${p.topTools.length === 0
          ? html`<div class="empty">No tool invocations in window</div>`
          : html`<table>
              <thead><tr><th>Tool</th><th class="right">Invocations</th></tr></thead>
              <tbody>
                ${p.topTools.map((t) => html`<tr><td>${t.toolName}</td><td class="right">${fmtNumber(t.invocations)}</td></tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderSpend(p: AuditProjection): TemplateResult {
    return html`
      <div class="card">
        <h3>LLM spend</h3>
        <div class="total">${fmtUsd(p.llmSpend.totalCostUsd)} <span style="color: var(--fg-dim); font-size: 14px">over ${fmtNumber(p.llmSpend.totalCalls)} calls</span></div>
        ${p.llmSpend.byModel.length === 0
          ? html`<div class="empty">No LLM activity</div>`
          : html`<table>
              <thead><tr><th>Provider/Model</th><th class="right">Calls</th><th class="right">In</th><th class="right">Out</th><th class="right">Cost</th></tr></thead>
              <tbody>
                ${p.llmSpend.byModel.map((m) => html`<tr>
                  <td>${m.provider ? `${m.provider}/${m.model}` : m.model}</td>
                  <td class="right">${fmtNumber(m.callCount)}</td>
                  <td class="right">${fmtNumber(m.inputTokens)}</td>
                  <td class="right">${fmtNumber(m.outputTokens)}</td>
                  <td class="right">${fmtUsd(m.costUsd)}</td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderOutbound(p: AuditProjection): TemplateResult {
    return html`
      <div class="card">
        <h3>Outbound messaging</h3>
        <div class="total">${fmtNumber(p.outboundMessaging.totalSent)}</div>
        ${p.outboundMessaging.byChannel.length === 0
          ? html`<div class="empty">No outbound messages</div>`
          : html`<table>
              <thead><tr><th>Channel</th><th class="right">Sent</th></tr></thead>
              <tbody>
                ${p.outboundMessaging.byChannel.map((c) => html`<tr><td>${c.channel}</td><td class="right">${fmtNumber(c.count)}</td></tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderAnomalies(p: AuditProjection): TemplateResult {
    const dup = p.anomalies.duplicateOutbound;
    const firstSeen = p.anomalies.firstSeenTools;
    return html`
      <div class="card">
        <h3>Anomalies</h3>
        ${dup.length === 0 && firstSeen.length === 0
          ? html`<div class="empty">None in window</div>`
          : ""}
        ${dup.map((f) => this.renderDupOutbound(f))}
        ${p.anomalies.duplicateOutboundTruncated
          ? html`<div class="truncated">Duplicate-outbound detector truncated — earlier sends in the window were not scanned.</div>`
          : ""}
        ${firstSeen.length > 0
          ? html`<div class="anomaly">
              <h4>First-seen tools</h4>
              <p>${firstSeen.join(", ")}</p>
            </div>`
          : ""}
      </div>
    `;
  }

  private renderDupOutbound(f: DuplicateOutboundFinding): TemplateResult {
    const first = f.events[0];
    return html`
      <div class="anomaly">
        <h4>Duplicate outbound — ${f.channel} → ${f.recipient}</h4>
        <p>${f.events.length} sends within ${f.deltaSeconds}s · content sha256 <span style="font-family: var(--mono); font-size: 11px">${f.contentSha256.slice(0, 12)}…</span></p>
        <p>
          ${f.events.map((e, i) => html`<a href="#/events?focusSeq=${e.sequence}">#${e.sequence}</a>${i < f.events.length - 1 ? ", " : ""}`)}
          ${first ? html` · first at ${first.createdAt.replace(/\.\d+Z$/, "Z")}` : ""}
        </p>
      </div>
    `;
  }

  private renderIntegrity(p: AuditProjection): TemplateResult {
    const i = p.integrity;
    const cp = i.lastCheckpoint;
    return html`
      <div class="card">
        <h3>Integrity footer</h3>
        <table>
          <tbody>
            <tr><td>Last event</td><td>${i.lastSequence !== null ? html`<a href="#/events?focusSeq=${i.lastSequence}">#${i.lastSequence}</a>` : "—"}</td></tr>
            <tr><td>Created</td><td>${i.lastEventCreatedAt ?? "—"}</td></tr>
            <tr><td>Content hash</td><td style="font-family: var(--mono); word-break: break-all">${i.lastEventContentHash ?? "—"}</td></tr>
            ${cp ? html`
              <tr><td>Last checkpoint</td><td>${cp.checkpointId}</td></tr>
              <tr><td>SMT root</td><td style="font-family: var(--mono); word-break: break-all">${cp.smtRoot}</td></tr>
              <tr><td>DE tx</td><td style="font-family: var(--mono); word-break: break-all">${cp.deTxHash ?? "—"}</td></tr>
              <tr><td>Sequence range</td><td>${cp.sequenceStart}–${cp.sequenceEnd}</td></tr>
            ` : html`<tr><td>Last checkpoint</td><td>—</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "report-projection": ReportProjection;
  }
}

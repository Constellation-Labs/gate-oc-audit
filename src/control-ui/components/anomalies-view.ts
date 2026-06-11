import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getAnomalies,
  type AnomalyView,
  type DuplicateOutboundFinding,
  type DenialSpikeFinding,
  type InstallEventFinding,
  type IntegrityViolationFinding,
} from "../api.ts";
import { fmtNumber, fmtTimestamp } from "../format.ts";

@customElement("anomalies-view")
export class AnomaliesView extends LitElement {
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
    .capped { color: var(--warn); font-size: 12px; margin-bottom: 12px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; padding: 14px 16px;
    }
    .card.full { grid-column: 1 / -1; }
    .card h3 {
      margin: 0 0 10px; font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-dim);
    }
    .empty { color: var(--fg-dim); font-style: italic; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
    th {
      color: var(--fg-dim); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    }
    tr:last-child td { border-bottom: 0; }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .anomaly {
      margin: 8px 0; padding: 10px 12px;
      border-left: 3px solid var(--warn);
      background: color-mix(in srgb, var(--warn) 8%, var(--bg-elev));
      border-radius: 0 6px 6px 0;
    }
    .anomaly.severe { border-left-color: var(--err); background: color-mix(in srgb, var(--err) 10%, var(--bg-elev)); }
    .anomaly h4 { margin: 0 0 4px; font-size: 13px; overflow-wrap: anywhere; }
    .anomaly p { margin: 2px 0; font-size: 12px; overflow-wrap: anywhere; }
    .anomaly a { color: var(--fg); text-decoration: underline; }
    .badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge.warn { color: var(--warn); border: 1px solid var(--warn); }
    .badge.err { color: var(--err); border: 1px solid var(--err); }
    .badge.ok { color: var(--ok); border: 1px solid var(--ok); }
  `;

  @state() private since = "24h";
  @state() private until = "";
  @state() private tz: "local" | "utc" = "utc";
  @state() private dupWindowSec = "";
  @state() private lookbackDays = "";
  @state() private denialWindowSec = "";
  @state() private denialThreshold = "";

  @state() private view?: AnomalyView;
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
      this.view = await getAnomalies({
        since: this.since || undefined,
        until: this.until || undefined,
        tz: this.tz,
        dupWindowSec: this.dupWindowSec ? Number(this.dupWindowSec) : undefined,
        lookbackDays: this.lookbackDays ? Number(this.lookbackDays) : undefined,
        denialWindowSec: this.denialWindowSec ? Number(this.denialWindowSec) : undefined,
        denialThreshold: this.denialThreshold ? Number(this.denialThreshold) : undefined,
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
        <label>dup window (s) <input type="number" min="1" .value=${this.dupWindowSec}
          @change=${(e: Event) => { this.dupWindowSec = (e.target as HTMLInputElement).value; }} /></label>
        <label>lookback (d) <input type="number" min="1" .value=${this.lookbackDays}
          @change=${(e: Event) => { this.lookbackDays = (e.target as HTMLInputElement).value; }} /></label>
        <label>denial window (s) <input type="number" min="1" .value=${this.denialWindowSec}
          @change=${(e: Event) => { this.denialWindowSec = (e.target as HTMLInputElement).value; }} /></label>
        <label>denial threshold <input type="number" min="1" .value=${this.denialThreshold}
          @change=${(e: Event) => { this.denialThreshold = (e.target as HTMLInputElement).value; }} /></label>
        <div class="actions">
          <button class="primary" ?disabled=${this.loading} @click=${() => this.run()}>
            ${this.loading ? "Scanning…" : "Scan window"}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.view ? this.renderView(this.view) : html`<div class="meta">Loading…</div>`}
    `;
  }

  private renderView(v: AnomalyView): TemplateResult {
    const a = v.anomalies;
    return html`
      <div class="meta">
        Period <strong>${v.period.label}</strong> (${v.period.fromIso} → ${v.period.toIso}, ${v.period.tz})
        · ${fmtNumber(v.counts.totalEventsInWindow)} events
        · generated ${fmtTimestamp(v.generatedAt)}
      </div>
      ${v.counts.capped
        ? html`<div class="capped">Window event fetch hit the cap — detectors saw a truncated view; treat empty results as inconclusive.</div>`
        : ""}
      ${v.degraded ? html`<div class="capped">Store is in degraded mode — some events may be missing.</div>` : ""}

      <div class="grid">
        ${this.renderIntegrity(a.integrityViolations)}
        ${this.renderDuplicateOutbound(a.duplicateOutbound)}
        ${this.renderDenialSpikes(a.denialSpikes)}
        ${this.renderInstallEvents(a.installEvents)}
        ${this.renderFirstSeen(a.firstSeenTools)}
      </div>
    `;
  }

  private renderIntegrity(i: IntegrityViolationFinding): TemplateResult {
    const tampered = i.tamperedEvents;
    const notFound = i.notFoundOnDe;
    const pending = i.pendingVerification;
    // Pending verification is a normal, expected state — only tampered events
    // and checkpoints DE confirmed missing count toward a clean/violation
    // verdict.
    const clean = tampered.length === 0 && notFound.length === 0;
    return html`
      <div class="card full">
        <h3>Integrity</h3>
        ${i.note ? html`<div class="meta">${i.note}</div>` : ""}
        ${clean
          ? html`<div class="empty"><span class="badge ok">clean</span> no integrity violations in window</div>`
          : ""}
        ${tampered.length > 0 ? html`
          <div class="anomaly severe">
            <h4>Tampered events (${tampered.length})</h4>
            <table>
              <thead><tr><th>Seq</th><th>Type</th><th>Created</th></tr></thead>
              <tbody>
                ${tampered.map((t) => html`<tr>
                  <td><a href="#/events?focusSeq=${t.sequence}">#${t.sequence}</a></td>
                  <td>${t.eventType}</td>
                  <td>${fmtTimestamp(t.createdAt)}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>` : ""}
        ${notFound.length > 0 ? html`
          <div class="anomaly severe">
            <h4>Checkpoints not found on DE (${notFound.length})</h4>
            <p class="meta">Anchored but the DE transaction could not be found on verification — the SMT root was never durably recorded.</p>
            <table>
              <thead><tr><th>Checkpoint</th><th>Sequence range</th><th>DE tx</th><th>SMT root</th></tr></thead>
              <tbody>
                ${notFound.map((c) => html`<tr>
                  <td>${c.checkpointId}</td>
                  <td>${c.sequenceStart}–${c.sequenceEnd}</td>
                  <td style="font-family: var(--mono); font-size: 11px">${c.deTxHash ?? "—"}</td>
                  <td style="font-family: var(--mono); font-size: 11px">${c.smtRoot}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>` : ""}
        ${pending.length > 0 ? html`
          <div class="anomaly">
            <h4><span class="badge ok">normal</span> Pending DE verification (${pending.length})</h4>
            <p class="meta">Anchored and awaiting DE confirmation. This is expected — not an anomaly. Verification re-runs on a cadence and clears these automatically.</p>
            <table>
              <thead><tr><th>Checkpoint</th><th>Sequence range</th><th>DE tx</th><th>SMT root</th></tr></thead>
              <tbody>
                ${pending.map((c) => html`<tr>
                  <td>${c.checkpointId}</td>
                  <td>${c.sequenceStart}–${c.sequenceEnd}</td>
                  <td style="font-family: var(--mono); font-size: 11px">${c.deTxHash ?? "—"}</td>
                  <td style="font-family: var(--mono); font-size: 11px">${c.smtRoot}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>` : ""}
      </div>
    `;
  }

  private renderDuplicateOutbound(dups: DuplicateOutboundFinding[]): TemplateResult {
    return html`
      <div class="card">
        <h3>Duplicate outbound (${dups.length})</h3>
        ${dups.length === 0
          ? html`<div class="empty">No duplicate sends in window</div>`
          : dups.map((d) => html`
              <div class="anomaly">
                <h4>${d.channel} → ${d.recipient}</h4>
                <p>${d.events.length} sends within ${d.deltaSeconds}s · sha <span style="font-family: var(--mono); font-size: 11px">${d.contentSha256.slice(0, 12)}…</span></p>
                <p>${d.events.map((e, i) => html`<a href="#/events?focusSeq=${e.sequence}">#${e.sequence}</a>${i < d.events.length - 1 ? ", " : ""}`)}</p>
              </div>
            `)}
      </div>
    `;
  }

  private renderDenialSpikes(spikes: DenialSpikeFinding[]): TemplateResult {
    return html`
      <div class="card">
        <h3>Denial spikes (${spikes.length})</h3>
        ${spikes.length === 0
          ? html`<div class="empty">No denial spikes in window</div>`
          : spikes.map((s) => html`
              <div class="anomaly">
                <h4>${s.count} denials between ${fmtTimestamp(s.firstAt)} and ${fmtTimestamp(s.lastAt)}</h4>
                ${s.topReason ? html`<p>Top reason: <code>${s.topReason}</code></p>` : ""}
                <p>By tool: ${s.byTool.map((t, i) => html`${t.toolName} (${t.count})${i < s.byTool.length - 1 ? ", " : ""}`)}</p>
                <p>${s.events.slice(0, 8).map((e, i) => html`<a href="#/events?focusSeq=${e.sequence}">#${e.sequence}</a>${i < Math.min(s.events.length, 8) - 1 ? ", " : ""}`)}${s.events.length > 8 ? html` · +${s.events.length - 8} more` : ""}</p>
              </div>
            `)}
      </div>
    `;
  }

  private renderInstallEvents(installs: InstallEventFinding[]): TemplateResult {
    return html`
      <div class="card full">
        <h3>Install events (${installs.length})</h3>
        ${installs.length === 0
          ? html`<div class="empty">No installs in window</div>`
          : html`<table>
              <thead><tr><th>Seq</th><th>Created</th><th>Target</th><th>Version</th><th>Scan</th><th>Critical</th><th>Warn</th></tr></thead>
              <tbody>
                ${installs.map((i) => html`<tr>
                  <td><a href="#/events?focusSeq=${i.sequence}">#${i.sequence}</a></td>
                  <td>${fmtTimestamp(i.createdAt)}</td>
                  <td>${i.targetType}/${i.targetName}</td>
                  <td>${i.version ?? "—"}</td>
                  <td>${i.scanStatus ? html`<span class="badge ${i.elevated ? "err" : "ok"}">${i.scanStatus}</span>` : "—"}</td>
                  <td class="right">${i.scanCritical > 0 ? html`<span style="color: var(--err)">${i.scanCritical}</span>` : "0"}</td>
                  <td class="right">${i.scanWarn > 0 ? html`<span style="color: var(--warn)">${i.scanWarn}</span>` : "0"}</td>
                </tr>`)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  private renderFirstSeen(tools: string[]): TemplateResult {
    return html`
      <div class="card">
        <h3>First-seen tools (${tools.length})</h3>
        ${tools.length === 0
          ? html`<div class="empty">No new tools in window</div>`
          : html`<p style="font-size: 13px">${tools.join(", ")}</p>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "anomalies-view": AnomaliesView;
  }
}

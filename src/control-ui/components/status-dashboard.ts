import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getStatus, getAnomalies, type StatusSnapshot, type AnomalyView } from "../api.ts";
import { computeHealthVerdict, type HealthVerdict } from "../health.ts";

const REFRESH_MS = 30_000;

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

function fmtBytesMb(mb: number): string {
  if (!Number.isFinite(mb)) return "—";
  return `${mb.toFixed(1)} MB`;
}

function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  // Trim ".sssZ" → "Z" so the dashboard doesn't show subsecond noise.
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

function fmtRelative(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((now.getTime() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}

@customElement("status-dashboard")
export class StatusDashboard extends LitElement {
  static styles = css`
    :host { display: block; }
    .toolbar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .toolbar .meta {
      font-size: 12px;
      color: var(--fg-dim);
    }
    .err {
      color: var(--err);
      padding: 12px;
      border: 1px solid var(--err);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    /* Hero health verdict — the featured element. */
    .hero {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 20px 22px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .hero .icon { font-size: 34px; line-height: 1; }
    .hero .body { flex: 1; min-width: 0; }
    .hero h2 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .hero .sub { margin-top: 4px; font-size: 13px; color: var(--fg-dim); }
    .hero ul { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    .hero li { display: flex; align-items: baseline; gap: 8px; font-size: 13px; overflow-wrap: anywhere; }
    .hero li .dot { flex: none; }
    .hero li a { color: var(--fg); text-decoration: underline; }
    .hero .notes { margin-top: 10px; font-size: 12px; color: var(--fg-dim); }
    .hero.ok { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, var(--bg-elev)); }
    .hero.ok h2 { color: var(--ok); }
    .hero.warn { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, var(--bg-elev)); }
    .hero.warn h2 { color: var(--warn); }
    .hero.err { border-color: var(--err); background: color-mix(in srgb, var(--err) 10%, var(--bg-elev)); }
    .hero.err h2 { color: var(--err); }
    .dot.lvl-warn { color: var(--warn); }
    .dot.lvl-err { color: var(--err); }
    /* Section headings above Activity / Details. */
    h2.section {
      margin: 24px 0 12px;
      font-size: 17px;
      font-weight: 600;
    }
    /* Recent-activity stat tiles. */
    .activity {
      display: flex;
      flex-wrap: wrap;
      gap: 20px 28px;
      padding: 16px 18px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .activity .stat .v {
      font-size: 22px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .activity .stat .l {
      font-size: 11px;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: var(--fg);
    }
    .row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px;
      font-size: 13px;
      margin: 4px 0;
    }
    .row .k { color: var(--fg-dim); }
    .row .v { font-family: var(--mono); word-break: break-all; }
    .badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge.ok { color: var(--ok); border: 1px solid var(--ok); }
    .badge.warn { color: var(--warn); border: 1px solid var(--warn); }
    .badge.err { color: var(--err); border: 1px solid var(--err); }
    .badge.idle { color: var(--fg-dim); border: 1px solid var(--border); }
    .empty { color: var(--fg-dim); font-size: 13px; padding: 12px; }
  `;

  @state() private snapshot?: StatusSnapshot;
  @state() private anomalies: AnomalyView | null = null;
  @state() private error?: string;
  @state() private loading = false;
  @state() private lastFetchedAt?: Date;

  private timer?: ReturnType<typeof setInterval>;

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  disconnectedCallback(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    super.disconnectedCallback();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    // Status drives the page; the anomaly scan is best-effort — a failure there
    // degrades the verdict to snapshot-only signals rather than blanking the page.
    const [status, anomalies] = await Promise.allSettled([
      getStatus(),
      getAnomalies({ since: "24h" }),
    ]);
    if (status.status === "fulfilled") {
      this.snapshot = status.value;
      this.error = undefined;
      this.lastFetchedAt = new Date();
    } else {
      this.error = status.reason instanceof Error ? status.reason.message : String(status.reason);
    }
    this.anomalies = anomalies.status === "fulfilled" ? anomalies.value : null;
    this.loading = false;
  }

  render(): TemplateResult {
    return html`
      <div class="toolbar">
        <div class="meta">
          ${this.snapshot
            ? html`Generated ${fmtTimestamp(this.snapshot.header.generatedAt)} · auto-refresh ${REFRESH_MS / 1000}s`
            : html`Loading…`}
        </div>
        <button ?disabled=${this.loading} @click=${() => this.refresh()}>
          ${this.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.snapshot ? this.renderContent(this.snapshot) : html`<div class="empty">No snapshot yet.</div>`}
    `;
  }

  private renderContent(s: StatusSnapshot): TemplateResult {
    const now = this.lastFetchedAt ?? new Date();
    const verdict = computeHealthVerdict(s, this.anomalies);
    return html`
      ${this.renderHero(verdict)}

      <h2 class="section">Recent activity</h2>
      ${this.renderActivity(s, now)}

      <h2 class="section">Details</h2>
      <div class="grid">
        ${this.renderPluginCard(s)}
        ${this.renderStorageCard(s, now)}
        ${this.renderIntegrityCard(s)}
        ${this.renderAnchorCard(s, now)}
        ${this.renderFileWatchCard(s)}
        ${this.renderInventoryCard(s)}
        ${this.renderSecurityCard(s, now)}
      </div>
    `;
  }

  private renderHero(v: HealthVerdict): TemplateResult {
    const icon = v.level === "ok" ? "✓" : v.level === "warn" ? "⚠" : "✕";
    const headline =
      v.level === "ok" ? "All systems normal" :
      v.level === "warn" ? "Minor issues" :
      "Attention required";
    const sub =
      v.level === "ok"
        ? "No anomalies, integrity violations, or anchor failures in the last 24h."
        : `${v.issues.length} issue${v.issues.length === 1 ? "" : "s"} need${v.issues.length === 1 ? "s" : ""} attention.`;
    return html`
      <div class="hero ${v.level}">
        <div class="icon">${icon}</div>
        <div class="body">
          <h2>${headline}</h2>
          <div class="sub">${sub}</div>
          ${v.issues.length > 0
            ? html`<ul>
                ${v.issues.map((i) => html`<li>
                  <span class="dot lvl-${i.level}">●</span>
                  <span>${i.href ? html`<a href=${i.href}>${i.message}</a>` : i.message}</span>
                </li>`)}
              </ul>`
            : ""}
          ${v.notes.length > 0
            ? html`<div class="notes">${v.notes.map((n) => html`<div>${n}</div>`)}</div>`
            : ""}
        </div>
      </div>
    `;
  }

  private renderActivity(s: StatusSnapshot, now: Date): TemplateResult {
    return html`
      <div class="activity">
        <div class="stat"><div class="v">${fmtNumber(s.storage.eventCount)}</div><div class="l">Total events</div></div>
        <div class="stat"><div class="v">#${fmtNumber(s.integrity.sequenceAtHead)}</div><div class="l">Head sequence</div></div>
        <div class="stat"><div class="v">${fmtNumber(s.fileWatch.recentChanges24h)}</div><div class="l">Changes 24h</div></div>
        <div class="stat"><div class="v">${fmtNumber(s.anchor.anchoredToday)}</div><div class="l">Anchored today</div></div>
        <div class="stat"><div class="v">${fmtRelative(s.anchor.lastAnchorAt, now)}</div><div class="l">Last anchor</div></div>
        <div class="stat"><div class="v">${fmtRelative(s.securityScan.lastScanAt, now)}</div><div class="l">Last scan</div></div>
      </div>
    `;
  }

  private renderPluginCard(s: StatusSnapshot): TemplateResult {
    return html`
      <div class="card">
        <h3>Plugin</h3>
        <div class="row"><span class="k">Name</span><span class="v">${s.header.pluginName}</span></div>
        <div class="row"><span class="k">Version</span><span class="v">${s.header.pluginVersion}</span></div>
        <div class="row"><span class="k">Machine ID</span><span class="v">${s.header.machineId}</span></div>
      </div>
    `;
  }

  private renderStorageCard(s: StatusSnapshot, now: Date): TemplateResult {
    const st = s.storage;
    return html`
      <div class="card">
        <h3>Storage</h3>
        <div class="row"><span class="k">DB size</span><span class="v">${fmtBytesMb(st.dbSizeMb)} / ${fmtBytesMb(st.maxSizeMb)}</span></div>
        <div class="row"><span class="k">Events</span><span class="v">${fmtNumber(st.eventCount)}</span></div>
        <div class="row"><span class="k">Oldest event</span><span class="v">${fmtTimestamp(st.oldestEventAt)}${st.oldestEventAgeDays !== null ? html` <span style="color: var(--fg-dim)">(${st.oldestEventAgeDays}d)</span>` : ""}</span></div>
        <div class="row"><span class="k">Retention</span><span class="v">${st.retentionDays}d</span></div>
        <div class="row"><span class="k">Next prune</span><span class="v">${st.nextPruneAt ? fmtRelative(st.nextPruneAt, now) : "—"}</span></div>
      </div>
    `;
  }

  private renderIntegrityCard(s: StatusSnapshot): TemplateResult {
    const it = s.integrity;
    const convBadge = it.conversationAccess === "enabled"
      ? html`<span class="badge ok">enabled</span>`
      : it.conversationAccess === "enabled-but-silent"
        ? html`<span class="badge warn">enabled · silent 24h</span>`
        : html`<span class="badge idle">disabled</span>`;
    return html`
      <div class="card">
        <h3>Integrity</h3>
        <div class="row"><span class="k">Head sequence</span><span class="v">#${fmtNumber(it.sequenceAtHead)}</span></div>
        <div class="row"><span class="k">SMT trees</span><span class="v">${it.smtTreeCount} ${it.smtTreeKeys.length > 0 ? `(${it.smtTreeKeys.join(", ")})` : ""}</span></div>
        <div class="row"><span class="k">SMT root</span><span class="v">${it.smtRoot ?? "—"}</span></div>
        <div class="row"><span class="k">SMT entries/nodes</span><span class="v">${fmtNumber(it.smtEntryCount)} / ${fmtNumber(it.smtNodeCount)}</span></div>
        <div class="row"><span class="k">Last checkpoint</span><span class="v">${it.lastCheckpoint ? html`#${it.lastCheckpoint.sequenceEnd} · ${fmtTimestamp(it.lastCheckpoint.createdAt)}` : "—"}</span></div>
        <div class="row"><span class="k">Pending events</span><span class="v">${fmtNumber(it.pendingSinceLastCheckpoint)}</span></div>
        <div class="row"><span class="k">Conv. access</span><span class="v">${convBadge}</span></div>
      </div>
    `;
  }

  private renderAnchorCard(s: StatusSnapshot, now: Date): TemplateResult {
    const a = s.anchor;
    const badge = !a.isActive
      ? html`<span class="badge idle">inactive</span>`
      : a.circuitOpen
        ? html`<span class="badge err">circuit open</span>`
        : a.consecutiveFailures > 0
          ? html`<span class="badge warn">failing</span>`
          : html`<span class="badge ok">healthy</span>`;
    return html`
      <div class="card">
        <h3>DE Anchor</h3>
        <div class="row"><span class="k">Status</span><span class="v">${badge}</span></div>
        <div class="row"><span class="k">Anchored today</span><span class="v">${fmtNumber(a.anchoredToday)}</span></div>
        <div class="row"><span class="k">Last anchor</span><span class="v">${fmtRelative(a.lastAnchorAt, now)}</span></div>
        <div class="row"><span class="k">Last tx</span><span class="v">${a.lastTxHash ?? "—"}</span></div>
        <div class="row"><span class="k">Failures (streak)</span><span class="v">${fmtNumber(a.consecutiveFailures)}</span></div>
        <div class="row"><span class="k">Pending events</span><span class="v">${fmtNumber(a.pendingSinceLastCheckpoint)}</span></div>
      </div>
    `;
  }

  private renderFileWatchCard(s: StatusSnapshot): TemplateResult {
    const f = s.fileWatch;
    return html`
      <div class="card">
        <h3>File watch</h3>
        <div class="row"><span class="k">Patterns watched</span><span class="v">${fmtNumber(f.patternsWatched)}</span></div>
        <div class="row"><span class="k">Patterns ignored</span><span class="v">${fmtNumber(f.patternsIgnored)}</span></div>
        <div class="row"><span class="k">Changes 24h</span><span class="v">${fmtNumber(f.recentChanges24h)}</span></div>
      </div>
    `;
  }

  private renderInventoryCard(s: StatusSnapshot): TemplateResult {
    const i = s.inventory;
    return html`
      <div class="card">
        <h3>Inventory</h3>
        <div class="row"><span class="k">Plugins</span><span class="v">${fmtNumber(i.plugins)}</span></div>
        <div class="row"><span class="k">Skills</span><span class="v">${fmtNumber(i.skills)}</span></div>
        <div class="row"><span class="k">Tools</span><span class="v">${fmtNumber(i.tools)}</span></div>
        <div class="row"><span class="k">Crons</span><span class="v">${fmtNumber(i.crons)}</span></div>
      </div>
    `;
  }

  private renderSecurityCard(s: StatusSnapshot, now: Date): TemplateResult {
    const sc = s.securityScan;
    const badge = !sc.lastScanAt
      ? html`<span class="badge idle">no scan yet</span>`
      : sc.highFindings > 0
        ? html`<span class="badge err">${sc.highFindings} high</span>`
        : sc.mediumFindings > 0
          ? html`<span class="badge warn">${sc.mediumFindings} medium</span>`
          : html`<span class="badge ok">clean</span>`;
    return html`
      <div class="card">
        <h3>Security scan</h3>
        <div class="row"><span class="k">Status</span><span class="v">${badge}</span></div>
        <div class="row"><span class="k">Last scan</span><span class="v">${fmtRelative(sc.lastScanAt, now)}</span></div>
        <div class="row"><span class="k">High findings</span><span class="v">${fmtNumber(sc.highFindings)}</span></div>
        <div class="row"><span class="k">Medium findings</span><span class="v">${fmtNumber(sc.mediumFindings)}</span></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "status-dashboard": StatusDashboard;
  }
}

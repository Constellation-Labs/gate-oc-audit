import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getCronRollup, type CronRollup, type CronRollupRow, type ConfiguredCron } from "../api.ts";

function fmtCronSchedule(c: ConfiguredCron | null): string {
  if (!c) return "—";
  const s = c.schedule;
  switch (s.kind) {
    case "at": return `at ${s.at}`;
    case "every": return `every ${s.everyMs} ms`;
    case "cron": return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
    case "unknown": return `unknown (${s.raw})`;
  }
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace(/\.\d+Z$/, "Z").replace("T", " ");
}

function parseHashParams(): { jobId?: string; last?: string } {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return {};
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return {
    jobId: params.get("jobId") ?? undefined,
    last: params.get("last") ?? undefined,
  };
}

@customElement("report-cron")
export class ReportCron extends LitElement {
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
    input { font-family: var(--mono); min-width: 240px; }
    .actions { margin-left: auto; }
    .err {
      color: var(--err); padding: 12px; border: 1px solid var(--err);
      border-radius: 6px; margin-bottom: 12px;
    }
    .meta { color: var(--fg-dim); font-size: 12px; margin-bottom: 12px; }
    .truncated { color: var(--warn); font-size: 12px; margin-top: 8px; }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; overflow: hidden; font-size: 13px;
    }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    th {
      background: var(--bg-elev2); font-weight: 600; font-size: 11px;
      color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: 0; }
    td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
    .status {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .status.ok { color: var(--ok); border: 1px solid var(--ok); }
    .status.failed { color: var(--err); border: 1px solid var(--err); }
    .status.incomplete { color: var(--warn); border: 1px solid var(--warn); }
    .empty { color: var(--fg-dim); padding: 16px; text-align: center; }
    .err-cell { color: var(--err); font-size: 12px; max-width: 320px; word-break: break-word; }
  `;

  @state() private jobId = "";
  @state() private last = "20";
  @state() private rollup?: CronRollup;
  @state() private error?: string;
  @state() private loading = false;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.syncFromHash);
    this.applyHashParams();
    if (this.jobId) void this.run();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.syncFromHash);
    super.disconnectedCallback();
  }

  private syncFromHash = (): void => {
    this.applyHashParams();
    if (this.jobId) void this.run();
  };

  private applyHashParams(): void {
    const { jobId, last } = parseHashParams();
    if (jobId !== undefined) this.jobId = jobId;
    if (last !== undefined) this.last = last;
  }

  private async run(): Promise<void> {
    if (!this.jobId) {
      this.error = "Enter a job-id to load the rollup.";
      return;
    }
    this.loading = true;
    this.error = undefined;
    try {
      const lastN = this.last ? Number(this.last) : undefined;
      this.rollup = await getCronRollup(this.jobId, lastN);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private updateHash(): void {
    const params = new URLSearchParams();
    if (this.jobId) params.set("jobId", this.jobId);
    if (this.last) params.set("last", this.last);
    const qs = params.toString();
    window.location.hash = `#/reports/cron${qs ? "?" + qs : ""}`;
  }

  private submit(): void {
    this.updateHash();
    void this.run();
  }

  render(): TemplateResult {
    return html`
      <div class="form">
        <label>Job ID
          <input type="text" placeholder="nightly-vacuum" .value=${this.jobId}
            @change=${(e: Event) => { this.jobId = (e.target as HTMLInputElement).value; }} />
        </label>
        <label>Last N
          <input type="number" min="1" max="1000" .value=${this.last}
            @change=${(e: Event) => { this.last = (e.target as HTMLInputElement).value; }} />
        </label>
        <div class="actions">
          <button class="primary" ?disabled=${this.loading || !this.jobId}
            @click=${() => this.submit()}>
            ${this.loading ? "Loading…" : "Load"}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.rollup ? this.renderRollup(this.rollup) : html`<div class="meta">Enter a cron job-id to view its rollup.</div>`}
    `;
  }

  private renderRollup(r: CronRollup): TemplateResult {
    return html`
      <div class="meta">
        Job <strong>${r.jobId}</strong> · schedule ${fmtCronSchedule(r.manifest)}
        · generated ${r.generatedAt.replace(/\.\d+Z$/, "Z")}
        · ${r.rows.length} run${r.rows.length === 1 ? "" : "s"}
      </div>
      ${r.rows.length === 0
        ? html`<div class="empty">No executions of this job in the audit trail.</div>`
        : html`<table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Run / Session</th>
                <th class="right">Tools</th>
                <th class="right">LLM</th>
                <th class="right">Msgs</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              ${r.rows.map((row) => this.renderRow(row))}
            </tbody>
          </table>`}
      ${r.truncated
        ? html`<div class="truncated">Rollup truncated — older executions were elided. Raise <code>last</code> to include more.</div>`
        : ""}
    `;
  }

  private renderRow(row: CronRollupRow): TemplateResult {
    return html`
      <tr>
        <td>${fmtTimestamp(row.startedAt)}</td>
        <td>${fmtDuration(row.durationMs)}</td>
        <td><span class="status ${row.status}">${row.status}</span></td>
        <td>
          ${row.runId ? html`<span style="font-family: var(--mono)">${row.runId.slice(0, 12)}…</span><br>` : ""}
          ${row.sessionId
            ? html`<a href="#/reports/session/${encodeURIComponent(row.sessionId)}" style="font-family: var(--mono); font-size: 11px">${row.sessionId.slice(0, 12)}…</a>`
            : html`<span style="color: var(--fg-dim)">—</span>`}
        </td>
        <td class="right">${row.events.toolInvocations}</td>
        <td class="right">${row.events.llmCalls}</td>
        <td class="right">${row.events.messagesSent}</td>
        <td class="err-cell">${row.error ?? ""}</td>
      </tr>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "report-cron": ReportCron;
  }
}

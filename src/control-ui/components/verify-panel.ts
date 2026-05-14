import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { verifyRange, type VerifyResult } from "../api.ts";

function toDateTimeLocal(d: Date): string {
  // YYYY-MM-DDTHH:MM (no timezone) — what <input type="datetime-local"> expects
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

@customElement("verify-panel")
export class VerifyPanel extends LitElement {
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
    input[type="datetime-local"] {
      font-family: var(--mono);
      min-width: 220px;
    }
    .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .actions .hint { font-size: 12px; color: var(--fg-dim); }
    .result {
      padding: 16px 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .result.verified {
      border-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 12%, var(--bg-elev));
    }
    .result.pending {
      border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, var(--bg-elev));
    }
    .result.mismatch {
      border-color: var(--err);
      background: color-mix(in srgb, var(--err) 12%, var(--bg-elev));
    }
    .result h3 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 600;
    }
    .result.verified h3 { color: var(--ok); }
    .result.pending h3 { color: var(--warn); }
    .result.mismatch h3 { color: var(--err); }
    .result p { margin: 4px 0; font-size: 13px; }
    .row { display: grid; grid-template-columns: 140px 1fr; gap: 8px; font-size: 13px; margin: 2px 0; }
    .row .k { color: var(--fg-dim); }
    .row .v { font-family: var(--mono); word-break: break-all; }
    .err {
      color: var(--err);
      padding: 12px;
      border: 1px solid var(--err);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .help {
      margin-top: 16px;
      font-size: 12px;
      color: var(--fg-dim);
      line-height: 1.5;
    }
  `;

  @state() private from = "";
  @state() private to = "";
  @state() private running = false;
  @state() private result?: VerifyResult;
  @state() private error?: string;

  connectedCallback(): void {
    super.connectedCallback();
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this.from = toDateTimeLocal(dayAgo);
    this.to = toDateTimeLocal(now);
  }

  private updateField(key: "from" | "to", ev: Event) {
    const target = ev.target as HTMLInputElement;
    this[key] = target.value;
  }

  private async run() {
    if (!this.from || !this.to) {
      this.error = "both from and to are required";
      return;
    }
    this.running = true;
    this.error = undefined;
    this.result = undefined;
    try {
      // datetime-local has no timezone; treat as local, convert to ISO
      const fromIso = new Date(this.from).toISOString();
      const toIso = new Date(this.to).toISOString();
      this.result = await verifyRange(fromIso, toIso);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
  }

  private jumpToInterval(seqStart: number, seqEnd: number) {
    // Phase 1 event-table doesn't read query params yet, but plant the hash
    // anyway so a future enhancement / users sharing a link can use it.
    window.location.hash = `#/events?afterSeq=${seqStart - 1}&beforeSeq=${seqEnd + 1}`;
  }

  render() {
    return html`
      <div class="form">
        <label>From
          <input type="datetime-local" .value=${this.from}
                 @change=${(e: Event) => this.updateField("from", e)} />
        </label>
        <label>To
          <input type="datetime-local" .value=${this.to}
                 @change=${(e: Event) => this.updateField("to", e)} />
        </label>
        <div class="actions">
          <span class="hint">
            ${this.running ? "Recomputing SMT root…" : "Replays from genesis to the latest anchor"}
          </span>
          <button class="primary" ?disabled=${this.running} @click=${this.run}>
            ${this.running ? "Verifying…" : "Run verification"}
          </button>
        </div>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}
      ${this.result ? this.renderResult(this.result) : ""}

      <div class="help">
        Verification builds a fresh SMT from the audit_event table, compares each
        recomputed root against the smt_root stored in audit_checkpoint at every
        anchored boundary, and reports the first mismatch. Mismatches that fall
        within the selected window are flagged as <em>in window</em>.
      </div>
    `;
  }

  private renderResult(r: VerifyResult) {
    switch (r.status) {
      case "verified":
        return html`
          <div class="result verified">
            <h3>Verified</h3>
            <p>
              ${r.checkpointsChecked} checkpoint(s) recomputed and all roots match the
              Digital Evidence anchors.
            </p>
            <div class="row"><span class="k">last anchored seq</span><span class="v">${r.lastAnchoredSequence}</span></div>
            <div class="row"><span class="k">last anchored at</span><span class="v">${r.lastAnchoredCreatedAt}</span></div>
            <div class="row"><span class="k">duration</span><span class="v">${r.durationMs} ms</span></div>
          </div>`;
      case "anchor-pending":
        return html`
          <div class="result pending">
            <h3>Anchor pending</h3>
            <p>
              No Digital Evidence anchor covers the selected upper bound yet. Earlier
              anchored intervals (${r.checkpointsChecked} checked) verified cleanly.
            </p>
            <div class="row"><span class="k">last anchored seq</span><span class="v">${r.lastAnchoredSequence ?? "none"}</span></div>
            <div class="row"><span class="k">last anchored at</span><span class="v">${r.lastAnchoredCreatedAt ?? "—"}</span></div>
            <div class="row"><span class="k">duration</span><span class="v">${r.durationMs} ms</span></div>
          </div>`;
      case "mismatch-at-interval": {
        const m = r.mismatchAt;
        return html`
          <div class="result mismatch">
            <h3>Mismatch at interval</h3>
            <p>
              ${m.reason === "events-missing"
                ? html`Events are missing from the database; recomputation cannot proceed past this checkpoint.`
                : html`The recomputed SMT root for this interval does not match the anchored root — the event log has likely been modified.`}
              ${m.inWindow ? html`<strong> (inside the selected window)</strong>` : ""}
            </p>
            <div class="row"><span class="k">checkpoint id</span><span class="v">${m.checkpointId}</span></div>
            <div class="row"><span class="k">sequence range</span><span class="v">${m.sequenceStart}–${m.sequenceEnd}</span></div>
            <div class="row"><span class="k">anchored at</span><span class="v">${m.createdAt}</span></div>
            <div class="row"><span class="k">expected root</span><span class="v">${m.expectedRoot}</span></div>
            <div class="row"><span class="k">computed root</span><span class="v">${m.computedRoot}</span></div>
            <div class="row"><span class="k">duration</span><span class="v">${r.durationMs} ms</span></div>
            <p style="margin-top:12px">
              <button @click=${() => this.jumpToInterval(m.sequenceStart, m.sequenceEnd)}>
                Jump to interval in event log
              </button>
            </p>
          </div>`;
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "verify-panel": VerifyPanel;
  }
}

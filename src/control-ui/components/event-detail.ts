import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getEvent, verifyEvent, type ApiEvent, type EventVerifyPayload } from "../api.ts";

@customElement("event-detail")
export class EventDetail extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 50;
    }
    .panel {
      background: var(--bg-elev);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 10px;
      width: min(900px, 90vw);
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    header h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    header .seq { color: var(--fg-dim); font-family: var(--mono); }
    header button {
      margin-left: auto;
      background: transparent;
      border: 0;
      color: var(--fg-dim);
      font-size: 20px;
      cursor: pointer;
    }
    .body { padding: 16px 20px; overflow: auto; }
    .row { display: grid; grid-template-columns: 140px 1fr; gap: 8px; margin-bottom: 6px; font-size: 13px; }
    .row .k { color: var(--fg-dim); }
    .row .v { font-family: var(--mono); word-break: break-all; }
    pre {
      margin: 8px 0;
      padding: 12px;
      background: var(--bg-elev2);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow: auto;
    }
    h3 {
      margin: 16px 0 6px;
      font-size: 12px;
      color: var(--fg-dim);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .err { color: var(--err); }
    .dim { color: var(--fg-dim); }
    .verify {
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 6px;
    }
    .verify.valid {
      border-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 10%, var(--bg-elev));
    }
    .verify.invalid {
      border-color: var(--err);
      background: color-mix(in srgb, var(--err) 12%, var(--bg-elev));
    }
    .verify.unverifiable {
      border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, var(--bg-elev));
    }
    .verify h4 {
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 600;
    }
    .verify.valid h4 { color: var(--ok); }
    .verify.invalid h4 { color: var(--err); }
    .verify.unverifiable h4 { color: var(--warn); }
    .verify .row .v { font-size: 11px; }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .actions button {
      font-size: 12px;
      padding: 4px 10px;
    }
  `;

  @property({ type: String }) eventId = "";
  @state() private event?: ApiEvent;
  @state() private verify?: EventVerifyPayload;
  @state() private verifyError?: string;
  @state() private error?: string;
  @state() private loading = true;

  connectedCallback(): void {
    super.connectedCallback();
    this.load();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKey);
    super.disconnectedCallback();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  private close = () => {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  };

  private onBackdrop = (e: MouseEvent) => {
    if (e.target === this) this.close();
  };

  private async load() {
    if (!this.eventId) return;
    this.loading = true;
    this.error = undefined;
    this.verify = undefined;
    this.verifyError = undefined;
    try {
      const [eventRes, verifyRes] = await Promise.allSettled([
        getEvent(this.eventId),
        verifyEvent(this.eventId),
      ]);
      if (eventRes.status === "fulfilled") {
        this.event = eventRes.value.event;
      } else {
        this.error = eventRes.reason instanceof Error ? eventRes.reason.message : String(eventRes.reason);
      }
      if (verifyRes.status === "fulfilled") {
        this.verify = verifyRes.value;
      } else {
        this.verifyError = verifyRes.reason instanceof Error ? verifyRes.reason.message : String(verifyRes.reason);
      }
    } finally {
      this.loading = false;
    }
  }

  private downloadProof() {
    if (!this.verify?.proof) return;
    const blob = new Blob([JSON.stringify(this.verify.proof, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-proof-${this.eventId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private shortHash(h: string): string {
    return h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`;
  }

  private renderDeTxLink(deTxHash: string, deBaseUrl: string | null) {
    const short = this.shortHash(deTxHash);
    if (!deBaseUrl) return html`${short}`;
    const base = deBaseUrl.replace(/\/+$/, "");
    const url = `${base}/explorer/fingerprint/${encodeURIComponent(deTxHash)}`;
    return html`<a href=${url} target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none">${short}</a>`;
  }

  protected createRenderRoot() {
    const root = super.createRenderRoot();
    this.addEventListener("click", this.onBackdrop);
    return root;
  }

  render() {
    const ev = this.event;
    return html`
      <div class="panel" @click=${(e: MouseEvent) => e.stopPropagation()}>
        <header>
          <h2>${ev?.eventType ?? "Event"}</h2>
          <span class="seq">#${ev?.sequence ?? "..."}</span>
          <button @click=${this.close} aria-label="Close">×</button>
        </header>
        <div class="body">
          ${this.loading ? html`<div>Loading…</div>` : ""}
          ${this.error ? html`<div class="err">${this.error}</div>` : ""}
          ${ev ? this.renderEvent(ev) : ""}
        </div>
      </div>
    `;
  }

  private renderEvent(ev: ApiEvent) {
    return html`
      <div class="row"><span class="k">id</span><span class="v">${ev.id}</span></div>
      <div class="row"><span class="k">created at</span><span class="v">${ev.createdAt}</span></div>
      <div class="row"><span class="k">source</span><span class="v">${ev.source}</span></div>
      <div class="row"><span class="k">category</span><span class="v">${ev.category}</span></div>
      <div class="row"><span class="k">session</span><span class="v">${ev.sessionId
  ? html`<a href="#/reports/session/${encodeURIComponent(ev.sessionId)}" title="View session rollup">${ev.sessionId}</a>`
  : "—"}</span></div>
      <div class="row"><span class="k">description</span><span class="v">${ev.description}</span></div>

      <h3>Integrity</h3>
      ${this.renderVerify()}

      <h3>Metadata</h3>
      <pre>${JSON.stringify(ev.metadata, null, 2)}</pre>

      ${ev.content !== undefined
        ? html`<h3>Content</h3><pre>${ev.content}</pre>`
        : html`<h3>Content</h3><div style="color:var(--fg-dim)">(empty)</div>`}
    `;
  }

  private renderVerify() {
    if (this.verifyError) {
      return html`<div class="err">Could not verify: ${this.verifyError}</div>`;
    }
    const v = this.verify;
    if (!v) return html`<div class="dim">Loading verification…</div>`;

    const cls = v.verification.status; // "valid" | "invalid" | "unverifiable"
    const heading =
      cls === "valid" ? "✓ Untampered" :
      cls === "invalid" ? "⚠ Tampered or unknown" :
      "⏳ Unverifiable";
    const headingText =
      cls === "valid" ? "Event content hashes to a leaf in the SMT, and the proof verifies against a known root." :
      cls === "invalid" ? (v.verification.reason ?? "Proof verification failed.") :
      (v.verification.reason ?? "SMT root has no known counterpart yet — anchor still pending.");

    return html`
      <div class="verify ${cls}">
        <h4>${heading}</h4>
        <div style="font-size:13px;margin-bottom:8px">${headingText}</div>

        <div class="row"><span class="k">raw hash</span>
          <span class="v" title=${v.rawHash}>${this.shortHash(v.rawHash)}</span>
        </div>
        <div class="row"><span class="k">censored hash</span>
          <span class="v" title=${v.censoredHash}>${this.shortHash(v.censoredHash)}</span>
        </div>
        ${v.proof
          ? html`
            <div class="row"><span class="k">tree root</span>
              <span class="v" title=${v.proof.root}>${this.shortHash(v.proof.root)}</span>
            </div>
            <div class="row"><span class="k">proof siblings</span>
              <span class="v">${v.proof.siblings.length}</span>
            </div>`
          : ""}
        ${v.anchoredAt
          ? html`
            <div class="row"><span class="k">DE anchor</span>
              <span class="v" title=${v.anchoredAt.deTxHash}>
                ${this.renderDeTxLink(v.anchoredAt.deTxHash, v.deBaseUrl)}
              </span>
            </div>
            <div class="row"><span class="k">anchored at</span>
              <span class="v">${v.anchoredAt.createdAt}</span>
            </div>
            <div class="row"><span class="k">DE confirmation</span>
              ${v.anchoredAt.verifiedAt
                ? html`<span class="v" style="color: var(--ok)">✓ verified · ${v.anchoredAt.verifiedAt}</span>`
                : html`<span class="v" style="color: var(--warn)">⏳ pending — submitted to DE, awaiting on-chain confirmation</span>`}
            </div>`
          : html`
            <div class="row"><span class="k">DE anchor</span>
              <span class="v dim">pending — no checkpoint with a DE tx covers this sequence yet</span>
            </div>`}

        <div class="actions">
          ${v.proof
            ? html`<button @click=${this.downloadProof}>Download proof JSON</button>`
            : ""}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "event-detail": EventDetail;
  }
}

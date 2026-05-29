import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  smtCreateProof,
  smtVerifyProof,
  smtGetChain,
  type SmtProofObject,
  type SmtVerifyResult,
  type SmtChainEntry,
} from "../api.ts";

@customElement("smt-tools")
export class SmtTools extends LitElement {
  static styles = css`
    :host { display: block; }
    .panel {
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: 8px; padding: 16px; margin-bottom: 16px;
    }
    .panel h2 {
      margin: 0 0 4px; font-size: 14px;
    }
    .panel .help {
      color: var(--fg-dim); font-size: 12px; margin: 0 0 12px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
    label {
      display: flex; flex-direction: column; gap: 4px;
      font-size: 12px; color: var(--fg-dim);
    }
    input { font-family: var(--mono); min-width: 260px; }
    textarea {
      font-family: var(--mono); font-size: 12px; width: 100%; min-height: 140px;
      box-sizing: border-box;
    }
    pre {
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 6px; padding: 10px; overflow: auto;
      font-size: 11px; max-height: 320px;
    }
    .err { color: var(--err); margin-top: 8px; font-size: 13px; }
    .badge {
      display: inline-block; padding: 2px 10px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge.ok { color: var(--ok); border: 1px solid var(--ok); }
    .badge.err { color: var(--err); border: 1px solid var(--err); }
    .badge.warn { color: var(--warn); border: 1px solid var(--warn); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
    th {
      color: var(--fg-dim); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    }
    tr:last-child td { border-bottom: 0; }
    .mono { font-family: var(--mono); font-size: 11px; word-break: break-all; }
  `;

  // Proof generator
  @state() private proofHash = "";
  @state() private proofTree = "";
  @state() private proofResult?: SmtProofObject;
  @state() private proofError?: string;
  @state() private proofLoading = false;

  // Proof verifier
  @state() private verifyInput = "";
  @state() private verifyResult?: SmtVerifyResult;
  @state() private verifyError?: string;
  @state() private verifyLoading = false;

  // Chain viewer
  @state() private chainTree = "";
  @state() private chainConvId = "";
  @state() private chain?: SmtChainEntry[];
  @state() private chainError?: string;
  @state() private chainLoading = false;

  private async runProof(): Promise<void> {
    this.proofLoading = true;
    this.proofError = undefined;
    this.proofResult = undefined;
    try {
      const { proof } = await smtCreateProof(this.proofHash, this.proofTree || undefined);
      this.proofResult = proof;
    } catch (err) {
      this.proofError = err instanceof Error ? err.message : String(err);
    } finally {
      this.proofLoading = false;
    }
  }

  private async runVerify(): Promise<void> {
    this.verifyLoading = true;
    this.verifyError = undefined;
    this.verifyResult = undefined;
    try {
      const proof = JSON.parse(this.verifyInput) as SmtProofObject;
      this.verifyResult = await smtVerifyProof(proof);
    } catch (err) {
      this.verifyError = err instanceof Error ? err.message : String(err);
    } finally {
      this.verifyLoading = false;
    }
  }

  private async runChain(): Promise<void> {
    this.chainLoading = true;
    this.chainError = undefined;
    this.chain = undefined;
    try {
      const res = await smtGetChain(this.chainTree, this.chainConvId);
      this.chain = res.chain;
    } catch (err) {
      this.chainError = err instanceof Error ? err.message : String(err);
    } finally {
      this.chainLoading = false;
    }
  }

  render(): TemplateResult {
    return html`
      ${this.renderProofPanel()}
      ${this.renderVerifyPanel()}
      ${this.renderChainPanel()}
    `;
  }

  private renderProofPanel(): TemplateResult {
    return html`
      <div class="panel">
        <h2>Generate inclusion proof</h2>
        <p class="help">Equivalent to <code>audit smt proof &lt;hash&gt;</code>. The hash should be the SMT leaf hash you want to prove inclusion of.</p>
        <div class="row">
          <label>Hash <input type="text" placeholder="sha256 hex" .value=${this.proofHash}
            @change=${(e: Event) => { this.proofHash = (e.target as HTMLInputElement).value; }} /></label>
          <label>Tree (optional) <input type="text" placeholder="default" .value=${this.proofTree}
            @change=${(e: Event) => { this.proofTree = (e.target as HTMLInputElement).value; }} /></label>
          <button class="primary" ?disabled=${this.proofLoading || !this.proofHash}
            @click=${() => this.runProof()}>
            ${this.proofLoading ? "Generating…" : "Generate"}
          </button>
        </div>
        ${this.proofError ? html`<div class="err">${this.proofError}</div>` : ""}
        ${this.proofResult
          ? html`
              <div style="margin-top: 10px">
                ${this.proofResult.membership
                  ? html`<span class="badge ok">membership</span>`
                  : html`<span class="badge warn">non-membership</span>`}
              </div>
              <pre>${JSON.stringify(this.proofResult, null, 2)}</pre>
              <button @click=${() => navigator.clipboard.writeText(JSON.stringify(this.proofResult))}>
                Copy proof JSON
              </button>
            `
          : ""}
      </div>
    `;
  }

  private renderVerifyPanel(): TemplateResult {
    return html`
      <div class="panel">
        <h2>Verify proof</h2>
        <p class="help">Equivalent to <code>audit smt verify --proof &lt;json&gt;</code>. Paste a proof JSON and the server checks it against the in-process trees and DE-anchored checkpoint roots.</p>
        <textarea placeholder='{"root":"…","key":"…","siblings":[…],"membership":true,…}'
          .value=${this.verifyInput}
          @change=${(e: Event) => { this.verifyInput = (e.target as HTMLTextAreaElement).value; }}></textarea>
        <div style="margin-top: 8px">
          <button class="primary" ?disabled=${this.verifyLoading || !this.verifyInput}
            @click=${() => this.runVerify()}>
            ${this.verifyLoading ? "Verifying…" : "Verify"}
          </button>
        </div>
        ${this.verifyError ? html`<div class="err">${this.verifyError}</div>` : ""}
        ${this.verifyResult
          ? html`
              <div style="margin-top: 10px">
                ${this.verifyResult.status === "valid"
                  ? html`<span class="badge ok">valid</span>`
                  : this.verifyResult.status === "unverifiable"
                    ? html`<span class="badge warn">unverifiable</span> <span class="help">${this.verifyResult.reason}</span>`
                    : html`<span class="badge err">invalid</span> <span class="help">${this.verifyResult.reason}</span>`}
              </div>
            `
          : ""}
      </div>
    `;
  }

  private renderChainPanel(): TemplateResult {
    return html`
      <div class="panel">
        <h2>Conversation chain</h2>
        <p class="help">Equivalent to <code>audit smt chain &lt;conversationId&gt;</code>. Lists the chained leaves the SMT recorded for a conversation, in insertion order.</p>
        <div class="row">
          <label>Tree <input type="text" placeholder="default" .value=${this.chainTree}
            @change=${(e: Event) => { this.chainTree = (e.target as HTMLInputElement).value; }} /></label>
          <label>Conversation ID <input type="text" placeholder="sess-…" .value=${this.chainConvId}
            @change=${(e: Event) => { this.chainConvId = (e.target as HTMLInputElement).value; }} /></label>
          <button class="primary" ?disabled=${this.chainLoading || !this.chainTree || !this.chainConvId}
            @click=${() => this.runChain()}>
            ${this.chainLoading ? "Loading…" : "Load chain"}
          </button>
        </div>
        ${this.chainError ? html`<div class="err">${this.chainError}</div>` : ""}
        ${this.chain && this.chain.length === 0
          ? html`<div style="margin-top: 10px; color: var(--fg-dim); font-size: 13px">No chain entries found.</div>`
          : ""}
        ${this.chain && this.chain.length > 0
          ? html`
              <table>
                <thead>
                  <tr><th>Seq</th><th>Timestamp</th><th>Raw hash</th><th>Event ID</th></tr>
                </thead>
                <tbody>
                  ${this.chain.map((e) => html`<tr>
                    <td>#${e.seqNo}</td>
                    <td>${new Date(e.timestamp * 1000).toISOString().replace(/\.\d+Z$/, "Z")}</td>
                    <td class="mono">${e.rawHash.slice(0, 24)}…</td>
                    <td class="mono">${e.auditEventId}</td>
                  </tr>`)}
                </tbody>
              </table>
            `
          : ""}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "smt-tools": SmtTools;
  }
}

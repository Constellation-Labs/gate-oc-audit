import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listTrees, listCheckpoints, type TreeInfo, type CheckpointRecord } from "../api.ts";
import { fmtTimestamp, shortHash, explorerFingerprintUrl } from "../format.ts";

@customElement("trees-overview")
export class TreesOverview extends LitElement {
  static styles = css`
    :host { display: block; }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 8px;
    }
    section + section { margin-top: 24px; }
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
    .mono { font-family: var(--mono); }
    .dim { color: var(--fg-dim); }
    .hash {
      font-family: var(--mono);
      font-size: 12px;
      word-break: break-all;
    }
    .hash a {
      color: var(--accent);
      text-decoration: none;
    }
    .hash a:hover { text-decoration: underline; }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--fg-dim);
      border: 1px dashed var(--border);
      border-radius: 8px;
    }
    .err {
      color: var(--err);
      padding: 12px;
      border: 1px solid var(--err);
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .toolbar .status { color: var(--fg-dim); font-size: 13px; margin-left: auto; }
  `;

  @state() private trees: TreeInfo[] = [];
  @state() private checkpoints: CheckpointRecord[] = [];
  @state() private deBaseUrl: string | null = null;
  @state() private loading = false;
  @state() private error?: string;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.error = undefined;
    try {
      const [t, c] = await Promise.all([listTrees(), listCheckpoints()]);
      this.trees = t.trees;
      this.checkpoints = c.checkpoints
        .slice()
        .sort((a, b) => b.sequenceEnd - a.sequenceEnd);
      this.deBaseUrl = c.deBaseUrl;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  private renderDeTx(deTxHash: string | null) {
    if (!deTxHash) return html`<span class="dim">pending</span>`;
    const url = explorerFingerprintUrl(deTxHash, this.deBaseUrl);
    const short = shortHash(deTxHash);
    return url
      ? html`<a href=${url} target="_blank" rel="noopener noreferrer">${short}</a>`
      : html`${short}`;
  }

  render() {
    return html`
      <div class="toolbar">
        <button @click=${() => this.load()} ?disabled=${this.loading}>
          ${this.loading ? "Refreshing…" : "Refresh"}
        </button>
        <span class="status">
          ${this.trees.length} tree(s), ${this.checkpoints.length} checkpoint(s)
        </span>
      </div>

      ${this.error ? html`<div class="err">${this.error}</div>` : ""}

      <section>
        <h2>SMT trees</h2>
        ${this.trees.length === 0
          ? html`<div class="empty">No SMT trees — events may not have been committed yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Root</th>
                    <th>Entries</th>
                    <th>Nodes</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.trees.map((t) => html`
                    <tr>
                      <td class="mono">${t.key}</td>
                      <td class="hash" title=${t.root}>${shortHash(t.root)}</td>
                      <td class="mono">${t.entryCount}</td>
                      <td class="mono">${t.size}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `}
      </section>

      <section>
        <h2>DE checkpoints</h2>
        ${this.checkpoints.length === 0
          ? html`<div class="empty">No checkpoints yet — DE anchoring may not be configured or no events have crossed the threshold.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Sequence</th>
                    <th>Events</th>
                    <th>SMT root</th>
                    <th>DE tx</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.checkpoints.map((cp) => html`
                    <tr>
                      <td class="mono">${cp.id}</td>
                      <td class="mono">${cp.sequenceStart}–${cp.sequenceEnd}</td>
                      <td class="mono">${cp.eventCount}</td>
                      <td class="hash" title=${cp.smtRoot}>${shortHash(cp.smtRoot)}</td>
                      <td class="hash" title=${cp.deTxHash ?? ""}>
                        ${this.renderDeTx(cp.deTxHash)}
                      </td>
                      <td class="mono">${fmtTimestamp(cp.createdAt)}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "trees-overview": TreesOverview;
  }
}

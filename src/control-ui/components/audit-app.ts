import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./event-table.ts";
import "./trees-overview.ts";
import "./verify-panel.ts";
import "./status-dashboard.ts";
import "./report-projection.ts";
import "./report-cron.ts";
import "./session-view.ts";
import "./anomalies-view.ts";
import "./spend-view.ts";
import "./inventory-view.ts";
import "./smt-tools.ts";

type Route =
  | "status"
  | "events"
  | "trees"
  | "verify"
  | "reports/daily"
  | "reports/weekly"
  | "reports/cron"
  | "reports/session"
  | "anomalies"
  | "spend"
  | "inventory"
  | "smt-tools";

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (hash.startsWith("reports/session/")) return "reports/session";
  if (
    hash === "events"
    || hash === "trees"
    || hash === "verify"
    || hash === "status"
    || hash === "reports/daily"
    || hash === "reports/weekly"
    || hash === "reports/cron"
    || hash === "anomalies"
    || hash === "spend"
    || hash === "inventory"
    || hash === "smt-tools"
  ) {
    return hash;
  }
  return "status";
}

@customElement("audit-app")
export class AuditApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-elev);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    nav {
      display: flex;
      gap: 4px;
      margin-left: auto;
      align-items: center;
    }
    nav a {
      color: var(--fg-dim);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
    }
    nav a.active {
      color: var(--fg);
      background: var(--bg-elev2);
    }
    nav a:hover { color: var(--fg); }
    nav details {
      position: relative;
    }
    nav details > summary {
      list-style: none;
      cursor: pointer;
      color: var(--fg-dim);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      user-select: none;
    }
    nav details > summary::-webkit-details-marker { display: none; }
    nav details > summary:hover { color: var(--fg); }
    nav details > summary.active {
      color: var(--fg);
      background: var(--bg-elev2);
    }
    nav details[open] > summary {
      color: var(--fg);
    }
    nav .menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      min-width: 180px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
      z-index: 11;
    }
    nav .menu a {
      white-space: nowrap;
    }
    main {
      padding: 24px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .stub {
      padding: 48px 24px;
      text-align: center;
      color: var(--fg-dim);
      border: 1px dashed var(--border);
      border-radius: 8px;
    }
  `;

  @state() private route: Route = parseRoute();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHashChange);
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHashChange);
    super.disconnectedCallback();
  }

  private onHashChange = (): void => {
    this.route = parseRoute();
  };

  private onNavClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== "A") return;
    this.renderRoot.querySelectorAll("nav details[open]").forEach((d) => {
      (d as HTMLDetailsElement).open = false;
    });
  };

  private integrityActive(): boolean {
    return this.route === "trees" || this.route === "verify" || this.route === "smt-tools";
  }

  render() {
    return html`
      <header>
        <h1>Audit Trail</h1>
        <nav @click=${this.onNavClick}>
          <a href="#/status" class=${this.route === "status" ? "active" : ""}>Status</a>
          <a href="#/events" class=${this.route === "events" ? "active" : ""}>Events</a>
          <details>
            <summary class=${this.route.startsWith("reports/") ? "active" : ""}>Reports ▾</summary>
            <div class="menu">
              <a href="#/reports/daily" class=${this.route === "reports/daily" ? "active" : ""}>Daily</a>
              <a href="#/reports/weekly" class=${this.route === "reports/weekly" ? "active" : ""}>Weekly</a>
              <a href="#/reports/cron" class=${this.route === "reports/cron" ? "active" : ""}>Cron</a>
            </div>
          </details>
          <a href="#/anomalies" class=${this.route === "anomalies" ? "active" : ""}>Anomalies</a>
          <a href="#/spend" class=${this.route === "spend" ? "active" : ""}>Spend</a>
          <a href="#/inventory" class=${this.route === "inventory" ? "active" : ""}>Inventory</a>
          <details>
            <summary class=${this.integrityActive() ? "active" : ""}>Integrity ▾</summary>
            <div class="menu">
              <a href="#/trees" class=${this.route === "trees" ? "active" : ""}>Trees & checkpoints</a>
              <a href="#/verify" class=${this.route === "verify" ? "active" : ""}>Verify</a>
              <a href="#/smt-tools" class=${this.route === "smt-tools" ? "active" : ""}>SMT tools</a>
            </div>
          </details>
        </nav>
      </header>
      <main>
        ${this.route === "status"
          ? html`<status-dashboard></status-dashboard>`
          : this.route === "events"
            ? html`<event-table></event-table>`
            : this.route === "reports/daily"
              ? html`<report-projection kind="daily"></report-projection>`
              : this.route === "reports/weekly"
                ? html`<report-projection kind="weekly"></report-projection>`
                : this.route === "reports/cron"
                  ? html`<report-cron></report-cron>`
                  : this.route === "reports/session"
                    ? html`<session-view></session-view>`
                    : this.route === "anomalies"
                      ? html`<anomalies-view></anomalies-view>`
                      : this.route === "spend"
                        ? html`<spend-view></spend-view>`
                        : this.route === "inventory"
                          ? html`<inventory-view></inventory-view>`
                          : this.route === "trees"
                            ? html`<trees-overview></trees-overview>`
                            : this.route === "smt-tools"
                              ? html`<smt-tools></smt-tools>`
                              : html`<verify-panel></verify-panel>`}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "audit-app": AuditApp;
  }
}

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./event-table.ts";
import "./trees-overview.ts";
import "./verify-panel.ts";

type Route = "events" | "trees" | "verify";

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (hash === "trees" || hash === "verify") return hash;
  return "events";
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

  render() {
    return html`
      <header>
        <h1>Audit Trail</h1>
        <nav>
          <a href="#/events" class=${this.route === "events" ? "active" : ""}>Events</a>
          <a href="#/trees" class=${this.route === "trees" ? "active" : ""}>Trees & checkpoints</a>
          <a href="#/verify" class=${this.route === "verify" ? "active" : ""}>Verify</a>
        </nav>
      </header>
      <main>
        ${this.route === "events"
          ? html`<event-table></event-table>`
          : this.route === "trees"
            ? html`<trees-overview></trees-overview>`
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

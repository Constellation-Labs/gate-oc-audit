import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface FiltersValue {
  type: string;
  category: string;
  session: string;
}

@customElement("event-filters")
export class EventFilters extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    label {
      font-size: 12px;
      color: var(--fg-dim);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    input {
      width: 160px;
    }
    button { font-size: 12px; }
  `;

  @property({ type: Object }) value: FiltersValue = { type: "", category: "", session: "" };

  private emit(next: FiltersValue) {
    this.dispatchEvent(new CustomEvent("filters-change", { detail: next, bubbles: true, composed: true }));
  }

  private update(key: keyof FiltersValue, ev: Event) {
    const target = ev.target as HTMLInputElement;
    this.emit({ ...this.value, [key]: target.value });
  }

  private clear() {
    this.emit({ type: "", category: "", session: "" });
  }

  render() {
    return html`
      <label>type
        <input
          placeholder="e.g. prompt.response"
          .value=${this.value.type}
          @change=${(e: Event) => this.update("type", e)}
        />
      </label>
      <label>category
        <input
          placeholder="e.g. tool"
          .value=${this.value.category}
          @change=${(e: Event) => this.update("category", e)}
        />
      </label>
      <label>session
        <input
          placeholder="session id"
          .value=${this.value.session}
          @change=${(e: Event) => this.update("session", e)}
        />
      </label>
      <button @click=${this.clear}>Clear</button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "event-filters": EventFilters;
  }
}

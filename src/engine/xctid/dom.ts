// Minimal structural DOM shapes the transaction-id generator touches. We don't
// pull in the full TS "DOM" lib (this is a Node tool); linkedom's document is
// structurally compatible with these.

export interface XElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): XElement | null;
  querySelectorAll(selector: string): ArrayLike<XElement>;
  readonly children: ArrayLike<XElement>;
  readonly textContent: string | null;
  readonly outerHTML: string;
}

export interface XDocument {
  querySelector(selector: string): XElement | null;
  querySelectorAll(selector: string): ArrayLike<XElement>;
  readonly documentElement: XElement;
}

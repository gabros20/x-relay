// x-client-transaction-id generator — public surface.
// Vendored + ported from Lqm1/x-client-transaction-id (MIT). See docs/ENGINE-RESEARCH.md §3.
export { ClientTransaction, assembleTransactionId, default } from './transaction.ts';
export { handleXMigration } from './utils.ts';
export type { XDocument, XElement } from './dom.ts';
export * from './errors.ts';

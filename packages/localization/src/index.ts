/**
 * @aytracker/localization — locales, message catalogs, translation and formatting.
 *
 * Business logic never imports this to build a sentence. Services raise machine-readable error
 * codes; the presentation layer turns codes into words here.
 */

export * from './locales.js';
export * from './translator.js';
export * from './formatting.js';
export {
  CATALOGS,
  REFERENCE_CATALOG,
  ALL_MESSAGE_KEYS,
  COMPLETE_LOCALES,
  catalogCoverage,
  type CatalogCoverage,
  type MessageCatalog,
  type MessageKey,
} from './messages/index.js';

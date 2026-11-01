// Public interface of the offers module. Other modules import only this file or `contracts/*`.
export {
  archivePractice,
  createPractice,
  getPractice,
  listPractices,
  listPracticeViews,
  practiceViews,
  resolvePractice,
  updatePractice,
  type Practice,
  type PracticeInput,
  type PracticeView,
} from './services/practices';
export {
  approveOffer,
  archiveOffer,
  createOffer,
  getOffer,
  listOffers,
  unapproveOffer,
  updateOffer,
  withLabel,
  withLabels,
  type Offer,
  type OfferInput,
  type OfferPatch,
  type OfferView,
} from './services/offers';
export { deleteOffer, offerCanDelete } from './services/delete';
export { offerStats, type OfferStat } from './services/stats';
export { registerOfferUsage, type OfferCounts, type OfferUsage } from './contracts/ports';
export { PRICE_MODELS, offerStatusLabel, priceLabel, type PriceModel } from './domain/price';
export {
  archiveCaseStudy,
  createCaseStudy,
  linkCaseStudy,
  listCaseStudies,
  matchCaseStudies,
  unlinkCaseStudy,
  updateCaseStudy,
  type CaseStudy,
  type CaseStudyInput,
} from './services/case-studies';
export {
  BUYER_DEFINITION_FIELDS,
  BUYER_DEFINITION_WARNING,
  affectsMatching,
  approvalProblems,
} from './domain/approval';
export { TAAZAA_OFFERS, TAAZAA_PRACTICES, seedOffers } from './defaults';
export {
  DEFAULT_SIGNAL_RULES,
  GENERIC_SIGNAL_RULES,
  SIGNAL_TYPE_KEYS,
  signalRuleProblems,
  type SignalRuleInput,
} from './domain/signal-rules';
export {
  listApprovedOffers,
  listSignalRules,
  replaceSignalRules,
  resetSignalRules,
  seedMissingSignalRules,
  type ApprovedOffer,
  type SignalRule,
} from './services/signal-rules';

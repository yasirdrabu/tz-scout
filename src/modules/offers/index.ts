// Public interface of the offers module. Other modules import only this file or `contracts/*`.
export {
  archivePractice,
  createPractice,
  listPractices,
  resolvePractice,
  updatePractice,
  type Practice,
  type PracticeInput,
} from './services/practices';
export {
  approveOffer,
  archiveOffer,
  createOffer,
  getOffer,
  listOffers,
  updateOffer,
  type Offer,
  type OfferInput,
  type OfferPatch,
} from './services/offers';
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

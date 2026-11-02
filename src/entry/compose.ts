// Composition root for ports. Lower modules define interfaces; this file registers the higher
// modules' implementations. The web app (v1-route) and every background role
// (through registry.ts) import it, so all processes see the same implementations.
import { registerMergeGuard, registerSourceAccessProvider, registerSourceInfoProvider } from '@/modules/accounts';
import { intakeSourceAccess, intakeSourceInfo, intakeSourceValidator, registerFunnelStages, registerReviewStatusValidator } from '@/modules/intake';
import { registerOfferUsage } from '@/modules/offers';
import { registerOwnershipPreflight, routingFunnelStages, routingOfferUsage, routingReviewStatusValidator } from '@/modules/routing';
import { scoringOfferUsage } from '@/modules/scoring';
import { crmMergeGuard, crmOwnershipPreflight, registerHandoffPackageProvider, registerHubspotAdapter } from '@/modules/crm';
import { playbooksHandoffPackage } from '@/modules/playbooks';
import { registerSourceValidator } from '@/modules/tenancy';

registerSourceValidator(intakeSourceValidator);
registerSourceInfoProvider(intakeSourceInfo);
registerSourceAccessProvider(intakeSourceAccess);
registerReviewStatusValidator(routingReviewStatusValidator);
registerFunnelStages(routingFunnelStages);
registerHubspotAdapter();
registerOwnershipPreflight(crmOwnershipPreflight);
registerMergeGuard(crmMergeGuard);
registerHandoffPackageProvider(playbooksHandoffPackage);
registerOfferUsage(scoringOfferUsage, routingOfferUsage);

// Composition root for ports. Lower modules define interfaces; this file registers the higher
// modules' implementations. The web app (v1-route, page-context) and every background role
// (through registry.ts) import it, so all processes see the same implementations.
import { registerSourceAccessProvider, registerSourceInfoProvider } from '@/modules/accounts';
import { intakeSourceAccess, intakeSourceInfo, intakeSourceValidator } from '@/modules/intake';
import { registerSourceValidator } from '@/modules/tenancy';

registerSourceValidator(intakeSourceValidator);
registerSourceInfoProvider(intakeSourceInfo);
registerSourceAccessProvider(intakeSourceAccess);

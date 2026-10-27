// Composition root for event and job definitions. Every process role (relay, worker, scheduler)
// imports this file so `eventDef` and `jobDef` see the same definitions. Each new module adds
// the files that call defineEvent or defineJob here.
import '@/platform/dead-jobs';
import '@/platform/diagnostics';
import '@/modules/tenancy/contracts/events';
import '@/modules/integrations/contracts/events';
import '@/modules/integrations';
import '@/modules/ai-tasks/contracts/events';
import '@/modules/ai-tasks';
import '@/modules/offers/contracts/events';
import '@/modules/accounts/contracts/events';
import '@/modules/accounts';
import './compose';

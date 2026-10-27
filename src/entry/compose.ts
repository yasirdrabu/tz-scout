// Composition root for ports. Lower modules define interfaces; this file registers the higher
// modules' implementations. The web app (v1-route, page-context) and every background role
// (through registry.ts) import it, so all processes see the same implementations.
// Nothing to register yet: intake adds its providers here.
export {};

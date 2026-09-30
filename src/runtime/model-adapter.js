// Model access through DSH's pi-ai adapter. Profiles and credentials come from the
// app: there is no process environment, implicit account discovery, or key in the bundle.
// OAuth credential storage is not provided yet; API-key providers work without it.
const NO_OAUTH = {
  credentials: {read: async () => undefined, list: async () => [], modify: async () => { throw Error('OAuth credentials are not supported'); }, delete: async () => { throw Error('OAuth credentials are not supported'); }},
  authContext: {env: async () => undefined, fileExists: async () => false},
};
export function createModelAdapter(core, {providers, resolveApiKey, auth = NO_OAUTH, attachments}) {
  if (typeof resolveApiKey !== 'function') throw Error('resolveApiKey(provider, profile) is required');
  let profiles = core.resolveProfiles(structuredClone(providers));
  const validate = next => {
    for (const profile of next.values()) if (profile.baseURL && new URL(profile.baseURL).protocol !== 'https:') throw Error('Model endpoint must use HTTPS');
    return next;
  };
  validate(profiles);
  return {
    adapter: new core.PiAiAdapter({profiles: () => profiles, resolveApiKey, auth, resolveAttachments: () => attachments}),
    replaceProfiles(next) { const previous = profiles; profiles = validate(core.resolveProfiles(structuredClone(next))); return () => { profiles = previous; }; },
  };
}

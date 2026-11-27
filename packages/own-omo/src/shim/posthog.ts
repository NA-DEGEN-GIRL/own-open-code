// own's stand-in for omo's `shared/posthog.ts` inside the omo runtime bundle (script/resolve.ts): omo's telemetry is
// off in own (own/vendor/oh-my-opencode/MODIFICATIONS.md), so the plugin-load event is never recorded and no PostHog
// client, key or host is in the bundle.
export function recordPluginTelemetry(_input: { readonly configEnabled?: boolean }) {}

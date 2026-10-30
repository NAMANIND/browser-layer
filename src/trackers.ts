// Requests that carry no data for the agent: analytics, ads and telemetry. `net --all` still lists them.
// Beacons and 204 No Content responses are recognized by protocol (see daemon.ts); this is the data for
// the rest, matched on host suffix or on a whole path segment.
export const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'ogads-pa.clients6.google.com', 'facebook.net', 'connect.facebook.net', 'analytics.twitter.com',
  'bat.bing.com', 'clarity.ms', 'hotjar.com', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'fullstory.com', 'sentry.io', 'newrelic.com', 'nr-data.net', 'datadoghq.com', 'scorecardresearch.com', 'quantserve.com',
]
export const TRACKER_PATHS = ['log', 'logs', 'collect', 'analytics', 'telemetry', 'metrics', 'beacon', 'pixel', 'gen_204', 'ping']

export function isTracker(url: string): boolean {
  const u = new URL(url)
  return TRACKER_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))
    || u.pathname.split('/').some(seg => TRACKER_PATHS.includes(seg))
}

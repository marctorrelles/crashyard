# Test fixtures

Events and envelopes as real SDKs sent them, for the unit tests. Most come from GlitchTip's test data
(https://gitlab.com/glitchtip/glitchtip-backend), under the MIT license in [LICENSE-glitchtip](LICENSE-glitchtip):

- `events/*.json`: from `events/test_data/` (`incoming_events/`, `ios_event/event.json` as `ios-crash.json`,
  `ios_error_factory.json` as `ios-error.json`) and `apps/event_ingest/tests/test_data/envelopes/js_angular_message.json`.
- `envelopes/*.envelope`: from `apps/event_ingest/tests/parity_fixtures/`.

- `sentry-grouping/`: Sentry's grouping test events and what Sentry groups each by, from getsentry/sentry 24.10.0
  (`tests/sentry/grouping/grouping_inputs` and its `newstyle@2023_01_11` variant snapshots), Apache-2.0 since
  2026-10-15 under its FSL-1.1-Apache-2.0 license, copyright Functional Software, Inc. dba Sentry. Made by
  `scripts/sentry-grouping-fixtures.mjs`.
- `hangs/*.json`: app hangs sentry-cocoa sent from an iPhone and a Mac app to crashyard in November 2026, frames
  only, the app's name changed and its install path zeroed.

Add new ones from a real SDK where you can, and say here which SDK and version sent them.

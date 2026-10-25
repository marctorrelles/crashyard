# Test fixtures

Events and envelopes as real SDKs sent them, for the unit tests. Most come from GlitchTip's test data
(https://gitlab.com/glitchtip/glitchtip-backend, MIT licence, Copyright (c) 2019 GlitchTip):

- `events/*.json`: from `events/test_data/` (`incoming_events/`, `ios_event/event.json` as `ios-crash.json`,
  `ios_error_factory.json` as `ios-error.json`) and `apps/event_ingest/tests/test_data/envelopes/js_angular_message.json`.
- `envelopes/*.envelope`: from `apps/event_ingest/tests/parity_fixtures/`.

Add new ones from a real SDK where you can, and say here which SDK and version sent them.

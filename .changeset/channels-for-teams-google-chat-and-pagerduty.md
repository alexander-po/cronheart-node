---
'cronheart': minor
---

**`api.channels.create` now takes the three channel kinds the service added:
`teams`, `google_chat` and `pagerduty`.** A Microsoft Teams or Google Chat
channel takes the `webhookUrl` of its incoming webhook, the way Slack and
Discord do. A PagerDuty channel takes a new field, `routingKey`, the 32-character
Events API v2 integration key of a service. A request missing the field its kind
needs is refused here, naming it, before it is sent. The host and the
shape of the value are left to the service, which refuses a wrong one with
a validation error that names the field.

Reading never needed this: a channel of a kind the package has not seen has
always been read and handed back as it is, so an account that already holds
one of these three has listed and fetched as before. The service redacts a routing key
in its responses, as it does a webhook address, so it can never be read back.

The wire contract moves up a minor version to state the three kinds, the field
each takes and the shape of a routing key.

---
'cronheart': minor
---

`account.get()` now carries `channels`, the account's channel count and limit and its webhook and Teams count and limit, when the service reports them; it is left out when it does not. A 403 from the API now also names the token scoped to one project as a cause on a channel write.

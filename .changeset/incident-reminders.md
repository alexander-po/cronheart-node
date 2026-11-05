---
'cronheart': minor
---

A monitor can send a reminder alert every 24 hours while an incident stays open, at most three times. `monitors.create` and `monitors.update` take `incidentReminders`, and an update that leaves it out keeps the current value. A monitor read back carries `incidentReminders`, and an alert can now be of kind `'reminder'`. `defineMonitors` and `cronheart sync` manage `incidentReminders` when a monitor states it.
